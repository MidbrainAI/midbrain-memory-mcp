/**
 * Prime Agent capture runtime.
 *
 * Prime Agent has no hook system. It appends every session to an
 * append-only JSONL log under its sessions dir (`session`, `message`,
 * `compaction`, ... entries), and it imports Python skills into each
 * session's kernel at start. The MidBrain skill's import launches
 * `hook prime-agent watch`, which polls those logs while the kernel's owner
 * process (PRIME_AGENT_KERNEL_OWNER_PID) runs, then makes a final pass.
 * `hook prime-agent sync` makes one pass.
 *
 * Per log, a cursor under the cache dir records the byte offset already
 * read and the tool calls of the turn in progress. A pass stores:
 *   - each user message's text, when it is appended, and each message a
 *     person sent with `prime-agent send` (an `agent_message` from a client);
 *   - each final assistant message's text (stopReason stop/length), then a
 *     bounded tool summary of the turn's tool calls.
 * Subagent sessions (rlmDepth > 0) are skipped, and so is the copy of the
 * parent's history a forked session starts with. A log first seen after
 * capture was enabled is read from the start; one that started earlier is
 * read from its end, so old history is never bulk-imported.
 *
 * One process handles a log at a time (a per-log lock) and the cursor moves
 * before the POST, so a turn is stored at most once; a failed POST lands in
 * the offline cache through MidbrainApi.storeEpisodic. Nothing here throws
 * to the caller.
 */

import fs from "fs";
import path from "path";

import { MidbrainApi } from "../../shared/midbrain-api.mjs";
import { hookProjectDir, logProjectFallback } from "../../shared/project-dir.mjs";
import { makeLogger, logFile } from "../../shared/logger.mjs";
import { getClient } from "../../shared/clients/registry.mjs";
import { buildCaptureMetadata } from "../../shared/capture-metadata.mjs";
import {
  CLIENT_ID, primeSessionsDir, primeCaptureStateDir, captureEnabledAt, markCaptureEnabled,
} from "../../shared/clients/prime-agent.mjs";

const OWNER_ENV = "PRIME_AGENT_KERNEL_OWNER_PID";
const POLL_ENV = "MIDBRAIN_PRIME_POLL_MS";
const DEFAULT_POLL_MS = 2_000;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_TOOLS = 50;
const MAX_SUMMARY_TOOLS = 10;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_DETAIL_CHARS = 300;
const FINAL_STOP_REASONS = new Set(["stop", "length"]);
const REDACTED = "[redacted]";
const SECRET_VALUE_RES = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
];

// --- Session log entries -> captures (pure) ---

/** A fresh per-log state: session header fields and the turn's tool calls. */
export function newSessionState() {
  return { sessionId: undefined, cwd: undefined, depth: 0, startedAt: undefined, tools: [] };
}

/** The text blocks of a message, joined; images and tool calls are ignored. */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

/**
 * Apply one log entry to the state and return what to store from it:
 * `[{ role, text }]`. Mutates `state` (header fields, tool calls).
 */
export function applyEntry(state, entry) {
  if (entry?.type === "session") {
    if (typeof entry.id === "string") state.sessionId = entry.id;
    if (typeof entry.cwd === "string") state.cwd = entry.cwd;
    state.depth = Number.isFinite(entry.rlmDepth) ? entry.rlmDepth : 0;
    const startedAt = Date.parse(entry.timestamp ?? "");
    state.startedAt = Number.isFinite(startedAt) ? startedAt : undefined;
    return [];
  }
  if (state.depth > 0) return [];
  // A fork (`--fork`, header `parentSession`) starts with a copy of the
  // parent's entries, which keep their original, earlier timestamps; that
  // includes `prime-agent send` prompts (custom_message rows).
  if (state.startedAt !== undefined && Date.parse(entry?.timestamp ?? "") < state.startedAt) return [];
  if (entry?.type === "custom_message") return applyCustomMessage(state, entry);
  if (entry?.type !== "message") return [];
  const message = entry.message;
  if (message?.role === "user") {
    state.tools = [];
    const text = messageText(message);
    return text ? [{ role: "user", text }] : [];
  }
  if (message?.role === "toolResult") {
    const tool = state.tools.find((t) => t.id === message.toolCallId);
    if (tool) tool.ok = message.isError !== true;
    return [];
  }
  if (message?.role !== "assistant") return [];
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type === "toolCall" && state.tools.length < MAX_TOOLS) {
      state.tools.push({ id: block.id, name: String(block.name || "tool"), detail: toolDetail(block.arguments) });
    }
  }
  if (message.stopReason === "toolUse") return [];
  const captures = [];
  if (FINAL_STOP_REASONS.has(message.stopReason)) {
    const text = messageText(message);
    if (text) captures.push({ role: "assistant", text });
    if (state.tools.length) captures.push({ role: "assistant", text: formatToolSummary(state.tools) });
  }
  // A final answer ends the turn; an error or abort drops its tool calls.
  state.tools = [];
  return captures;
}

/**
 * `prime-agent send` (and other daemon clients) deliver a prompt as an
 * `agent_message` row whose sender is a client, not an agent session: that is
 * a person's turn. Messages from other agents (subagent replies, peers) are
 * model output and are skipped, like heartbeats and harness notices.
 */
