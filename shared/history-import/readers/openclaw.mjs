/**
 * OpenClaw history reader (issue #75).
 *
 * OpenClaw 2026.9 keeps each agent's transcripts in SQLite:
 * `<state dir>/agents/<agent>/agent/openclaw-agent.sqlite`. A session is a
 * row of `session_windows` (its `session_id` is the id live capture stores);
 * its events are `transcript_events` rows in `seq` order, as JSON or
 * zstd-compressed JSON: a `session` header with the `cwd`, then `message`
 * events (`user`, `assistant`, tool results).
 *
 * A turn is a user message with text and the last assistant text before the
 * next one, as live capture stores it from `agent_end`. Cron, heartbeat,
 * hook, plugin and spawned (subagent) sessions are skipped: live capture
 * stores only runs a person started.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { openclawStateDir } from "../../clients/openclaw.mjs";
import { claudeProjectsDir, readClaudeSession } from "./claude.mjs";
import {
  databaseSource, loadSqlite, parseDatabaseSource, regularFiles, validTimestamp, withReadOnlyDatabase,
} from "./common.mjs";

const DATABASE_NAME = "openclaw-agent.sqlite";
const AUTOMATED_CREATORS = new Set(["cron", "internal", "plugin"]);
const AUTOMATED_KEY = /:(?:cron|heartbeat|hook)(?::|$)/i;
const SUBAGENT_KEY = /:(?:subagent|acp)(?::|$)/i;
// A heartbeat run's reply: the whole turn was a heartbeat, not a person.
const HEARTBEAT_REPLY = "HEARTBEAT_OK";
// The reply to a turn that needs no answer.
const NO_REPLY = "NO_REPLY";
// OpenClaw's inbound envelope: "[Mon 2026-10-05 09:00 ...] text".
const TIMESTAMP_ENVELOPE = /^\[[^\]\n]*\d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]\n]*\]\s*/;

