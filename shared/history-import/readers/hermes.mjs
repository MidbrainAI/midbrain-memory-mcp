/**
 * Hermes Agent history reader (issue #75).
 *
 * Hermes keeps sessions in SQLite: `$HERMES_HOME/state.db` (default
 * `~/.hermes`), plus one `state.db` per profile under `profiles/<name>/`.
 * `sessions` rows carry the `source` (cli, telegram, cron, subagent,
 * oneshot, ...) and `cwd`; `messages` rows carry the `role`, the stored
 * `content` and a `timestamp` in seconds.
 *
 * `content` is what the person typed. Context added for the model, including
 * MidBrain's own hook context, is stored separately in `api_content`, which
 * is never read. A turn is a user message (no `display_kind`) and the last
 * assistant message with text and no tool calls before the next one. A
 * `/steer` typed while the agent works continues the turn, and its words are
 * added to the prompt (as the Codex reader does); auto-continue and notices
 * end it. Rewound rows (`active` = 0) and compression summaries are left out.
 */

import os from "node:os";
import path from "node:path";

import {
  databaseSource, isSymlink, loadSqlite, parseDatabaseSource, regularFiles, subdirectories, withReadOnlyDatabase,
} from "./common.mjs";

const DATABASE_NAME = "state.db";
const SUBAGENT_SOURCES = new Set(["subagent", "delegate"]);
// Runs nobody typed: scheduled jobs, `hermes -z` one-shots, tools and boards.
const AUTOMATED_SOURCES = new Set(["cron", "oneshot", "tool", "kanban", "api_server", "webhook", "batch"]);
const JSON_PREFIX = "\u0000json:";
// Hermes stores a /steer's content wrapped in this marker (steer_user_row,
// agent/prompt_builder.py); older rows hold the plain words.
const STEER_OPEN = "[OUT-OF-BAND USER MESSAGE";
const STEER_CLOSE = "[/OUT-OF-BAND USER MESSAGE]";

export function hermesHome(env = process.env) {
  return env.HERMES_HOME?.trim() || path.join(os.homedir(), ".hermes");
}

/** The main database and each profile's. */
export function listHermesDatabases(home = hermesHome()) {
  const profiles = path.join(home, "profiles");
  return [home, ...(isSymlink(profiles) ? [] : subdirectories(profiles))]
    .flatMap((dir) => regularFiles(dir, (name) => name === DATABASE_NAME));
}

/**
 * One source per session. Without `node:sqlite`, or when it cannot be read,
 * a database is listed as is, so the preview reports it unreadable.
 */
