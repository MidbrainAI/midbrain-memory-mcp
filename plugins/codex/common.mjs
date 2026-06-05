/**
 * Shared Codex hook runtime.
 *
 * Failure policy: best-effort capture. Hooks must never crash Codex.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

import { MidbrainApi } from "../../shared/midbrain-api.mjs";
import { makeDebugLogger } from "../../shared/logger.mjs";
import { getClient } from "../../shared/clients/registry.mjs";

const DEBUG_LOG = path.join(os.homedir(), "midbrain-codex-debug.log");
const TOOL_BUFFER_DIR = path.join(os.tmpdir(), "midbrain-codex-tool-events");
const TOOL_BUFFER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_DETAIL_CHARS = 500;
const MAX_EVENTS = 10;
const REDACTED = "[redacted]";
const CODEX_METADATA = { client: "codex" };
const SECRET_KEY_RE = /(?:api[_-]?key|authorization|bearer|client[_-]?secret|password|secret|token)/i;
const SECRET_VALUE_RES = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
];
const INPUT_KEYS = ["cmd", "command", "query", "pattern", "q", "path", "file_path", "ref_id"];

export async function createApi(cwd) {
  return MidbrainApi.create(getClient("codex"), cwd);
}

export async function captureUser(input, deps = makeDefaultDeps()) {
  const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
  if (!prompt) return;
  await postEpisodic(prompt, "user", input?.cwd, deps);
}

export async function captureAssistant(input, deps = makeDefaultDeps()) {
  if (input?.stop_hook_active === true) return;
  const entries = assistantEntries(input, deps.debugLog);
  for (const entry of entries) await postEpisodic(entry, "assistant", input?.cwd, deps);
  const summary = flushToolSummary(input, deps);
  if (summary) await postEpisodic(summary, "assistant", input?.cwd, deps);
}

export async function captureToolUse(input, deps = makeDefaultDeps()) {
  try {
    const event = toolEvent(input);
    const dir = toolTurnDir(input, deps);
    if (!event || !dir) return;
    cleanupOldToolBuffers(toolBufferRoot(deps), deps.debugLog);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(toolEventPath(dir, event), JSON.stringify(event), { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    safeLog(deps.debugLog, `TOOL BUFFER ERROR: ${errorMessage(err)}`);
  }
}

export function runJsonHook(captureFn, { stdoutJson = false } = {}) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { buf += chunk; });
  process.stdin.on("end", async () => {
    try {
      await captureFn(JSON.parse(buf || "{}"), makeDefaultDeps());
    } catch { /* fail open */ }
    if (stdoutJson) process.stdout.write("{}");
    process.exit(0);
  });
}

async function postEpisodic(text, role, cwd, deps) {
  try {
    const projectDir = typeof cwd === "string" && cwd.trim() ? cwd : undefined;
    const api = await deps.createApi(projectDir);
    await Promise.resolve(api.storeEpisodic(text, role, deps.debugLog, CODEX_METADATA));
  } catch (err) {
    safeLog(deps.debugLog, `CODEX CAPTURE ERROR (${role}): ${errorMessage(err)}`);
  }
}

function assistantEntries(input, debugLog) {
  const transcriptEntries = transcriptAssistantEntries(input, debugLog);
  if (transcriptEntries.length > 0) return transcriptEntries;
  const msg = typeof input?.last_assistant_message === "string" ? input.last_assistant_message.trim() : "";
  return msg ? [msg] : [];
}

function transcriptAssistantEntries(input, debugLog) {
  if (!input?.transcript_path || !input?.turn_id) return [];
  try {
    return parseTranscriptTurn(input.transcript_path, input.turn_id);
  } catch (err) {
    safeLog(debugLog, `TRANSCRIPT READ ERROR: ${errorMessage(err)}`);
    return [];
  }
}

function parseTranscriptTurn(transcriptPath, turnId) {
  const entries = [];
  let inTurn = false;
  for (const line of fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    if (isTaskStart(item, turnId)) inTurn = true;
    else if (inTurn && isTaskStart(item)) break;
    if (inTurn && item.type === "response_item") entries.push(...assistantTextFromPayload(item.payload));
  }
  return entries;
}

function isTaskStart(item, turnId) {
  const payload = item?.payload;
  if (item?.type !== "event_msg" || payload?.type !== "task_started") return false;
  return turnId ? payload.turn_id === turnId : true;
}

function assistantTextFromPayload(payload) {
  if (payload?.type === "message" && payload.role === "assistant") return textParts(payload.content);
  if (payload?.type === "reasoning") return reasoningSummaryParts(payload.summary);
  return [];
}

function textParts(content) {
  if (!Array.isArray(content)) return [];
  return content.map((part) => typeof part?.text === "string" ? part.text.trim() : "").filter(Boolean);
}

function reasoningSummaryParts(summary) {
  if (!Array.isArray(summary)) return [];
  const text = summary.map((part) => typeof part === "string" ? part : part?.text)
    .filter((part) => typeof part === "string" && part.trim())
    .map((part) => part.trim())
    .join("\n");
  return text ? [`Reasoning summary:\n${text}`] : [];
}

function toolEvent(input) {
  const name = typeof input?.tool_name === "string" ? input.tool_name.trim() : "";
  if (!name) return null;
  return {
    name,
    id: typeof input?.tool_use_id === "string" ? input.tool_use_id.trim() : "unknown",
    input: redactSecrets(input?.tool_input),
    response: redactSecrets(input?.tool_response),
  };
}