function applyCustomMessage(state, entry) {
  if (entry.customType !== "agent_message") return [];
  const from = entry.details?.from;
  if (!from || typeof from !== "object" || from.sessionId || from.activeSessionId || !from.clientId) return [];
  const text = typeof entry.details.message === "string" ? entry.details.message.trim() : "";
  state.tools = [];
  return text ? [{ role: "user", text }] : [];
}

function toolDetail(args) {
  if (!args || typeof args !== "object") return "";
  const source = ["code", "command", "cmd", "query", "path"]
    .map((key) => args[key])
    .find((value) => typeof value === "string" && value.trim());
  const text = source ?? safeJson(args);
  const firstLines = text.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" | ");
  return truncate(redact(firstLines), MAX_DETAIL_CHARS);
}

/** Same shape as the Codex tool summary: counts, then notable calls. */
export function formatToolSummary(tools) {
  const counts = new Map();
  for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) || 0) + 1);
  // Failed calls first, then the earliest; shown in call order.
  const selected = tools.map((tool, index) => ({ tool, index }))
    .sort((a, b) => Number(a.tool.ok !== false) - Number(b.tool.ok !== false) || a.index - b.index)
    .slice(0, MAX_SUMMARY_TOOLS)
    .sort((a, b) => a.index - b.index)
    .map(({ tool }) => tool);
  const lines = [
    "Tool activity summary",
    `Tools: ${[...counts].map(([name, count]) => `${name} x${count}`).join(", ")}`,
    "Notable:",
    ...selected.map((t) => `- ${t.name}: ${t.detail || "no input"} -> ${t.ok === false ? "error" : t.ok ? "success" : "no result"}`),
  ];
  if (tools.length > selected.length) lines.push(`Omitted: ${tools.length - selected.length} lower-signal tool calls`);
  return truncate(lines.join("\n"), MAX_SUMMARY_CHARS);
}

function redact(text) {
  return SECRET_VALUE_RES.reduce((result, pattern) => result.replace(pattern, REDACTED), text);
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function safeJson(value) {
  try { return JSON.stringify(value) || ""; } catch { return ""; }
}

/**
 * Split a chunk of log bytes into complete JSON entries. A trailing partial
 * line (Prime Agent mid-append) is left for the next pass.
 * @returns {{ entries: object[], consumed: number }}
 */
export function parseLogChunk(buffer) {
  const end = buffer.lastIndexOf(0x0a);
  if (end < 0) return { entries: [], consumed: 0 };
  const entries = [];
  for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a corrupt line is skipped */ }
  }
  return { entries, consumed: end + 1 };
}

// --- Cursors and locks ---

function stateDir() { return primeCaptureStateDir(); }
function cursorPath(logPath) { return path.join(stateDir(), "cursors", `${path.basename(logPath)}.json`); }
function logLockPath(logPath) { return path.join(stateDir(), "locks", `${path.basename(logPath)}.lock`); }
function ownerLockPath(pid) { return path.join(stateDir(), "owners", `${pid}.lock`); }

function readCursor(logPath) {
  try {
    const data = JSON.parse(fs.readFileSync(cursorPath(logPath), "utf8"));
    if (Number.isInteger(data?.offset) && data.offset >= 0) {
      return { ...data, state: { ...newSessionState(), ...data.state } };
    }
  } catch { /* none yet */ }
  return null;
}

function writeCursor(logPath, cursor) {
  const file = cursorPath(logPath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cursor), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Take a pid lock file; a lock whose holder has exited is taken over. Returns a release fn or null. */
export function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { encoding: "utf8", flag: "wx", mode: 0o600 });
      return () => { try { if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file); } catch { /* gone */ } };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let holder;
      try { holder = Number.parseInt(fs.readFileSync(file, "utf8"), 10); } catch { holder = NaN; }
      if (isAlive(holder) && holder !== process.pid) return null;
      try { fs.unlinkSync(file); } catch { /* raced with another taker */ }
    }
  }
  return null;
}

// --- Sync ---

/** The first entry of a log, when it is the session header. */
function readHeader(logPath) {
  const fd = fs.openSync(logPath, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const { entries } = parseLogChunk(buffer.subarray(0, read));
    return entries[0]?.type === "session" ? entries[0] : null;
  } finally { fs.closeSync(fd); }
}

/**
 * The starting cursor for a log seen for the first time: from the start
 * when the session began after capture was enabled, else from its end.
 */
function initialCursor(logPath, size, enabledAt) {
  const header = readHeader(logPath);
  const state = newSessionState();
  if (header) applyEntry(state, header);
  const started = Date.parse(header?.timestamp ?? "");
  const fromStart = enabledAt !== null && Number.isFinite(started) && started >= enabledAt;
  return { offset: fromStart ? 0 : size, state };
}

/**
 * Read a log's new complete entries and store their captures.
 * @returns {Promise<number>} captures stored or cached
 */
