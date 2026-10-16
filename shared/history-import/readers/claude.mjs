/**
 * Claude Code history reader (issue #75).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { jsonRows, regularFiles, validTimestamp } from "./common.mjs";

export function claudeProjectsDir(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

/**
 * Claude Code keeps one JSONL transcript per session in
 * `projects/<encoded-project>/<session-id>.jsonl`. Subagent transcripts live
 * in subdirectories and are not listed.
 */
export function listClaudeSessionFiles(root = claudeProjectsDir()) {
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return projects
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => regularFiles(path.join(root, entry.name), (name) => name.endsWith(".jsonl")));
}

// User rows Claude Code writes on the user's behalf: slash-command echoes,
// `!` shell input and output, local command output, interrupt markers.
const CLAUDE_GENERATED_PROMPT =
  /^\s*(?:<command-name>|<command-message>|<command-args>|<bash-input>|<bash-stdout>|<bash-stderr>|<local-command-stdout>|<local-command-stderr>|<local-command-caveat>|\[Request interrupted)/;

function claudeText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * A user row starts a turn when a person wrote it: not a tool result, not a
 * meta/compaction row, not a notification or peer message (`origin.kind`
 * other than `human`), and not one of Claude Code's generated echoes.
 */
function claudePrompt(row) {
  if (row.isMeta || row.isCompactSummary) return null;
  const kind = row.origin?.kind;
  if (kind && kind !== "human") return null;
  const text = claudeText(row.message?.content).trim();
  if (!text || CLAUDE_GENERATED_PROMPT.test(text)) return null;
  return text;
}

function isToolResult(row) {
  const content = row.message?.content;
  return Array.isArray(content) && content.length > 0 && content.every((block) => block?.type === "tool_result");
}

/** @returns {Promise<ImportSession>} */
export async function readClaudeSession(file) {
  const session = {
    client: "claude",
    file,
    sessionId: null,
    cwd: null,
    entries: [],
    skip: null,
    automated: false,
  };
  let turn = null;
  let interactivePrompts = 0;
  const closeTurn = () => {
    if (!turn) return;
    session.entries.push({ role: "user", text: turn.prompt, occurredAt: turn.at, cwd: turn.cwd });
    const reply = turn.replyParts.join("\n").trim();
    if (reply) {
      session.entries.push({ role: "assistant", text: reply, occurredAt: turn.replyAt || turn.at, cwd: turn.cwd });
    }
    turn = null;
  };

  for await (const row of jsonRows(file)) {
    if (!session.sessionId && typeof row.sessionId === "string") session.sessionId = row.sessionId;
    if (row.isSidechain) continue;
    if (row.type === "user") {
      const prompt = claudePrompt(row);
      if (!prompt) {
        // A slash command, notification or meta row starts a turn nobody
        // typed: what answers it is not the earlier prompt's reply. A tool
        // result stays inside the current turn.
        if (!isToolResult(row)) closeTurn();
        continue;
      }
      const at = validTimestamp(row.timestamp);
      if (!at) continue;
      closeTurn();
      // Agent SDK runs (`entrypoint: sdk-py`, `sdk-ts`, `sdk-cli`) mark their
      // prompts `promptSource: sdk`; a person's prompt is typed, queued, etc.
      const programmatic = row.promptSource === "sdk"
        || (typeof row.entrypoint === "string" && row.entrypoint.startsWith("sdk"));
      if (!programmatic) interactivePrompts += 1;
      const cwd = typeof row.cwd === "string" ? row.cwd : session.cwd;
      if (!session.cwd && cwd) session.cwd = cwd;
      turn = { prompt, at, cwd, replyId: null, replyParts: [], replyAt: null };
    } else if (row.type === "assistant" && turn) {
      const text = claudeText(row.message?.content).trim();
      if (!text) continue;
      // One API message is written as several rows that share message.id.
      // The turn's reply is the last message that has text.
      const id = row.message?.id ?? row.uuid ?? null;
      if (id !== turn.replyId) {
        turn.replyId = id;
        turn.replyParts = [];
      }
      turn.replyParts.push(text);
      turn.replyAt = validTimestamp(row.timestamp) || turn.replyAt;
    }
  }
  closeTurn();
  session.automated = session.entries.length > 0 && interactivePrompts === 0;
  if (!session.sessionId) session.skip = "no session id";
  return session;
}
