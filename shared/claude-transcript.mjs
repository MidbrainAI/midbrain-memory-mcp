/** Guarded, bounded readers for Claude Stop-hook transcript consumers. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  commandReferencesShim,
  historicalShimPath,
  shellQuote,
} from "./clients/shim.mjs";

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_ANCESTRY_HOPS = 256;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NANOCLAW_SEND_MESSAGE = "mcp__nanoclaw__send_message";

function projectsRoot() {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function pathMatches(target, expected, kind) {
  try {
    const current = fs.lstatSync(target);
    return current[kind]() && sameIdentity(current, expected);
  } catch {
    return false;
  }
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function openTranscript(target) {
  let fd;
  try {
    if (typeof target !== "string" || !target.trim() || !path.isAbsolute(target)) return null;
    const rootPath = projectsRoot();
    const rootBefore = fs.lstatSync(rootPath);
    if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) return null;
    const rootReal = fs.realpathSync(rootPath);
    const before = fs.lstatSync(target);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const targetReal = fs.realpathSync(target);
    if (!isContained(rootReal, targetReal)) return null;

    const flags = fs.constants.O_RDONLY |
      (fs.constants.O_NONBLOCK ?? 0) |
      (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(target, flags);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(before, opened)) return null;
    if (!pathMatches(target, opened, "isFile") || !pathMatches(rootPath, rootBefore, "isDirectory")) return null;
    const result = { fd, target, rootPath, rootBefore, opened };
    fd = undefined;
    return result;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fail closed */ }
    }
  }
}

function readTail(source) {
  const length = Math.min(source.opened.size, MAX_TRANSCRIPT_BYTES);
  const offset = source.opened.size - length;
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const read = fs.readSync(source.fd, buffer, total, length - total, offset + total);
    if (read === 0) break;
    total += read;
  }
  const after = fs.fstatSync(source.fd);
  if (!sameIdentity(source.opened, after) || after.size !== source.opened.size) return null;
  if (!pathMatches(source.target, source.opened, "isFile")) return null;
  if (!pathMatches(source.rootPath, source.rootBefore, "isDirectory")) return null;
  return { raw: buffer.subarray(0, total).toString("utf8"), offset };
}

function parseCompleteRows({ raw, offset }) {
  let complete = raw;
  if (offset > 0) {
    const firstNewline = complete.indexOf("\n");
    if (firstNewline < 0) return [];
    complete = complete.slice(firstNewline + 1);
  }
  const finalNewline = complete.lastIndexOf("\n");
  if (finalNewline < 0) return [];
  const rows = [];
  for (const line of complete.slice(0, finalNewline).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* malformed rows are ineligible */ }
  }
  return rows;
}

/** Read trusted complete NDJSON rows from at most the final 4 MiB. */
export function readClaudeTranscript(transcriptPath) {
  const source = openTranscript(transcriptPath);
  if (!source) return null;
  try {
    const tail = readTail(source);
    return tail ? parseCompleteRows(tail) : null;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(source.fd); } catch { /* fail closed at caller */ }
  }
}

function renderedAssistantText(row) {
  const content = row?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function exactHistoricalUserCommand(command) {
  if (typeof command !== "string") return false;
  const shim = historicalShimPath("claude");
  const exact = command === `${shim} user` || command === `${shellQuote(shim)} user`;
  return exact && commandReferencesShim(command, "claude");
}

function isOwnedOpenerFailure(row) {
  const attachment = row?.attachment;
  return row?.type === "attachment" &&
    attachment?.type === "hook_non_blocking_error" &&
    attachment.hookName === "UserPromptSubmit" &&
    attachment.hookEvent === "UserPromptSubmit" &&
    Number.isInteger(attachment.exitCode) && attachment.exitCode === 127 &&
    exactHistoricalUserCommand(attachment.command);
}

function buildUuidIndex(rows) {
  const entries = new Map();
  const duplicates = new Set();
  for (const row of rows) {
    if (!UUID_RE.test(row?.uuid)) continue;
    if (entries.has(row.uuid)) duplicates.add(row.uuid);
    else entries.set(row.uuid, row);
  }
  return { entries, duplicates };
}

function finalAssistant(rows) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.type === "assistant" && row?.message?.role === "assistant") return row;
  }
  return null;
}

function stopBindingMatches(row, input) {
  return input.hookEventName === "Stop" &&
    typeof input.sessionId === "string" && input.sessionId.trim() &&
    typeof input.cwd === "string" && input.cwd.trim() &&
    typeof input.lastAssistantMessage === "string" && input.lastAssistantMessage.trim() &&
    row.sessionId === input.sessionId && row.cwd === input.cwd &&
    renderedAssistantText(row) === input.lastAssistantMessage;
}

/** Recover only the human ancestor proven to belong to this exact Stop event. */
export function recoverLegacyOpener(rows, input = {}) {
  if (!Array.isArray(rows)) return "";
  const terminal = finalAssistant(rows);
  if (!terminal || !stopBindingMatches(terminal, input) || !UUID_RE.test(terminal.uuid)) return "";
  const { entries, duplicates } = buildUuidIndex(rows);
  let current = terminal;
  let failures = 0;
  for (let hops = 0; hops <= MAX_ANCESTRY_HOPS; hops += 1) {
    if (duplicates.has(current.uuid)) return "";
    if (current.type === "user" && current.message?.role === "user" &&
        typeof current.message.content === "string") {
      const text = current.message.content;
      return failures === 1 && text.trim() ? text : "";
    }
    if (isOwnedOpenerFailure(current)) failures += 1;
    if (failures > 1 || !UUID_RE.test(current.parentUuid)) return "";
    const parent = entries.get(current.parentUuid);
    if (!parent) return "";
    current = parent;
  }
  return "";
}

/** Preserve the existing last-human-turn NanoClaw delivery selection. */
export function deliveredNanoclawMessage(rows) {
  if (!Array.isArray(rows)) return "";
  let delivered = "";
  for (const item of rows) {
    const message = item?.message;
    if (item?.type === "user" && message?.role === "user" && typeof message.content === "string") {
      delivered = "";
      continue;
    }
    if (item?.type !== "assistant" || message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === "tool_use" && block.name === NANOCLAW_SEND_MESSAGE &&
          typeof block.input?.text === "string" && block.input.text.trim()) {
        delivered = block.input.text.trim();
      }
    }
  }
  return delivered;
}