export function listHermesSessions(databases = listHermesDatabases()) {
  if (!loadSqlite()) return databases;
  return databases.flatMap((file) => {
    try {
      return withReadOnlyDatabase(file, (db) => db
        .prepare("SELECT id FROM sessions ORDER BY started_at, id")
        .all()
        .map((row) => databaseSource(file, row.id)));
    } catch {
      return [file];
    }
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Stored content: plain text, or `\0json:` and a list of content parts. */
function contentText(raw) {
  const content = raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : raw;
  if (typeof content !== "string") return "";
  if (!content.startsWith(JSON_PREFIX)) return content.trim();
  const parts = parseJson(content.slice(JSON_PREFIX.length));
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** The words inside a /steer marker, as Hermes shows them; "" without one. */
function steerText(text) {
  const start = text.indexOf(STEER_OPEN);
  const lineEnd = start === -1 ? -1 : text.indexOf("\n", start);
  const end = lineEnd === -1 ? -1 : text.indexOf(STEER_CLOSE, lineEnd);
  return end === -1 ? "" : text.slice(lineEnd + 1, end).trim();
}

/**
 * How many of a compression child's first rows copy its parent. Hermes
 * starts the child with the parent's protected head (first compression
 * only), the summary (not read) and the protected tail
 * (agent/context_compressor.py): the longest start of the child equal to the
 * start of the parent, then the longest run after it equal, in order, to the
 * end of the parent. A prompt the person repeats after the copy is neither,
 * so it stays.
 */
function copiedRows(parent, child) {
  const key = (message) => `${message.role}\0${contentText(message.content)}`;
  const p = parent.map(key);
  const c = child.map(key);
  let head = 0;
  while (head < p.length && head < c.length && c[head] === p[head]) head++;
  for (let start = Math.max(head, p.length - (c.length - head)); start < p.length; start++) {
    let i = 0;
    while (start + i < p.length && p[start + i] === c[head + i]) i++;
    if (start + i === p.length) return head + i;
  }
  return head;
}

function secondsToIso(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

function hasToolCalls(value) {
  if (!value) return false;
  const calls = typeof value === "string" ? parseJson(value) : value;
  return Array.isArray(calls) ? calls.length > 0 : Boolean(calls);
}

/**
 * A session's live user and assistant rows, oldest first (tool rows play no
 * part in a turn). Older state.db files lack some columns; a missing
 * `active` means active, a missing `display_kind` none.
 */
function readMessages(db, id) {
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('messages')").all().map((column) => column.name));
  const pick = (name, fallback) => (columns.has(name) ? name : `${fallback} AS ${name}`);
  const where = ["session_id = ?", "role IN ('user', 'assistant')"];
  if (columns.has("active")) where.push("COALESCE(active, 1) = 1");
  if (columns.has("_compressed_summary")) where.push("COALESCE(_compressed_summary, 0) = 0");
  return db.prepare(
    // As a blob: node:sqlite returns text that starts with NUL ("\0json:") as "".
    `SELECT role, CAST(content AS BLOB) AS content, ${pick("tool_calls", "NULL")}, timestamp, ${pick("display_kind", "NULL")} `
    + `FROM messages WHERE ${where.join(" AND ")} ORDER BY id`,
  ).all(id);
}

function skipReason(row) {
  const config = typeof row.model_config === "string" ? parseJson(row.model_config) : null;
  if (SUBAGENT_SOURCES.has(row.source) || config?._delegate_from) return "subagent session";
  if (row.hidden) return "hidden in Hermes";
  return null;
}

/** @returns {Promise<import("../plan.mjs").ImportSession>} */
export async function readHermesSession(source) {
  const { file, id } = parseDatabaseSource(source);
  const session = { client: "hermes", file: source, sessionId: id, cwd: null, entries: [], skip: null, automated: false };
  withReadOnlyDatabase(file, (db) => {
    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    if (!row) {
      session.skip = "no session id";
      return;
    }
    session.cwd = typeof row.cwd === "string" && row.cwd ? row.cwd : null;
    session.skip = skipReason(row);
    if (session.skip) return;
    session.automated = AUTOMATED_SOURCES.has(row.source);

    const messages = readMessages(db, id);
    // A session continued after compression starts with copies of the
    // parent's rows; those turns belong to (and are imported with) the parent.
    let parent = null;
    try {
      if (row.parent_session_id) parent = db.prepare("SELECT end_reason FROM sessions WHERE id = ?").get(row.parent_session_id);
    } catch { /* older state.db: no end_reason, no compression chains */ }
    if (parent?.end_reason === "compression") messages.splice(0, copiedRows(readMessages(db, row.parent_session_id), messages));
    // Every row counts, rewound and tool rows too: each is a write.
    const { at: lastMessage } = db.prepare("SELECT MAX(timestamp) AS at FROM messages WHERE session_id = ?").get(id);
    session.lastWrittenMs = 1000 * Math.max(
      ...[row.last_activity_at, row.started_at, row.ended_at, lastMessage].map(Number).filter(Number.isFinite),
      0,
    );

    let turn = null;
    const cwd = session.cwd ?? undefined;
    const closeTurn = () => {
      if (!turn) return;
      session.entries.push({ role: "user", text: turn.prompt, occurredAt: turn.at, cwd });
      if (turn.reply) session.entries.push({ role: "assistant", text: turn.reply, occurredAt: turn.replyAt, cwd });
      turn = null;
    };
    for (const message of messages) {
      const at = secondsToIso(message.timestamp);
      const text = contentText(message.content);
      if (message.role === "user" && !message.display_kind) {
        // Every typed row ends the turn, even one with no text (an image).
        closeTurn();
        if (at && text) turn = { prompt: text, at, reply: "", replyAt: null, closed: false };
      } else if (message.role === "user" && turn && message.display_kind === "steer") {
        // Typed while the agent works: the final answer still ends this turn.
        const steer = steerText(text) || text;
        if (steer) turn.prompt += `\n${steer}`;
      } else if (message.role === "user" && turn) {
        // Auto-continue and notices: what follows answers them, not the
        // typed prompt, whose reply is the one before.
        turn.closed = true;
      } else if (message.role === "assistant" && turn && !turn.closed && at && text
        && !message.display_kind && !hasToolCalls(message.tool_calls)) {
        turn.reply = text;
        turn.replyAt = at;
      }
    }
    closeTurn();
  });
  return session;
}
