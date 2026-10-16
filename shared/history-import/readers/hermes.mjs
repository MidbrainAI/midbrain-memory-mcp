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
 * is never read. A turn is a user message (no `display_kind`: steering,
 * auto-continue and notices have one) and the last assistant message with
 * text and no tool calls before the next one. Rewound rows (`active` = 0)
 * and compression summaries are left out.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  databaseSource, loadSqlite, parseDatabaseSource, regularFiles, withReadOnlyDatabase,
} from "./common.mjs";

const DATABASE_NAME = "state.db";
const SUBAGENT_SOURCES = new Set(["subagent"]);
// Runs nobody typed: scheduled jobs, `hermes -z` one-shots, tools and boards.
const AUTOMATED_SOURCES = new Set(["cron", "oneshot", "tool", "kanban"]);
const JSON_PREFIX = "\u0000json:";

export function hermesHome(env = process.env) {
  return env.HERMES_HOME?.trim() || path.join(os.homedir(), ".hermes");
}

/** The main database and each profile's. */
export function listHermesDatabases(home = hermesHome()) {
  const databases = regularFiles(home, (name) => name === DATABASE_NAME);
  let profiles = [];
  try {
    profiles = fs.readdirSync(path.join(home, "profiles"), { withFileTypes: true });
  } catch { /* no profiles */ }
  for (const profile of profiles) {
    if (profile.isDirectory()) databases.push(...regularFiles(path.join(home, "profiles", profile.name), (name) => name === DATABASE_NAME));
  }
  return databases;
}

/** One source per session. Without `node:sqlite` each database is listed (unreadable). */
export function listHermesSessions(databases = listHermesDatabases()) {
  if (!loadSqlite()) return databases;
  return databases.flatMap((file) => {
    try {
      return withReadOnlyDatabase(file, (db) => db
        .prepare("SELECT id FROM sessions ORDER BY started_at, id")
        .all()
        .map((row) => databaseSource(file, row.id)));
    } catch {
      return [];
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

function secondsToIso(seconds) {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}

function hasToolCalls(value) {
  if (!value) return false;
  const calls = typeof value === "string" ? parseJson(value) : value;
  return Array.isArray(calls) ? calls.length > 0 : Boolean(calls);
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

    const messages = db.prepare(
      // As a blob: node:sqlite returns text that starts with NUL ("\0json:") as "".
      "SELECT role, CAST(content AS BLOB) AS content, tool_calls, timestamp, display_kind FROM messages "
      + "WHERE session_id = ? AND COALESCE(active, 1) = 1 AND COALESCE(_compressed_summary, 0) = 0 ORDER BY id",
    ).all(id);
    const lastMessage = Math.max(0, ...messages.map((message) => Number(message.timestamp)).filter(Number.isFinite));
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
      if (!at || !text) continue;
      if (message.role === "user" && !message.display_kind) {
        closeTurn();
        turn = { prompt: text, at, reply: "", replyAt: null };
      } else if (message.role === "assistant" && turn && !message.display_kind && !hasToolCalls(message.tool_calls)) {
        turn.reply = text;
        turn.replyAt = at;
      }
    }
    closeTurn();
  });
  return session;
}
