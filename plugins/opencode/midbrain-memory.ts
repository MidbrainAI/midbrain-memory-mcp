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
 * - Opt-in PK injection: silent fallthrough on any error or timeout
 */

import { type Plugin } from "@opencode-ai/plugin";
// @ts-ignore — resolved via dev shim or bundled midbrain-shared.mjs at install time
import { MidbrainApi, makeLogger, logFile, getClient, extractInjectedPkIds, formatPkContext, isPkInjectionEnabled, stripInjectedContext, scrubInjectedPkContext } from "./midbrain-shared.mjs";

const OPENCODE_HISTORY_TIMEOUT_MS = 500;

type OpenCodePart = { type: string; text?: string };
type OpenCodeMessage = { parts?: OpenCodePart[] };

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

export const MidBrainMemoryPlugin: Plugin = async ({ client, directory }) => {
  const log = makeLogger(logFile("midbrain-opencode.log"));

  let api: InstanceType<typeof MidbrainApi>;
  try {
    api = await MidbrainApi.create(getClient("opencode"), directory);
    log.info(`INIT: dir=${directory} src=${api.keySource} key=${api.keyFingerprint}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`INIT ERROR: ${msg}`);
    console.error(`[midbrain-memory] ${msg}`);
    return {};
  }

  const storedMessages = new Set<string>();

  return {
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

      log.info(`USER: id=${messageID} len=${text.length}`);
      storedMessages.add(messageID);
      api.storeEpisodic(text, "user", log, { client: "opencode" });

      if (!isPkInjectionEnabled()) return;

      // Opt-in legacy PK injection: search and prepend relevant procedural context.
      try {
        const sessionID = (input as Record<string, unknown>).sessionID as string | undefined;
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
        });

        if (!result.data) {
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
        api.storeEpisodic(safeText, "assistant", log, { client: "opencode" });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`ASSISTANT ERROR: ${errMsg}`);
      }
    },
  };
};

export default MidBrainMemoryPlugin;
