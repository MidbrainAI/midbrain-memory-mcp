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
 *   key skips a turn that was already stored. A retried prompt with no reply
 *   is the same turn even when OpenClaw gives it a new timestamp.
 * - Failed, incognito (empty history) and cron/heartbeat runs are skipped.
 * - The handler waits at most STORE_TIME_LIMIT_MS per store, then moves on
 *   while the store runs. A failed post is cached by MidbrainApi itself; a
 *   post still in flight when the process exits is cached by the exit flush,
 *   because OpenClaw can finish the turn first. Nothing is cached twice. The
 *   handler never throws.
 *
 * `before_prompt_build` reads the agent persona and user profile and appends
 * them to the system prompt (`appendSystemContext`) on user-triggered runs.
 * A blank field or a failed read adds nothing; it never throws.
 *
 * The installer copies this file, its manifest, package.json and the bundled
 * dist/midbrain-shared.mjs to a stable directory and links it in openclaw.json.
 */

import {
  MidbrainApi, appendToCache, makeLogger, logFile, buildCaptureMetadata, getClient,
  scrubInjectedPkContext, loadIdentityContext, scrubIdentityContext,
} from "./midbrain-shared.mjs";

export const CLIENT = "openclaw";
export const PLUGIN_ID = "midbrain-memory";
export const STORE_TIME_LIMIT_MS = 10_000;
// Below OpenClaw's 15 s before_prompt_build timeout, so the turn never waits on it.
export const IDENTITY_TIME_LIMIT_MS = 5_000;
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

// Captures whose store has not finished. OpenClaw can exit the process while
// a post is in flight; `exit` is synchronous, so the flush writes those to the
// offline cache before the process is gone. A finished store, successful or
// not, releases its entry first: MidbrainApi.storeEpisodic caches a failed
// post itself, so the plugin never writes the same entry to the cache twice.
const pendingCaptures = new Set();
let exitFlushInstalled = false;

function flushPendingCaptures() {
  for (const entry of pendingCaptures) {
    try { entry.cache(entry.record, entry.scope); } catch { /* ignore */ }
  }
  pendingCaptures.clear();
}

function installExitFlush() {
  if (exitFlushInstalled) return;
  exitFlushInstalled = true;
  process.on("exit", flushPendingCaptures);
}

/** One held capture, keyed by identity: two sessions may say the same words. */
function holdCapture(cache, record, scope) {
  const entry = { cache, record, scope };
  pendingCaptures.add(entry);
  return entry;
}

function releaseCapture(entry) {
  pendingCaptures.delete(entry);
}

// The gateway runs for weeks; per-session state is bounded.
const MAX_REMEMBERED = 500;
function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
}

function expireAfter(ms) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Build the `agent_end` handler. `deps` exists for tests: createApi(cwd),
 * logger, appendToCache and storeTimeLimitMs.
 */
