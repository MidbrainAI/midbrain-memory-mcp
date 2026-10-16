/**
 * OpenCode history reader (issue #75).
 *
 * OpenCode 1.x keeps every session in one SQLite database,
 * `$XDG_DATA_HOME/opencode/opencode.db` (default `~/.local/share`): `session`
 * rows (`directory` is the cwd, `parent_id` marks a subagent session),
 * `message` rows (`data` JSON with `role`; an assistant message's `parentID`
 * is the user message it answers) and `part` rows (`data` JSON: `text`,
 * `tool`, `reasoning`, ...).
 *
 * A turn is a user message's typed text parts (not `synthetic` or `ignored`)
 * and the text of the last finished assistant message that answers it. A
 * step that ended in tool calls carries no reply. `opencode run` stores a
 * session permission that denies the `question` tool; those sessions are
 * marked automated, like Claude Code's `-p` runs. The permission is set per
 * session, so a run session later continued in the TUI counts as automated
 * too. Archived sessions are history like any other and are read.
 */

import os from "node:os";
import path from "node:path";

import {
  databaseSource, loadSqlite, parseDatabaseSource, regularFiles, withReadOnlyDatabase,
} from "./common.mjs";

export function openCodeDatabase(env = process.env) {
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "opencode.db");
}

/** One source per session. Without `node:sqlite` the database itself is listed (unreadable). */
export function listOpenCodeSessions(file = openCodeDatabase()) {
  const [database] = regularFiles(path.dirname(file), (name) => name === path.basename(file));
  if (!database) return [];
  if (!loadSqlite()) return [database];
  try {
    return withReadOnlyDatabase(database, (db) => db
      .prepare("SELECT id FROM session ORDER BY time_created, id")
      .all()
      .map((row) => databaseSource(database, row.id)));
  } catch {
    return [database]; // unreadable: the preview reports it
  }
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function msToIso(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
}

/** `opencode run` denies the interactive tools (question, plan mode) for its session. */
function isHeadless(permission) {
  const rules = Array.isArray(permission) ? permission : parseJson(permission);
  return Array.isArray(rules) && rules.some((rule) => rule?.permission === "question" && rule?.action === "deny");
}

function partsText(parts, { finalOnly = false } = {}) {
  let texts = parts.filter((part) => part.type === "text" && typeof part.text === "string" && !part.synthetic && !part.ignored);
  // OpenAI models mark interim commentary; keep the final answer when marked.
  if (finalOnly && texts.some((part) => part.metadata?.openai?.phase === "final_answer")) {
    texts = texts.filter((part) => part.metadata?.openai?.phase === "final_answer");
  }
  return texts.map((part) => part.text).join("\n").trim();
}

/** @returns {Promise<import("../plan.mjs").ImportSession>} */
export async function readOpenCodeSession(source) {
  const { file, id } = parseDatabaseSource(source);
  const session = { client: "opencode", file: source, sessionId: id, cwd: null, entries: [], skip: null, automated: false };
  withReadOnlyDatabase(file, (db) => {
    const row = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
    if (!row) {
      session.skip = "no session id";
      return;
    }
    session.cwd = typeof row.directory === "string" ? row.directory : null;
    if (row.parent_id) {
      session.skip = "subagent session";
      return;
    }
    session.automated = isHeadless(row.permission);

    const messages = db.prepare("SELECT id, time_created, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created, id")
      .all(id)
      .map((message) => ({ ...message, data: parseJson(message.data) ?? {} }));
    const parts = new Map();
    for (const part of db.prepare("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY id").all(id)) {
      const data = parseJson(part.data);
      if (!data) continue;
      if (!parts.has(part.message_id)) parts.set(part.message_id, []);
      parts.get(part.message_id).push(data);
    }
    const lastPart = db.prepare("SELECT MAX(time_updated) AS at FROM part WHERE session_id = ?").get(id)?.at;
    session.lastWrittenMs = Math.max(
      ...[row.time_updated, lastPart, ...messages.map((message) => message.time_updated)].map(Number).filter(Number.isFinite),
      0,
    );

    // The reply to each user message: its last finished assistant message with text.
    // Each user message belongs to the typed prompt it continues: a
    // compaction or synthetic continuation (no typed text) belongs to the
    // last typed prompt before it, so the reply after it ends that turn.
    const typedText = new Map();
    const owner = new Map();
    let currentPrompt = null;
    for (const message of messages) {
      if (message.data.role !== "user") continue;
      const own = parts.get(message.id) ?? [];
      const text = own.some((part) => part.type === "compaction") ? "" : partsText(own);
      if (text) {
        typedText.set(message.id, text);
        currentPrompt = message.id;
      }
      owner.set(message.id, text ? message.id : currentPrompt);
    }

    const replies = new Map();
    for (const message of messages) {
      const data = message.data;
      // A reply the user interrupted keeps its text, as live capture stored it.
      const failed = data.error && data.error.name !== "MessageAbortedError";
      if (data.role !== "assistant" || !data.parentID || failed || data.summary === true) continue;
      if (data.mode === "compaction" || data.agent === "compaction") continue;
      if (data.finish === "tool-calls" || !(data.time?.completed ?? data.error)) continue;
      const text = partsText(parts.get(message.id) ?? [], { finalOnly: true });
      const prompt = owner.get(data.parentID) ?? data.parentID;
      if (!text || !prompt) continue;
      replies.set(prompt, { text, at: msToIso(data.time.completed ?? data.time.created), cwd: data.path?.cwd });
    }

    for (const message of messages) {
      const data = message.data;
      const text = typedText.get(message.id);
      const at = msToIso(data.time?.created ?? message.time_created);
      if (!text || !at) continue;
      const reply = replies.get(message.id);
      const cwd = reply?.cwd || session.cwd || undefined;
      session.entries.push({ role: "user", text, occurredAt: at, cwd });
      if (reply?.text && reply.at) session.entries.push({ role: "assistant", text: reply.text, occurredAt: reply.at, cwd });
    }
  });
  return session;
}
