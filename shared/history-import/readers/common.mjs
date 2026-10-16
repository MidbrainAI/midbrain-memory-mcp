/**
 * Shared helpers for the history readers (issue #75).
 *
 * Each reader turns one client session into the same entries live capture
 * would have stored for it: the user's prompts and the reply that ended each
 * turn, with the time each was written. Tool calls, tool output, injected
 * context, subagent threads and harness-generated messages are left out, so
 * an imported session looks like a captured one.
 *
 * Readers only read. They never follow symlinks out of the client's history
 * directory and never touch the network.
 *
 * @typedef {object} ImportEntry
 * @property {"user"|"assistant"} role
 * @property {string} text
 * @property {string} occurredAt ISO timestamp of the original message.
 * @property {string} [cwd] Working directory of the turn.
 *
 * @typedef {object} ImportSession
 * @property {string} client      Client label (`claude`, `codex`, ...).
 * @property {string} file        Session file, or `<database>#<session id>`.
 * @property {string|null} sessionId
 * @property {string|null} cwd    Working directory the session started in.
 * @property {ImportEntry[]} entries
 * @property {string|null} skip   Why the whole session is skipped, if it is.
 * @property {boolean} [automated] Every prompt came from a program (an SDK
 *   or orchestrator), none from a person at the client's own interface.
 * @property {string[]} [linkedSessionIds] Other ids live capture may have
 *   stored this conversation under (checked for live captures too).
 * @property {number} [lastWrittenMs] When the session was last written, for
 *   sessions that are not one file (the planner uses the file's mtime
 *   otherwise).
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import readline from "node:readline";

/** Regular files (no symlinks) directly inside `dir` matching `test`. */
export function regularFiles(dir, test) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((entry) => entry.isFile() && test(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

export async function* jsonRows(file) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === "object") yield row;
      } catch {
        // A torn or corrupt line: skip it, keep the rest of the session.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

export function validTimestamp(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

// ------------------------------------------------------------------- SQLite

let sqliteModule;

/**
 * Node's built-in SQLite (`node:sqlite`, without a flag from Node 22.13), or
 * null when this Node has none. Its one-time "experimental" warning is not shown.
 */
export function loadSqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const text = typeof warning === "string" ? warning : warning?.message;
    if (/SQLite/i.test(String(text))) return;
    emit.call(process, warning, ...rest);
  };
  try {
    sqliteModule = createRequire(import.meta.url)("node:sqlite");
  } catch {
    sqliteModule = null;
  } finally {
    process.emitWarning = emit;
  }
  return sqliteModule;
}

/**
 * Open a client's database read-only, in place, and run `fn(db)`. SQLite
 * lets this reader run next to the client that writes it. Throws when this
 * Node has no SQLite or the file cannot be opened.
 */
export function withReadOnlyDatabase(file, fn) {
  const sqlite = loadSqlite();
  if (!sqlite) throw Object.assign(new Error("needs Node 22.13 or later (node:sqlite)"), { code: "NO_SQLITE" });
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** `<database>#<id>`: the `file` of a session stored in a database. */
export function databaseSource(file, id) {
  return `${file}#${id}`;
}

/** Split a source made by `databaseSource`. */
export function parseDatabaseSource(source) {
  const at = source.lastIndexOf("#");
  return { file: source.slice(0, at), id: source.slice(at + 1) };
}
