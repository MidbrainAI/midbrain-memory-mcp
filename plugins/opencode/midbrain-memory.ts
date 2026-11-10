/**
 * MidBrain Memory OpenCode Plugin
 *
 * Episodic auto-capture: every user + assistant message stored automatically.
 * PK injection: disabled by default in v0.4.3. When explicitly opted in,
 * relevant procedural knowledge entries are searched and prepended to the
 * message as a context block before the LLM sees it. 2s hard timeout — on
 * failure the message passes through unchanged.
 * memory_search lives in the MCP server (index.js), not here.
 *
 * Architecture:
 * - User messages: captured via chat.message hook (fires once, has parts inline)
 * - Assistant messages: captured via message.updated event (fires when message
 *   completes, then one session.message() call to get text parts)
 *
 * Safety:
 * - Exactly 1 API POST per message (no backlog dumps, no history scans)
 * - Directory-based instance filtering (only matching instance processes)
 * - Fire-and-forget: never blocks chat on API response
 * - Persona and profile go into the system prompt once per session
 *   (experimental.chat.system.transform), read once and cached, so the
 *   system text stays byte-stable across the session's requests (#61)
 * - Opt-in PK injection: silent fallthrough on any error or timeout
 */

// @ts-ignore — resolved via dev shim or bundled midbrain-shared.mjs at install time
import { MidbrainApi, makeLogger, logFile, homeRelativePath, buildCaptureMetadata, getClient, extractInjectedPkIds, formatPkContext, isPkInjectionEnabled, stripInjectedContext, scrubInjectedPkContext,
  hookProjectDir, logProjectFallback, loadIdentityContext,
} from "./midbrain-shared.mjs";

const OPENCODE_HISTORY_TIMEOUT_MS = 500;

type OpenCodePart = { type: string; text?: string };
type OpenCodeMessage = { parts?: OpenCodePart[] };

// Only the portions of each host contract this plugin consumes. Keeping these
// structural avoids a runtime SDK dependency in the copied standalone plugin.
interface CaptureClient {
  session: {
    messages(input: { path: { id: string } }): Promise<unknown>;
    message(input: { path: { id: string; messageID: string } }): Promise<{ data?: OpenCodeMessage }>;
  };
}

interface CaptureEvent {
  type: string;
  properties?: { info?: {
    role: string; id: string; sessionID: string;
    time?: { completed?: number }; path?: { cwd?: string };
  } };
}

interface CaptureHooks {
  "experimental.chat.system.transform"?: (input: { sessionID?: string }, output: { system: string[] }) => Promise<void>;
  "chat.message"?: (input: { sessionID?: string }, output: { message: Record<string, unknown>; parts: OpenCodePart[] }) => Promise<void>;
  event?: (input: { event: CaptureEvent }) => Promise<void>;
}

interface V2Message {
  id: string;
  content?: OpenCodePart[];
  text?: string;
}

interface V2Attachment {
  mention?: unknown;
}

interface V2Hooks {
  prompt: {
    sessionID: string; messageID: string;
    prompt: { text: string; files?: V2Attachment[]; agents?: V2Attachment[]; skills?: V2Attachment[] };
  };
  context: { sessionID: string; system: OpenCodePart[] };
}

type V2StepType = "session.step.ended" | "session.step.failed";
interface V2StepEvent {
  type: V2StepType;
  created: number;
  location?: { directory: string };
  data: { sessionID: string; assistantMessageID: string };
}

interface V2Context {
  location: { directory: string };
  session: {
    context(input: { sessionID: string }): Promise<readonly V2Message[]>;
    hook<K extends keyof V2Hooks>(name: K, callback: (event: V2Hooks[K]) => Promise<void>): Promise<unknown>;
  };
  event: {
    subscribe(options: { types: V2StepType[]; signal: AbortSignal }): AsyncIterable<V2StepEvent>;
  };
}

