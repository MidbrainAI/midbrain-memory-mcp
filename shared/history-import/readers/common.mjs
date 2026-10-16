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
