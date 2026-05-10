/**
 * codex/common.mjs — Codex embodiment pure functions (PRD-008).
 *
 * Exports pure capture functions with a DI seam for testing.
 * Failure policy: best-effort write. Never throw. Never crash the hook.
 */

import path from "path";
import os from "os";
import fs from "fs";

import {
  loadApiKey as sharedLoadApiKey,
  storeEpisodic as sharedStoreEpisodic,
  makeDebugLogger,
} from "../shared/midbrain-common.mjs";

export const CODEX_CONFIG_DIR = path.join(os.homedir(), ".config", "codex");
export const DEBUG_LOG = path.join(os.homedir(), "midbrain-codex-debug.log");
const MAX_TOOL_MEMORY_CHARS = 12_000;
const REDACTED = "[redacted]";
const SECRET_KEY_PATTERN = /(?:api[_-]?key|authorization|bearer|client[_-]?secret|password|secret|token)/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
];

/**
 * Capture a Codex UserPromptSubmit event as episodic memory.
 * @param {{prompt?: string, cwd?: string}} input
 * @param {{loadApiKey: Function, storeEpisodic: Function, debugLog: Function}} deps
 */
export async function captureUser(input, deps) {
  const prompt = input?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) return;
  await postEpisodic(prompt, "user", input?.cwd, deps);
}

/**
 * Capture a Codex Stop event as episodic memory.
 * @param {{last_assistant_message?: string, stop_hook_active?: boolean, cwd?: string, transcript_path?: string, turn_id?: string}} input
 * @param {{loadApiKey: Function, storeEpisodic: Function, debugLog: Function}} deps
 */
export async function captureAssistant(input, deps) {
  if (input?.stop_hook_active === true) return;
  const entries = assistantEntries(input, deps.debugLog);
  for (const entry of entries) {
    await postEpisodic(entry, "assistant", input?.cwd, deps);
  }
}

/**
 * Capture a Codex PostToolUse event as assistant episodic memory.
 * @param {{tool_name?: string, tool_use_id?: string, tool_input?: unknown, tool_response?: unknown, cwd?: string}} input
 * @param {{loadApiKey: Function, storeEpisodic: Function, debugLog: Function}} deps
 */
export async function captureToolUse(input, deps) {
  const text = formatToolUseMemory(input);
  if (!text) return;
  await postEpisodic(text, "assistant", input?.cwd, deps);
}

/** @param {string} text @param {"user"|"assistant"} role */
async function postEpisodic(text, role, cwd, deps) {
  try {
    const projectDir = typeof cwd === "string" && cwd.trim() ? cwd : undefined;
    const { key } = deps.loadApiKey(projectDir, CODEX_CONFIG_DIR);
    await deps.storeEpisodic(key, text, role, deps.debugLog, "codex");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try { deps.debugLog(`CODEX CAPTURE ERROR (${role}): ${msg}`); } catch { /* swallow */ }
  }
}

function assistantEntries(input, debugLog) {
  const entries = transcriptAssistantEntries(input, debugLog);
  if (entries.length > 0) return entries;
  const msg = input?.last_assistant_message;
  return typeof msg === "string" && msg.trim() ? [msg.trim()] : [];
}

function transcriptAssistantEntries(input, debugLog) {
  if (!input?.transcript_path || !input?.turn_id) return [];
  try {
    return parseTranscriptTurn(input.transcript_path, input.turn_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try { debugLog(`TRANSCRIPT READ ERROR: ${msg}`); } catch { /* swallow */ }
    return [];
  }
}

function parseTranscriptTurn(transcriptPath, turnId) {
  const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/);
  const entries = [];
  let inTurn = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    if (isTaskStart(item, turnId)) inTurn = true;
    else if (inTurn && isTaskStart(item)) break;
    if (!inTurn || item.type !== "response_item") continue;
    entries.push(...assistantTextFromPayload(item.payload));
  }
  return entries;
}

function isTaskStart(item, turnId) {
  const payload = item?.payload;
  if (item?.type !== "event_msg" || payload?.type !== "task_started") return false;
  return turnId ? payload.turn_id === turnId : true;
}

function assistantTextFromPayload(payload) {
  if (payload?.type === "message" && payload.role === "assistant") {
    return textParts(payload.content);
  }
  if (payload?.type === "reasoning") return reasoningSummaryParts(payload.summary);
  return [];
}

function textParts(content) {
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => typeof part?.text === "string" ? part.text.trim() : "")
    .filter(Boolean);
}

function reasoningSummaryParts(summary) {
  if (!Array.isArray(summary) || summary.length === 0) return [];
  const text = summary
    .map((part) => typeof part === "string" ? part : part?.text)
    .filter((part) => typeof part === "string" && part.trim())
    .map((part) => part.trim())
    .join("\n");
  return text ? [`Reasoning summary:\n${text}`] : [];
}

function formatToolUseMemory(input) {
  const name = typeof input?.tool_name === "string" ? input.tool_name.trim() : "";
  if (!name) return "";
  const parts = [
    "Tool call completed",
    `Name: ${name}`,
    `ID: ${toolUseId(input)}`,
    "Input:",
    safeJson(input?.tool_input),
    "Response:",
    safeJson(input?.tool_response),
  ];
  return truncateText(parts.join("\n"), MAX_TOOL_MEMORY_CHARS);
}

function toolUseId(input) {
  return typeof input?.tool_use_id === "string" && input.tool_use_id.trim()
    ? input.tool_use_id.trim()
    : "unknown";
}

function safeJson(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(redactSecrets(value), null, 2);
  } catch (err) {
    return `[unserializable: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

function redactSecrets(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactSecretText(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(item, seen),
    ]),
  );
}

function redactSecretText(text) {
  return SECRET_VALUE_PATTERNS.reduce(
    (result, pattern) => result.replace(pattern, REDACTED),
    text,
  );
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[truncated ${omitted} chars]`;
}

/** Build real-world dependency bundle for production wrappers. */
export function makeDefaultDeps() {
  return {
    loadApiKey: sharedLoadApiKey,
    storeEpisodic: sharedStoreEpisodic,
    fetch: globalThis.fetch,
    debugLog: makeDebugLogger(DEBUG_LOG),
  };
}