function normalizeHistoryMessages(history: unknown): OpenCodeMessage[] {
  if (Array.isArray(history)) return history as OpenCodeMessage[];
  const data = (history as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data as OpenCodeMessage[] : [];
}

function textPartsFromMessages(messages: OpenCodeMessage[]): string[] {
  return messages.flatMap((m) =>
    (m.parts ?? [])
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
  );
}

async function fetchPriorMessageTexts(
  client: { session: { messages: (args: { path: { id: string } }) => Promise<unknown> } },
  sessionID: string,
  timeoutMs = OPENCODE_HISTORY_TIMEOUT_MS,
): Promise<string[]> {
  try {
    const history = await withTimeout(
      client.session.messages({ path: { id: sessionID } }),
      timeoutMs,
    );
    return textPartsFromMessages(normalizeHistoryMessages(history));
  } catch {
    return [];
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("OpenCode history fetch timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- Plugin ---

export const MidBrainMemoryPlugin = async ({ client, directory }: { client: CaptureClient; directory: string }): Promise<CaptureHooks> => {
  const log = makeLogger(logFile("midbrain-opencode.log"));

  let api: InstanceType<typeof MidbrainApi>;
  try {
    api = await MidbrainApi.create(getClient("opencode"), hookProjectDir(directory));
    log.info(
      `INIT: dir=${homeRelativePath(directory)} credential_scope=${api.keyScope} ` +
      `host=${api.effectiveApiBase} host_scope=${api.apiBaseScope}`,
    );
    logProjectFallback(api, log);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`INIT ERROR: ${msg}`);
    console.error(`[midbrain-memory] ${msg}`);
    return {};
  }

  const storedMessages = new Set<string>();

  // Persona/profile per session, read once (#61). Reusing the first read keeps
  // the system text identical on every request, so the prompt cache holds and
  // a later profile edit applies from the next session. Bounded for a
  // long-running OpenCode server.
  const identityBySession = new Map<string, Promise<string>>();
  const IDENTITY_SESSION_CACHE_MAX = 200;
  function sessionIdentity(sessionID: string): Promise<string> {
    let cached = identityBySession.get(sessionID);
    if (!cached) {
      cached = loadIdentityContext(api).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`IDENTITY ERROR: ${msg}`);
        return "";
      });
      // Keep only a non-empty result: a blank or failed read adds no system
      // text, so the next request retries it without changing the prompt.
      cached.then((text: string) => { if (!text) identityBySession.delete(sessionID); });
      identityBySession.set(sessionID, cached);
      if (identityBySession.size > IDENTITY_SESSION_CACHE_MAX) {
        const oldest = identityBySession.keys().next().value;
        if (oldest !== undefined) identityBySession.delete(oldest);
      }
    }
    return cached;
  }

  return {
    // --- Persona and profile: once per session, in the system prompt ---
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = (input as Record<string, unknown>).sessionID;
      if (typeof sessionID !== "string" || !sessionID) return;
      const identity = await sessionIdentity(sessionID);
      if (identity) output.system.push(identity);
    },

    // --- User messages: captured directly from hook (parts are inline) ---
    "chat.message": async (input, output) => {
      const msg = output.message as Record<string, unknown>;
      const messageID = msg.id as string;
      const parts = output.parts as Array<{ type: string; text?: string }>;

      const text = parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .trim();

      if (!text) return;

      const sessionID = (input as Record<string, unknown>).sessionID as string | undefined;

      log.info(`USER: id=${messageID} len=${text.length}`);
      storedMessages.add(messageID);
      api.storeEpisodic(text, "user", log, buildCaptureMetadata({ client: "opencode", cwd: directory, sessionId: sessionID }));

      if (!isPkInjectionEnabled()) return;

      // Opt-in legacy PK injection: search and prepend relevant procedural context.
      try {
        let excludeIds: number[] = [];

        if (sessionID) {
          const priorTexts = await fetchPriorMessageTexts(client, sessionID);
          excludeIds = extractInjectedPkIds(priorTexts);
        }

        const entries = await api.searchProcedural({ query: text, excludeIds });
        if (entries.length > 0) {
          const ctxBlock = formatPkContext(entries);
          // Strip any stale block from the first text part, then prepend fresh block
          const firstTextIdx = parts.findIndex(
            (p: { type: string }) => p.type === "text"
          );
          if (firstTextIdx !== -1) {
            const stripped = stripInjectedContext(parts[firstTextIdx].text ?? "");
            parts[firstTextIdx] = { ...parts[firstTextIdx], text: ctxBlock + "\n\n" + stripped };
          } else {
            parts.unshift({ type: "text", text: ctxBlock });
          }
          log.debug(`PK: injected ${entries.length} entries ids=${entries.map((e: { id: number }) => e.id).join(",")}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`PK INJECT ERROR: ${msg}`);
      }
    },

    // --- Assistant messages: captured when message.updated shows completion ---
    event: async ({ event }) => {
      if (event.type !== "message.updated") return;

      const info = (event as any).properties?.info;
      if (!info) return;
      if (info.role !== "assistant") return;
      if (!info.time?.completed) return; // Still streaming, not done yet

      const msgID = info.id as string;
      if (storedMessages.has(msgID)) return;

      // Directory filter: only the matching plugin instance handles this
      const msgDir = info.path?.cwd as string | undefined;
      if (msgDir && msgDir !== directory) return;

      // Mark as seen immediately to prevent other events from re-processing
      storedMessages.add(msgID);

      const sessionID = info.sessionID as string;

      log.debug(`ASSISTANT: id=${msgID} session=${sessionID} fetching parts`);

      try {
        const result = await client.session.message({
          path: { id: sessionID, messageID: msgID },
        }).catch((err: unknown) => {
          // This is only an in-flight reservation until the lookup succeeds.
          // A timeout or read failure must not suppress a later recovery event.
          storedMessages.delete(msgID);
          throw err;
        });

        if (!result.data) {
          storedMessages.delete(msgID);
          log.debug(`ASSISTANT: no data for ${msgID}`);
          return;
        }

        const data = result.data as {
          info: Record<string, unknown>;
          parts: Array<{ type: string; text?: string }>;
        };

        const text = (data.parts || [])
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n")
          .trim();

        if (!text) {
          log.debug(`ASSISTANT: empty text for ${msgID}`);
          return;
        }

        const safeText = scrubInjectedPkContext(text);
        if (!safeText) return;

        log.info(`ASSISTANT: storing id=${msgID} len=${safeText.length}`);
        api.storeEpisodic(safeText, "assistant", log, buildCaptureMetadata({ client: "opencode", cwd: directory, sessionId: sessionID }));
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`ASSISTANT ERROR: ${errMsg}`);
      }
    },
  };
};

// V2 exposes active context rather than V1's individual-message API. Keep
// that translation here instead of teaching the capture pipeline both shapes.
function createV2CaptureClient(ctx: V2Context): CaptureClient {
  return {
    session: {
      messages: async ({ path }) => {
        const messages = await ctx.session.context({ sessionID: path.id });
        return messages.map((message) => ({
          parts: message.content ?? (message.text ? [{ type: "text", text: message.text }] : []),
        }));
      },
      message: async ({ path }) => {
        const messages = await withTimeout(
          ctx.session.context({ sessionID: path.id }),
          OPENCODE_HISTORY_TIMEOUT_MS,
        );
        const message = messages.find((item) => item.id === path.messageID);
        return { data: message ? { parts: message.content ?? [] } : undefined };
      },
    },
  };
}

async function registerV2Hooks(ctx: V2Context, hooks: Required<CaptureHooks>) {
  await ctx.session.hook("prompt", async (event) => {
    const parts = [{ type: "text", text: event.prompt.text ?? "" }];
    await hooks["chat.message"]({ sessionID: event.sessionID }, {
      message: { id: event.messageID }, parts,
    });
    const text = parts[0]?.text ?? event.prompt.text;
    if (text !== event.prompt.text) {
      // V2 resolves mentions after this hook. Without offsets, attachments
      // remain attached but cannot replace the wrong span of the new text.
      for (const attachment of [...(event.prompt.files ?? []), ...(event.prompt.agents ?? []), ...(event.prompt.skills ?? [])]) {
        delete attachment.mention;
      }
      event.prompt.text = text;
    }
  });
  await ctx.session.hook("context", async (event) => {
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: event.sessionID }, output);
    for (const text of output.system) event.system.push({ type: "text", text });
  });
}

function subscribeV2AssistantEvents(ctx: V2Context, capture: NonNullable<CaptureHooks["event"]>) {
  const controller = new AbortController();
  const log = makeLogger(logFile("midbrain-opencode.log"));
  const pending = new Set<Promise<void>>();
  const subscription = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ types: ["session.step.ended", "session.step.failed"], signal: controller.signal })) {
        if (controller.signal.aborted) break;
        if (!["session.step.ended", "session.step.failed"].includes(event.type) || event.location?.directory !== ctx.location.directory) continue;
        // The V1 handler reserves the message ID before its first await,
        // so concurrent lookups retain deduplication without blocking the stream.
        const task = capture({ event: { type: "message.updated", properties: { info: {
          role: "assistant", id: event.data.assistantMessageID, sessionID: event.data.sessionID,
          time: { completed: event.created }, path: { cwd: ctx.location.directory },
        } } } }).catch((err: unknown) => {
          log.error(`ASSISTANT ERROR: ${err instanceof Error ? err.message : String(err)}`);
        });
        pending.add(task);
        void task.then(() => pending.delete(task));
      }
    } catch (err) {
      if (!controller.signal.aborted) log.error(`EVENT SUBSCRIPTION ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  return async () => {
    controller.abort();
    await subscription;
    // Lookups are bounded. Drain accepted callbacks before releasing their
    // state; episodic POSTs retain the existing fire-and-forget semantics.
    await Promise.all(pending);
  };
}

// OpenCode 1.18.29+ calls server; OpenCode 2 calls setup.
export default {
  id: "midbrain-memory",
  server: MidBrainMemoryPlugin,
  async setup(ctx: V2Context) {
    const hooks = await MidBrainMemoryPlugin({ client: createV2CaptureClient(ctx), directory: ctx.location.directory });
    const prompt = hooks["chat.message"];
    const context = hooks["experimental.chat.system.transform"];
    if (!prompt || !context || !hooks.event) return;
    await registerV2Hooks(ctx, { "chat.message": prompt, "experimental.chat.system.transform": context, event: hooks.event });
    return subscribeV2AssistantEvents(ctx, hooks.event);
  },
};
