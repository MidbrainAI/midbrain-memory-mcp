/**
 * MidBrain Memory OpenClaw plugin.
 *
 * Episodic auto-capture on OpenClaw's typed `agent_end` hook: after each
 * user-triggered run, the newest user prompt and the final assistant reply
 * are stored with client/session/cwd metadata. memory_search lives in the MCP
 * server (index.js at the package root), not here.
 *
 * - `agent_end` carries the whole session history, so only the last user
 *   message and the assistant text after it are captured, and a per-session
 *   key skips a turn that was already stored.
 * - Failed, incognito (empty history) and cron/heartbeat runs are skipped.
 * - Each store has a hard time limit; on expiry the entry goes to the offline
 *   cache for the boot-time drain. The handler never throws.
 *
 * The installer copies this file, its manifest, package.json and the bundled
 * dist/midbrain-shared.mjs to a stable directory and links it in openclaw.json.
 */

import {
  MidbrainApi, appendToCache, makeLogger, logFile, buildCaptureMetadata, getClient,
  scrubInjectedPkContext,
} from "./midbrain-shared.mjs";

export const CLIENT = "openclaw";
export const PLUGIN_ID = "midbrain-memory";
export const STORE_TIME_LIMIT_MS = 10_000;
const CAPTURED_TRIGGERS = new Set(["user"]);

/** Plain text of one OpenClaw message: string content or its text parts. */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * The current turn from an `agent_end` history: the last user message with
 * text, and the last assistant message with text after it (tool-call steps
 * in between carry no text). Returns null when there is no user prompt.
 */
export function extractTurn(messages) {
  if (!Array.isArray(messages)) return null;
  let userIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && messageText(messages[i])) {
      userIdx = i;
      break;
    }
  }
  if (userIdx === -1) return null;
  const user = messages[userIdx];
  let assistant = "";
  for (let i = messages.length - 1; i > userIdx; i--) {
    if (messages[i]?.role !== "assistant") continue;
    assistant = messageText(messages[i]);
    if (assistant) break;
  }
  return {
    user: messageText(user),
    assistant,
    key: `${user.timestamp ?? userIdx}:${messageText(user).length}`,
  };
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the `agent_end` handler. `deps` exists for tests: createApi(cwd),
 * logger, appendToCache and storeTimeLimitMs.
 */
export function createAgentEndHandler(deps = {}) {
  const createApi = deps.createApi || ((cwd) => MidbrainApi.create(getClient(CLIENT), cwd));
  const log = deps.logger || makeLogger(logFile("midbrain-openclaw.log"));
  const cache = deps.appendToCache || appendToCache;
  const limitMs = deps.storeTimeLimitMs ?? STORE_TIME_LIMIT_MS;
  const apis = new Map();
  const lastTurn = new Map();

  function apiFor(cwd) {
    const key = cwd || "";
    if (!apis.has(key)) {
      const created = Promise.resolve().then(() => createApi(cwd));
      created.catch(() => apis.delete(key));
      apis.set(key, created);
    }
    return apis.get(key);
  }

  async function storeWithLimit(text, role, metadata, cwd) {
    let api;
    const work = (async () => {
      api = await apiFor(cwd);
      await api.storeEpisodic(text, role, log, metadata);
      return "done";
    })().catch((err) => {
      log.error(`OPENCLAW CAPTURE ERROR (${role}): ${errorMessage(err)}`);
      return "failed";
    });
    let timer;
    const expired = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), limitMs); });
    const outcome = await Promise.race([work, expired]);
    clearTimeout(timer);
    if (outcome !== "timeout") return;
    if (api) {
      cache({ text, role, memory_metadata: metadata }, api.cacheScope);
      log.warn(`OPENCLAW CAPTURE TIMEOUT (${role}): no reply after ${limitMs}ms; cached for boot-time drain`);
    } else {
      log.error(`OPENCLAW CAPTURE TIMEOUT (${role}): key/host not resolved after ${limitMs}ms; entry dropped`);
    }
  }

  return async function onAgentEnd(event, ctx = {}) {
    try {
      if (!event?.success) return;
      if (ctx.trigger !== undefined && !CAPTURED_TRIGGERS.has(ctx.trigger)) return;
      const turn = extractTurn(event.messages);
      if (!turn) return;
      const session = ctx.sessionKey || ctx.sessionId || "";
      if (session && lastTurn.get(session) === turn.key) return;
      if (session) lastTurn.set(session, turn.key);

      const cwd = typeof ctx.workspaceDir === "string" ? ctx.workspaceDir : undefined;
      const metadata = buildCaptureMetadata({ client: CLIENT, cwd, sessionId: ctx.sessionId || ctx.sessionKey });
      log.info(`TURN: session=${ctx.sessionId || "-"} user_len=${turn.user.length} assistant_len=${turn.assistant.length}`);
      await storeWithLimit(turn.user, "user", metadata, cwd);
      const reply = scrubInjectedPkContext(turn.assistant);
      if (reply) await storeWithLimit(reply, "assistant", metadata, cwd);
    } catch (err) {
      try { log.error(`OPENCLAW CAPTURE ERROR: ${errorMessage(err)}`); } catch { /* ignore */ }
    }
  };
}

export default {
  id: PLUGIN_ID,
  name: "MidBrain Memory",
  description: "Stores each user prompt and final assistant reply in MidBrain episodic memory.",
  register(api) {
    api.on("agent_end", createAgentEndHandler());
  },
};