export function createAgentEndHandler(deps = {}) {
  installExitFlush();
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
      remember(apis, key, created);
    }
    return apis.get(key);
  }

  /** The API for this workspace, or null (logged) when it did not resolve in time. */
  async function resolveApi(cwd, role) {
    const timer = expireAfter(limitMs);
    try {
      const api = await Promise.race([apiFor(cwd), timer.promise]);
      if (api === "timeout") {
        log.error(`OPENCLAW CAPTURE TIMEOUT (${role}): key/host not resolved after ${limitMs}ms; entry dropped`);
        return null;
      }
      return api;
    } catch (err) {
      log.error(`OPENCLAW CAPTURE ERROR (${role}): ${errorMessage(err)}`);
      return null;
    } finally {
      timer.cancel();
    }
  }

  /**
   * Store one held entry and release it when the store finishes, whatever
   * the outcome. Past the time limit the handler stops waiting but the store
   * runs on; the entry stays held, so it reaches the offline cache only if
   * the gateway exits before the store finishes.
   */
  async function storeHeld(api, entry) {
    const { text, role, memory_metadata: metadata } = entry.record;
    const work = Promise.resolve()
      .then(() => api.storeEpisodic(text, role, log, metadata))
      .catch((err) => log.error(`OPENCLAW CAPTURE ERROR (${role}): ${errorMessage(err)}`))
      .finally(() => releaseCapture(entry));
    const timer = expireAfter(limitMs);
    try {
      const outcome = await Promise.race([work.then(() => "done"), timer.promise]);
      if (outcome === "timeout") {
        log.warn(`OPENCLAW CAPTURE SLOW (${role}): no reply after ${limitMs}ms; still waiting, cached if the gateway exits first`);
      }
    } finally {
      timer.cancel();
    }
  }

  return async function onAgentEnd(event, ctx = {}) {
    try {
      if (!event?.success) return;
      if (ctx.trigger !== undefined && !CAPTURED_TRIGGERS.has(ctx.trigger)) return;
      const turn = extractTurn(event.messages);
      if (!turn) return;
      const session = ctx.sessionKey || ctx.sessionId || "";
      const prev = session ? lastTurn.get(session) : undefined;
      const reply = scrubIdentityContext(scrubInjectedPkContext(turn.assistant));
      // A model failure is retried as a new success with a fresh timestamp and
      // no reply. The timestamp key would store the prompt again each time.
      const emptyRetry = prev && prev.user === turn.user && !prev.assistant && !reply;
      if (emptyRetry) return;
      const replyAfterEmpty = prev && prev.user === turn.user && !prev.assistant && reply;
      if (prev && !replyAfterEmpty && prev.key === turn.key) return;
      if (session) remember(lastTurn, session, { key: turn.key, user: turn.user, assistant: reply });

      const cwd = typeof ctx.workspaceDir === "string" ? ctx.workspaceDir : undefined;
      const metadata = buildCaptureMetadata({ client: CLIENT, cwd, sessionId: ctx.sessionId || ctx.sessionKey });
      log.info(`TURN: session=${ctx.sessionId || "-"} user_len=${turn.user.length} assistant_len=${reply.length}`);

      const records = [];
      if (!replyAfterEmpty) records.push({ text: turn.user, role: "user", memory_metadata: metadata });
      if (reply) records.push({ text: reply, role: "assistant", memory_metadata: metadata });
      const api = await resolveApi(cwd, records[0].role);
      if (!api) return;
      // Hold the whole turn before the first store: an exit mid-turn caches both halves.
      const held = records.map((record) => holdCapture(cache, record, api.cacheScope));
      for (const entry of held) await storeHeld(api, entry);
    } catch (err) {
      try { log.error(`OPENCLAW CAPTURE ERROR: ${errorMessage(err)}`); } catch { /* ignore */ }
    }
  };
}

/**
 * Build the `before_prompt_build` handler. `deps` exists for tests:
 * createApi(cwd), logger and timeLimitMs.
 */
export function createPromptBuildHandler(deps = {}) {
  const createApi = deps.createApi || ((cwd) => MidbrainApi.create(getClient(CLIENT), cwd));
  const log = deps.logger || makeLogger(logFile("midbrain-openclaw.log"));
  const limitMs = deps.timeLimitMs ?? IDENTITY_TIME_LIMIT_MS;
  const apis = new Map();

  function apiFor(cwd) {
    const key = cwd || "";
    if (!apis.has(key)) {
      const created = Promise.resolve().then(() => createApi(cwd));
      created.catch(() => apis.delete(key));
      remember(apis, key, created);
    }
    return apis.get(key);
  }

  return async function onPromptBuild(_event, ctx = {}) {
    if (ctx?.trigger !== undefined && !CAPTURED_TRIGGERS.has(ctx.trigger)) return undefined;
    const cwd = typeof ctx?.workspaceDir === "string" ? ctx.workspaceDir : undefined;
    const timer = expireAfter(limitMs);
    try {
      const work = apiFor(cwd).then((api) => loadIdentityContext(api));
      const block = await Promise.race([work, timer.promise]);
      if (block === "timeout") {
        log.error(`OPENCLAW IDENTITY TIMEOUT: persona/profile not loaded after ${limitMs}ms`);
        return undefined;
      }
      if (!block) return undefined;
      log.info(`IDENTITY: session=${ctx.sessionId || "-"} system_context_len=${block.length}`);
      return { appendSystemContext: block };
    } catch (err) {
      try { log.error(`OPENCLAW IDENTITY ERROR: ${errorMessage(err)}`); } catch { /* ignore */ }
      return undefined;
    } finally {
      timer.cancel();
    }
  };
}

export default {
  id: PLUGIN_ID,
  name: "MidBrain Memory",
  description: "Adds the MidBrain persona and profile to each turn and stores each prompt and final reply in episodic memory.",
  register(api) {
    api.on("before_prompt_build", createPromptBuildHandler());
    api.on("agent_end", createAgentEndHandler());
  },
};
