/**
 * Codex history reader (issue #75).
 */

import os from "node:os";
import path from "node:path";

import { CORRUPT_ROW, jsonRows, regularFiles, subdirectories, validTimestamp } from "./common.mjs";

export function codexSessionDirs(env = process.env) {
  const home = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return [path.join(home, "sessions"), path.join(home, "archived_sessions")];
}

/**
 * Codex keeps `sessions/YYYY/MM/DD/rollout-*.jsonl` (and the same under
 * `archived_sessions`, flat). With `local_thread_store_compression` on, a
 * rollout untouched for 7 days becomes `rollout-*.jsonl.zst`; while both
 * exist (mid-compression, or reopened for append) the plain file is read.
 */
export function listCodexSessionFiles(dirs = codexSessionDirs()) {
  const isRollout = (name) => name.startsWith("rollout-") && (name.endsWith(".jsonl") || name.endsWith(".jsonl.zst"));
  const files = [];
  const walk = (dir, depth) => {
    const found = regularFiles(dir, isRollout);
    const plain = new Set(found.filter((file) => file.endsWith(".jsonl")));
    files.push(...found.filter((file) => !file.endsWith(".zst") || !plain.has(file.slice(0, -".zst".length))));
    if (depth > 0) for (const sub of subdirectories(dir)) walk(sub, depth - 1);
  };
  for (const dir of dirs) walk(dir, 3);
  return files;
}

// Text Codex adds as a user message: AGENTS.md, environment context, and
// internal context such as goal continuations (`<codex_internal_context
// source="goal">`). A turn with no typed prompt is not imported.
const CODEX_INJECTED_PROMPT = /^\s*(?:# AGENTS\.md instructions|<environment_context>|<user_instructions>|<turn_aborted>|<codex_internal_context[\s>])/;

function codexText(content, type) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === type && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** @returns {Promise<import("../plan.mjs").ImportSession>} */
/** The history folder (of `dirs`) a rollout is read from. */
function rootOf(file, dirs) {
  return dirs.find((dir) => {
    const relative = path.relative(dir, file);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

export async function readCodexSession(file, dirs = codexSessionDirs()) {
  const session = {
    client: "codex",
    file,
    sessionId: null,
    cwd: null,
    entries: [],
    skip: null,
    automated: false,
  };
  let turn = null;
  let cwd = null;
  const closeTurn = () => {
    if (!turn) return;
    if (turn.prompts.length) {
      session.entries.push({ role: "user", text: turn.prompts.join("\n"), occurredAt: turn.promptAt, cwd: turn.cwd });
      if (turn.reply) {
        session.entries.push({ role: "assistant", text: turn.reply, occurredAt: turn.replyAt || turn.promptAt, cwd: turn.cwd });
      }
    }
    turn = null;
  };
  const openTurn = () => {
    closeTurn();
    turn = { prompts: [], promptAt: null, reply: "", replyAt: null, cwd };
  };

  for await (const row of jsonRows(file, rootOf(file, dirs))) {
    if (row === CORRUPT_ROW) {
      // A lost row may have started the next turn: end this one here.
      closeTurn();
      continue;
    }
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
      // `codex exec` runs are scripted, like Claude Code's Agent SDK runs.
      session.automated = payload.source === "exec";
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
        // Input typed while Codex works joins the running turn. Codex can
        // deliver a cut-off copy of it just before the full text; keep only
        // the text no other message of the turn already contains as a start.
        if (!turn.prompts.some((earlier) => earlier.startsWith(text))) {
          turn.prompts = turn.prompts.filter((earlier) => !text.startsWith(earlier));
          turn.prompts.push(text);
        }
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
