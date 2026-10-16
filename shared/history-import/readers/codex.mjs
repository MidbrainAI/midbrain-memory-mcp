/**
 * Codex history reader (issue #75).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { jsonRows, regularFiles, validTimestamp } from "./common.mjs";

export function codexSessionDirs(env = process.env) {
  const home = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return [path.join(home, "sessions"), path.join(home, "archived_sessions")];
}

/** Codex keeps `sessions/YYYY/MM/DD/rollout-*.jsonl` (and the same under `archived_sessions`, flat). */
export function listCodexSessionFiles(dirs = codexSessionDirs()) {
  const isRollout = (name) => name.startsWith("rollout-") && name.endsWith(".jsonl");
  const files = [];
  const walk = (dir, depth) => {
    files.push(...regularFiles(dir, isRollout));
    if (depth === 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth - 1);
    }
  };
  for (const dir of dirs) walk(dir, 3);
  return files;
}

// Text Codex adds to the user's message: AGENTS.md and environment context.
const CODEX_INJECTED_PROMPT = /^\s*(?:# AGENTS\.md instructions|<environment_context>|<user_instructions>|<turn_aborted>)/;

function codexText(content, type) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === type && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** @returns {Promise<ImportSession>} */
export async function readCodexSession(file) {
  const session = {
    client: "codex",
    file,
    sessionId: null,
    cwd: null,
    entries: [],
    skip: null,
  };
  let turn = null;
  let cwd = null;
  const closeTurn = () => {
    if (!turn) return;
    if (turn.prompt) {
      session.entries.push({ role: "user", text: turn.prompt, occurredAt: turn.promptAt, cwd: turn.cwd });
      if (turn.reply) {
        session.entries.push({ role: "assistant", text: turn.reply, occurredAt: turn.replyAt || turn.promptAt, cwd: turn.cwd });
      }
    }
    turn = null;
  };
  const openTurn = () => {
    closeTurn();
    turn = { prompt: "", promptAt: null, reply: "", replyAt: null, cwd };
  };

  for await (const row of jsonRows(file)) {
    const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
    const at = validTimestamp(row.timestamp);
    if (row.type === "session_meta") {
      if (typeof payload.id === "string") session.sessionId = payload.id;
      if (typeof payload.cwd === "string") session.cwd = cwd = payload.cwd;
      // Threads spawned by another Codex agent are not the user's conversation.
      if (payload.source && typeof payload.source === "object" && payload.source.subagent) {
        session.skip = "subagent session";
        return session;
      }
    } else if (row.type === "turn_context") {
      if (typeof payload.cwd === "string") {
        cwd = payload.cwd;
        if (turn) turn.cwd = cwd;
      }
    } else if (row.type === "event_msg" && payload.type === "task_started") {
      openTurn();
    } else if (row.type === "event_msg" && payload.type === "task_complete") {
      if (turn && !turn.reply && typeof payload.last_agent_message === "string") {
        turn.reply = payload.last_agent_message.trim();
        turn.replyAt = at;
      }
      closeTurn();
    } else if (row.type === "response_item" && payload.type === "message") {
      if (payload.role === "user") {
        const text = codexText(payload.content, "input_text").trim();
        if (!text || CODEX_INJECTED_PROMPT.test(text) || !at) continue;
        if (!turn) openTurn();
        turn.prompt = turn.prompt ? `${turn.prompt}\n${text}` : text;
        if (!turn.promptAt) turn.promptAt = at;
      } else if (payload.role === "assistant" && payload.phase === "final_answer" && turn) {
        const text = codexText(payload.content, "output_text").trim();
        if (text) {
          turn.reply = text;
          turn.replyAt = at;
        }
      }
    }
  }
  closeTurn();
  if (!session.sessionId) session.skip = "no session id";
  return session;
}