/** Every agent's transcript database under the state dir. */
export function listOpenClawDatabases(stateDir = openclawStateDir()) {
  const agents = path.join(stateDir, "agents");
  let names;
  try {
    names = fs.readdirSync(agents, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => regularFiles(path.join(agents, entry.name, "agent"), (name) => name === DATABASE_NAME));
}

/**
 * One source per session window, `<database>#<session id>`. Without
 * `node:sqlite` each database is listed as is, so the preview reports it as
 * unreadable (NO_SQLITE) instead of finding nothing.
 */
export function listOpenClawSessions(databases = listOpenClawDatabases()) {
  if (!loadSqlite()) return databases;
  return databases.flatMap((file) => {
    try {
      return withReadOnlyDatabase(file, (db) => db
        .prepare("SELECT session_id FROM session_windows ORDER BY created_at, session_id")
        .all()
        .map((row) => databaseSource(file, row.session_id)));
    } catch {
      // Unreadable: list it as is, so the preview reports it unreadable.
      return [file];
    }
  });
}

function decodeEvent(row) {
  if (!row.event_json && row.event_zstd && typeof zlib.zstdDecompressSync !== "function") {
    // Dropping compressed events would mispair turns; report the session.
    throw Object.assign(new Error("needs Node 22.15 or later (zstd)"), { code: "NO_ZSTD" });
  }
  try {
    if (typeof row.event_json === "string") return JSON.parse(row.event_json);
    if (row.event_zstd) return JSON.parse(zlib.zstdDecompressSync(Buffer.from(row.event_zstd)).toString("utf8"));
  } catch { /* a corrupt event is skipped */ }
  return null;
}

function parseEntry(json) {
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function skipReason(window, node) {
  const key = String(window.session_key ?? "");
  if (window.parent_session_key || window.spawned_by || node?.parent_session_key || node?.spawned_by
    || node?.created_via === "spawn" || SUBAGENT_KEY.test(key) || window.acp_owned) {
    return "subagent session";
  }
  if (AUTOMATED_CREATORS.has(node?.created_via) || node?.created_actor_type === "agent"
    || node?.created_actor_type === "system" || window.hook_external_content_source
    || window.plugin_owner_id || AUTOMATED_KEY.test(key)) {
    return "automated (cron, hook or plugin run)";
  }
  return null;
}

const LINK_WINDOW_MS = 2 * 60_000;
const backendSessions = new Map();

/**
 * Claude Code sessions OpenClaw's claude-cli backend ran in `cwd`: Claude
 * Code keeps them under `projects/<cwd with non-alphanumerics as "-">`.
 * Read once per directory and run.
 */
async function claudeBackendSessions(cwd, projectsDir) {
  const dir = path.join(projectsDir, cwd.replace(/[^A-Za-z0-9]/g, "-"));
  if (!backendSessions.has(dir)) {
    backendSessions.set(dir, (async () => {
      const sessions = [];
      for (const file of regularFiles(dir, (name) => name.endsWith(".jsonl"))) {
        try {
          const session = await readClaudeSession(file, projectsDir);
          if (session.sessionId) sessions.push(session);
        } catch { /* unreadable: no link */ }
      }
      return sessions;
    })());
  }
  return backendSessions.get(dir);
}

/**
 * Link the Claude Code session that holds one of this session's prompts,
 * written within two minutes of it (the backend adds an envelope). OpenClaw
 * does not always record the link (`cliSessionIds`).
 */
async function linkClaudeBackend(session, projectsDir) {
  if (!session.cwd || session.entries.length === 0 || session.linkedSessionIds?.length) return;
  const prompts = session.entries.filter((entry) => entry.role === "user" && entry.text.length >= 12);
  for (const backend of await claudeBackendSessions(session.cwd, projectsDir)) {
    const match = backend.entries.some((entry) => entry.role === "user" && prompts.some((prompt) => (
      entry.text.includes(prompt.text)
      && Math.abs(Date.parse(entry.occurredAt) - Date.parse(prompt.occurredAt)) <= LINK_WINDOW_MS
    )));
    if (match && backend.sessionId !== session.sessionId) {
      session.linkedSessionIds = [...new Set([...(session.linkedSessionIds ?? []), backend.sessionId])];
    }
  }
}

/** @returns {Promise<import("../plan.mjs").ImportSession>} */
export async function readOpenClawSession(source, { claudeProjects = claudeProjectsDir() } = {}) {
  const { file, id } = parseDatabaseSource(source);
  const session = { client: "openclaw", file: source, sessionId: id, cwd: null, entries: [], skip: null };
  withReadOnlyDatabase(file, (db) => {
    const window = db.prepare("SELECT * FROM session_windows WHERE session_id = ?").get(id);
    if (!window) {
      session.skip = "no session id";
      return;
    }
    const node = window.session_key
      ? db.prepare("SELECT * FROM session_nodes WHERE session_key = ?").get(window.session_key)
      : undefined;
    const lastEvent = db.prepare("SELECT MAX(created_at) AS at FROM transcript_events WHERE session_id = ?").get(id)?.at;
    session.lastWrittenMs = Math.max(
      ...[window.updated_at, window.transcript_updated_at, lastEvent].map(Number).filter(Number.isFinite),
      0,
    );
    session.skip = skipReason(window, node);
    if (session.skip) return;
    // A session on a CLI backend (claude-cli) also lives in that client's own
    // session, which its hooks may have captured live under that id.
    const entry = parseEntry(node?.entry_json);
    const linked = Object.values(entry?.cliSessionIds ?? {}).filter((value) => typeof value === "string" && value && value !== id);
    if (linked.length) session.linkedSessionIds = [...new Set(linked)];

    const rows = db.prepare(
      "SELECT event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq",
    ).all(id);
    let startedAt;
    let turn = null;
    const seenPrompts = new Set();
    const closeTurn = () => {
      if (!turn || turn.heartbeat) {
        turn = null;
        return;
      }
      session.entries.push({ role: "user", text: turn.prompt, occurredAt: turn.at, cwd: session.cwd ?? undefined });
      if (turn.reply) {
        session.entries.push({ role: "assistant", text: turn.reply, occurredAt: turn.replyAt, cwd: session.cwd ?? undefined });
      }
      turn = null;
    };
    for (const row of rows) {
      const event = decodeEvent(row);
      if (!event) continue;
      if (event.type === "session") {
        if (typeof event.cwd === "string") session.cwd = event.cwd;
        startedAt = Date.parse(event.timestamp ?? "");
        continue;
      }
      if (event.type !== "message") continue;
      const at = validTimestamp(event.timestamp);
      if (!at) continue;
      // A forked window starts with a copy of the parent's earlier events.
      if (window.reason === "fork" && Number.isFinite(startedAt) && Date.parse(at) < startedAt) continue;
      const message = event.message;
      const text = messageText(message);
      if (message?.role === "user" && text) {
        // A retried send repeats the prompt with the same idempotency key.
        const retryKey = message.idempotencyKey;
        if (retryKey && seenPrompts.has(retryKey)) continue;
        if (retryKey) seenPrompts.add(retryKey);
        closeTurn();
        turn = { prompt: text.replace(TIMESTAMP_ENVELOPE, "").trim(), at, reply: "", replyAt: null };
        if (!turn.prompt) turn = null;
      } else if (message?.role === "assistant" && text && turn) {
        if (text === HEARTBEAT_REPLY) {
          turn.heartbeat = true; // live capture skips heartbeat runs
        } else if (text === NO_REPLY) {
          turn.reply = "";
          turn.replyAt = null;
        } else {
          turn.reply = text;
          turn.replyAt = at;
        }
      }
    }
    closeTurn();
  });
  if (!session.skip) await linkClaudeBackend(session, claudeProjects);
  return session;
}
