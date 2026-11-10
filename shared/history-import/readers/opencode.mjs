/**
 * OpenCode history reader (issue #75).
 *
 * OpenCode 1.x keeps every session in one SQLite database in
 * `$XDG_DATA_HOME/opencode` (default `~/.local/share`): `opencode.db`, or
 * `opencode-<channel>.db` for a build outside the latest, beta and prod
 * channels, or the file `OPENCODE_DB` names. It has `session`
 * rows (`directory` is the cwd, `parent_id` marks a subagent session),
 * `message` rows (`data` JSON with `role`; an assistant message's `parentID`
 * is the user message it answers) and `part` rows (`data` JSON: `text`,
 * `tool`, `reasoning`, ...).
 *
 * A turn is a user message's typed text parts (not `synthetic` or `ignored`)
 * and the text of the last finished assistant message that answers it. A
 * step that ended in tool calls carries no reply. `opencode run` stores a
 * session permission that denies the `question` tool; those sessions are
 * marked automated, like Claude Code's `-p` runs. The permission is set when
 * the session is created, so it only tells that `opencode run` created the
 * session: a run session later continued in the TUI counts as automated
 * too, and turns `opencode run --session` or `--continue` adds to an
 * interactive session are not detected (nothing stored marks them).
 * Archived sessions are history like any other and are read.
 */

import os from "node:os";
import path from "node:path";

import {
  databaseSource, loadSqlite, parseDatabaseSource, regularFiles, withReadOnlyDatabase,
} from "./common.mjs";

// opencode.db, or a channel build's opencode-<channel>.db (not the -wal and -shm files).
const DATABASE_NAME = /^opencode(-[A-Za-z0-9._-]+)?\.db$/;
// Media in a replayed prompt (see readOpenCodeSession).
const ATTACHED_NOTE = /^\[Attached [^\]]*\]$/;

export function openCodeDataDir(env = process.env) {
  const dataHome = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode");
}

/**
 * Every database OpenCode may have used. Which one a run used depends on its
 * build channel and environment, unknown here, so all are read: each
 * opencode*.db in the data dir, and `OPENCODE_DB` resolved as OpenCode's
 * database.ts does (absolute, or relative to the data dir; ":memory:"
 * stores nothing and names no file).
 */
export function listOpenCodeDatabases(env = process.env) {
  const dataDir = openCodeDataDir(env);
  const databases = regularFiles(dataDir, (name) => DATABASE_NAME.test(name));
  const custom = env.OPENCODE_DB;
  if (custom) {
    const file = path.isAbsolute(custom) ? custom : path.join(dataDir, custom);
    databases.push(...regularFiles(path.dirname(file), (name) => name === path.basename(file)));
  }
  return [...new Set(databases)];
}

/**
 * One source per session. A session in two databases (`OPENCODE_DB` naming a
 * copy) is listed once, from the database that wrote it last. Without
 * `node:sqlite`, or when it cannot be read, a database is listed as is, so
 * the preview reports it unreadable.
 */
export function listOpenCodeSessions(databases = listOpenCodeDatabases()) {
  if (!loadSqlite()) return databases;
  const latest = new Map();
  const unreadable = [];
  for (const database of databases) {
    let rows;
    try {
      rows = withReadOnlyDatabase(database, (db) => db.prepare("SELECT id, time_updated FROM session ORDER BY time_created, id").all());
    } catch {
      unreadable.push(database);
      continue;
    }
    for (const row of rows) {
      const updated = Number(row.time_updated) || 0;
      if (!latest.has(row.id) || updated > latest.get(row.id).updated) {
        latest.set(row.id, { source: databaseSource(database, row.id), updated });
      }
    }
  }
  return [...[...latest.values()].map((session) => session.source), ...unreadable];
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

function withoutAttachedNotes(text) {
  return text.split("\n").filter((line) => !ATTACHED_NOTE.test(line)).join("\n").trim();
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

    const messages = db.prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id")
      .all(id)
      .map((message) => ({ ...message, data: parseJson(message.data) ?? {} }));
    const parts = new Map();
    for (const part of db.prepare("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY id").all(id)) {
      const data = parseJson(part.data);
      if (!data) continue;
      if (!parts.has(part.message_id)) parts.set(part.message_id, []);
      parts.get(part.message_id).push(data);
    }
    const { at: lastWrite } = db.prepare(
      "SELECT MAX(at) AS at FROM (SELECT MAX(time_updated) AS at FROM message WHERE session_id = ? "
      + "UNION ALL SELECT MAX(time_updated) FROM part WHERE session_id = ?)",
    ).get(id, id);
    session.lastWrittenMs = Math.max(Number(row.time_updated) || 0, Number(lastWrite) || 0);

    // The reply to each user message: its last finished assistant message with text.
    // Each user message belongs to the typed prompt it continues: a
    // compaction or synthetic continuation (no typed text) belongs to the
    // last typed prompt before it, so the reply after it ends that turn.
    // After an automatic compaction for an overflow, OpenCode replays the
    // prompt as a new message with copies of its parts (compaction.ts), media
    // as "[Attached <mime>: <name>]": it belongs to the prompt it copies. A
    // prompt the person types again right after such a compaction, when
    // OpenCode had nothing to replay, joins the turn too (same text, and the
    // reply is kept).
    const typedText = new Map();
    const owner = new Map();
    let currentPrompt = null;
    let afterOverflow = false;
    for (const message of messages) {
      if (message.data.role !== "user") continue;
      const own = parts.get(message.id) ?? [];
      const compaction = own.find((part) => part.type === "compaction");
      let text = compaction ? "" : partsText(own);
      if (afterOverflow && text) {
        const copy = withoutAttachedNotes(text);
        if (!copy || copy === withoutAttachedNotes(typedText.get(currentPrompt) ?? "")) text = "";
      }
      afterOverflow = Boolean(compaction?.auto && compaction?.overflow);
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