function flushToolSummary(input, deps) {
  const dir = toolTurnDir(input, deps);
  if (!dir || !fs.existsSync(dir)) return "";
  try {
    const events = readToolEvents(dir, deps.debugLog);
    fs.rmSync(dir, { recursive: true, force: true });
    return events.length > 0 ? formatToolSummary(events) : "";
  } catch (err) {
    safeLog(deps.debugLog, `TOOL BUFFER FLUSH ERROR: ${errorMessage(err)}`);
    return "";
  }
}

function readToolEvents(dir, debugLog) {
  return fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort()
    .flatMap((file) => readToolEvent(path.join(dir, file), debugLog));
}

function readToolEvent(filePath, debugLog) {
  try {
    const event = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return typeof event?.name === "string" ? [event] : [];
  } catch (err) {
    safeLog(debugLog, `TOOL BUFFER READ ERROR: ${errorMessage(err)}`);
    return [];
  }
}

function formatToolSummary(events) {
  const selected = selectToolEvents(events);
  const lines = ["Tool activity summary", `Tools: ${formatToolCounts(events)}`, "Notable:"];
  lines.push(...selected.map((event) => `- ${toolEventSummary(event)}`));
  if (events.length > selected.length) lines.push(`Omitted: ${events.length - selected.length} lower-signal tool calls`);
  return truncateText(lines.join("\n"), MAX_SUMMARY_CHARS);
}

function formatToolCounts(events) {
  const counts = new Map();
  for (const event of events) counts.set(event.name, (counts.get(event.name) || 0) + 1);
  return [...counts.entries()].map(([name, count]) => `${name} x${count}`).join(", ");
}

function selectToolEvents(events) {
  return events.map((event, index) => ({ event, index }))
    .sort((a, b) => scoreToolEvent(b.event) - scoreToolEvent(a.event) || a.index - b.index)
    .slice(0, MAX_EVENTS)
    .sort((a, b) => a.index - b.index)
    .map(({ event }) => event);
}

function scoreToolEvent(event) {
  return toolResultSummary(event) === "success" ? 0 : 1;
}

function toolEventSummary(event) {
  return `${event.name}: ${toolInputSummary(event)} -> ${toolResultSummary(event)}`;
}

function toolInputSummary(event) {
  for (const key of INPUT_KEYS) {
    const value = event?.input?.[key];
    if (typeof value === "string" && value.trim()) return shortOneLine(value);
  }
  const json = safeJson(event?.input);
  return json ? shortOneLine(json) : "no input";
}

function toolResultSummary(event) {
  const response = event?.response;
  if (response?.exit_code !== undefined) return exitCodeSummary(response.exit_code, response);
  if (response?.exitCode !== undefined) return exitCodeSummary(response.exitCode, response);
  if (response?.isError === true || response?.error) return failureSummary("error", response);
  return "success";
}

function exitCodeSummary(code, response) {
  return String(code) === "0" ? "success" : failureSummary(`exit ${code}`, response);
}

function failureSummary(prefix, response) {
  const detail = responseDetail(response);
  return detail ? `${prefix}: ${detail}` : prefix;
}

function responseDetail(response) {
  for (const key of ["stderr", "error", "message", "output"]) {
    const value = response?.[key];
    if (typeof value === "string" && value.trim()) return shortOneLine(value);
  }
  return "";
}

function toolTurnDir(input, deps) {
  const sessionId = safePathPart(input?.session_id);
  const turnId = safePathPart(input?.turn_id);
  return sessionId && turnId ? path.join(toolBufferRoot(deps), sessionId, turnId) : "";
}

function toolBufferRoot(deps) {
  return typeof deps?.toolBufferDir === "string" && deps.toolBufferDir.trim()
    ? deps.toolBufferDir
    : TOOL_BUFFER_DIR;
}

function toolEventPath(dir, event) {
  return path.join(dir, `${Date.now()}-${safePathPart(event.id) || "unknown"}-${randomUUID()}.json`);
}

function cleanupOldToolBuffers(root, debugLog) {
  const cutoff = Date.now() - TOOL_BUFFER_TTL_MS;
  try {
    for (const sessionDir of childDirs(root)) {
      for (const turnDir of childDirs(sessionDir)) removeOldDir(turnDir, cutoff);
      removeEmptyDir(sessionDir);
    }
  } catch (err) {
    safeLog(debugLog, `TOOL BUFFER CLEANUP ERROR: ${errorMessage(err)}`);
  }
}

function childDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

function removeOldDir(dir, cutoff) {
  try {
    if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

function removeEmptyDir(dir) {
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* best effort */ }
}

function redactSecrets(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactSecretText(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY_RE.test(key) ? REDACTED : redactSecrets(item, seen),
  ]));
}

function redactSecretText(text) {
  return SECRET_VALUE_RES.reduce((result, pattern) => result.replace(pattern, REDACTED), text);
}

function shortOneLine(text) {
  return truncateText(redactSecretText(String(text)).replace(/\s+/g, " ").trim(), MAX_DETAIL_CHARS);
}

function safeJson(value) {
  if (value === undefined) return "";
  try {
    return JSON.stringify(redactSecrets(value));
  } catch (err) {
    return `[unserializable: ${errorMessage(err)}]`;
  }
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`;
}

function safePathPart(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return value.trim().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

function safeLog(debugLog, message) {
  try { debugLog(message); } catch { /* ignore */ }
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

export function makeDefaultDeps() {
  return {
    createApi,
    debugLog: makeDebugLogger(DEBUG_LOG),
    toolBufferDir: TOOL_BUFFER_DIR,
  };
}