export async function syncLog(logPath, deps) {
  const release = acquireLock(logLockPath(logPath));
  if (!release) return 0;
  try {
    const stat = fs.statSync(logPath);
    let cursor = readCursor(logPath) ?? initialCursor(logPath, stat.size, deps.enabledAt);
    if (stat.size < cursor.offset) {
      // Not append-only after all (rewritten or truncated): resume at its end.
      deps.logger.warn(`PRIME LOG SHRANK: ${path.basename(logPath)}; resuming at its end`);
      cursor = { offset: stat.size, state: cursor.state };
    }
    let stored = 0;
    while (cursor.offset < stat.size) {
      const length = Math.min(stat.size - cursor.offset, MAX_READ_BYTES);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(logPath, "r");
      let read;
      try { read = fs.readSync(fd, buffer, 0, length, cursor.offset); } finally { fs.closeSync(fd); }
      const { entries, consumed } = parseLogChunk(buffer.subarray(0, read));
      if (consumed === 0) break;
      const captures = entries.flatMap((entry) => applyEntry(cursor.state, entry));
      cursor = { offset: cursor.offset + consumed, mtimeMs: stat.mtimeMs, state: cursor.state };
      writeCursor(logPath, cursor);
      for (const capture of captures) {
        if (await storeCapture(capture, cursor.state, deps)) stored++;
      }
    }
    if (cursor.mtimeMs !== stat.mtimeMs) writeCursor(logPath, { ...cursor, mtimeMs: stat.mtimeMs });
    return stored;
  } finally { release(); }
}

async function storeCapture({ role, text }, state, deps) {
  try {
    const api = await deps.apiFor(state.cwd);
    const metadata = buildCaptureMetadata({ client: CLIENT_ID, cwd: state.cwd, sessionId: state.sessionId });
    await api.storeEpisodic(text, role, deps.logger, metadata);
    return true;
  } catch (err) {
    deps.logger.error(`PRIME CAPTURE ERROR (${role}): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** One pass over the top-level session logs that changed since their cursor. */
export async function syncAll(deps) {
  let names;
  try {
    names = fs.readdirSync(deps.sessionsDir).filter((name) => name.endsWith(".jsonl"));
  } catch (err) {
    if (err.code !== "ENOENT") deps.logger.error(`PRIME SESSIONS DIR ERROR: ${err.message}`);
    return 0;
  }
  let stored = 0;
  for (const name of names) {
    const logPath = path.join(deps.sessionsDir, name);
    try {
      const { mtimeMs } = fs.statSync(logPath);
      // Unchanged since this process last read it, or since any process did.
      if (deps.seen?.get(logPath) === mtimeMs) continue;
      if (readCursor(logPath)?.mtimeMs !== mtimeMs) stored += await syncLog(logPath, deps);
      deps.seen?.set(logPath, readCursor(logPath)?.mtimeMs);
    } catch (err) {
      deps.logger.error(`PRIME SYNC ERROR (${name}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return stored;
}

/**
 * Poll while the owner process runs, then make a final pass. Without an
 * owner pid, one pass. A second watcher for the same owner exits at once.
 */
export async function watch(deps) {
  const owner = deps.ownerPid;
  if (!owner) return syncAll(deps);
  const release = acquireLock(ownerLockPath(owner));
  if (!release) return 0;
  try {
    let stored = 0;
    while (isAlive(owner)) {
      stored += await syncAll(deps);
      await deps.sleep(deps.pollMs);
    }
    return stored + await syncAll(deps);
  } finally { release(); }
}

export async function makeDefaultDeps(env = process.env) {
  const apis = new Map();
  const logger = makeLogger(logFile(`midbrain-${CLIENT_ID}.log`));
  const owner = Number.parseInt(env[OWNER_ENV] ?? "", 10);
  const pollMs = Number.parseInt(env[POLL_ENV] ?? "", 10);
  await markCaptureEnabled();
  return {
    logger,
    seen: new Map(),
    sessionsDir: await primeSessionsDir(env),
    enabledAt: await captureEnabledAt(),
    ownerPid: Number.isInteger(owner) && owner > 0 ? owner : undefined,
    pollMs: Number.isInteger(pollMs) && pollMs > 0 ? pollMs : DEFAULT_POLL_MS,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // One API per project directory and pass, so each key is resolved once.
    apiFor: async (cwd) => {
      const dir = hookProjectDir(cwd) ?? "";
      if (!apis.has(dir)) {
        const api = await MidbrainApi.create(getClient(CLIENT_ID), dir || undefined);
        logProjectFallback(api, logger);
        apis.set(dir, api);
      }
      return apis.get(dir);
    },
  };
}

/** `hook prime-agent watch|sync`: run, self-update (throttled), exit 0. */
export async function runCaptureCli(mode, { exit = (code) => process.exit(code) } = {}) {
  try {
    const deps = await makeDefaultDeps();
    const stored = mode === "sync" ? await syncAll(deps) : await watch(deps);
    deps.logger.info(`PRIME ${mode.toUpperCase()} done: ${stored} captures`);
  } catch { /* never fail the caller */ }
  try {
    const { maybeSelfUpdate } = await import("../../install.mjs");
    await maybeSelfUpdate();
  } catch { /* never break capture */ }
  exit(0);
}
