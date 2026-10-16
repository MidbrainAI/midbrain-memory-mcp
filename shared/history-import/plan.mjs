/**
 * History import planning and upload (issue #75).
 *
 * plan:   read local sessions, apply the user's filters, and decide per
 *         session what would be imported. No network.
 * check:  ask MidBrain which of those sessions it already has (live capture or
 *         an earlier import) and trim them, so nothing is stored twice.
 * upload: post the remaining entries with their original timestamps, labeled
 *         `origin: import` with a stable `import_id`, throttled. MidBrain
 *         itself is the record of what was imported: a re-run (after an
 *         interruption, or with wider filters) skips every entry whose
 *         `import_id` is already stored, so no local state is needed.
 */

import crypto from "node:crypto";
import fs from "node:fs";

import { buildCaptureMetadata } from "../capture-metadata.mjs";
import { stripInjectedContext } from "../pk-inject.mjs";

/**
 * The session shape every history reader returns (readers/).
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

/**
 * `memory_metadata.origin` of imported entries. Not `source`: search results
 * read `source` as a semantic document path (see mcp.mjs).
 */
export const IMPORT_ORIGIN = "import";
export const MAX_TEXT_CHARS = 100_000;
const TRUNCATED = "\n[truncated by MidBrain import]";
/** A session file written this recently may still be in use. */
export const ACTIVE_SESSION_MS = 10 * 60 * 1000;

export function sessionKey(session) {
  return `${session.client}:${session.sessionId}`;
}

/**
 * Stable id for one imported entry, from what identifies it in the source
 * log, so the same entry gets the same id on every run whatever the filters.
 */
export function importId(session, entry) {
  return crypto.createHash("sha256")
    .update(`${session.client}\0${session.sessionId}\0${entry.role}\0${entry.occurredAt}`)
    .digest("hex")
    .slice(0, 24);
}

/** Clean one entry's text the way it will be stored. */
export function prepareText(text) {
  const trimmed = stripInjectedContext(text).trim();
  if (trimmed.length <= MAX_TEXT_CHARS) return { text: trimmed, truncated: false };
  return { text: trimmed.slice(0, MAX_TEXT_CHARS - TRUNCATED.length) + TRUNCATED, truncated: true };
}

/**
 * Read and filter local sessions. Pure apart from reading the session files.
 *
 * @param {object} opts
 * @param {Record<string, {list: () => string[] | Promise<string[]>, read: (file: string) => Promise<any>}>} opts.readers
 *   `list()` returns [] when the client has no history and throws when its
 *   history cannot be read.
 * @param {string[]} opts.clients
 * @param {string|null} [opts.since] ISO date; entries before it are left out.
 * @param {number} [opts.now]
 * @param {(file: string) => number} [opts.mtimeMs]
 */
export async function planImport({
  readers,
  clients,
  since = null,
  now = Date.now(),
  mtimeMs = (file) => fs.statSync(file).mtimeMs,
}) {
  const sessions = [];
  for (const client of clients) {
    const reader = readers[client];
    if (!reader) continue;
    let files;
    try {
      files = await reader.list();
    } catch (error) {
      // History that exists but cannot be read is reported, never shown as
      // empty. A reader returns [] only when the client has no history.
      const where = error.path ? `: ${error.path}` : "";
      sessions.push({ client, file: error.path ?? "", sessionId: null, cwd: null, entries: [], skip: `could not list history (${error.code || "error"}${where})` });
      continue;
    }
    for (const file of files) {
      let session;
      try {
        session = await reader.read(file);
      } catch (error) {
        sessions.push({ client, file, sessionId: null, cwd: null, entries: [], skip: `unreadable (${error.code || "error"})` });
        continue;
      }
      if (!session.skip) {
        try {
          const lastWritten = Number.isFinite(session.lastWrittenMs) ? session.lastWrittenMs : mtimeMs(file);
          if (now - lastWritten < ACTIVE_SESSION_MS) session.skip = "active (written in the last 10 minutes)";
        } catch { /* deleted while reading: keep what was read */ }
      }
      if (!session.skip && session.automated) session.skip = "automated (started by a program, not typed)";
      if (!session.skip) {
        // Every entry the reader produces, before --since narrows them: an
        // earlier import's entry outside the range is not a changed one.
        session.importIds = new Set(session.entries.map((entry) => importId(session, entry)));
        session.entries = session.entries.filter((entry) => !since || entry.occurredAt >= since);
        if (session.entries.length === 0) session.skip = "no turns in range";
      }
      sessions.push(session);
    }
  }
  return sessions;
}

/**
 * Trim sessions MidBrain already has. Each entry is checked only against what
 * its own destination (the key and host it is stored with) holds.
 * - Entries an earlier import stored (same `import_id`) are dropped, so an
 *   interrupted or repeated import picks up where it stopped.
 * - When live capture covered part of the session (MidBrain was installed
 *   during it), only the turns from before the first live capture are kept.
 *   Live capture stores a turn up to CAPTURE_LAG_MS after it happened, so
 *   the cut is made that much earlier: a turn in that window is left out
 *   rather than risk storing it twice.
 * - A session holding an imported entry the reader no longer produces is
 *   skipped whole: an earlier version read it differently (say, kept another
 *   reply for a turn), and importing the new reading would store a second
 *   reply beside the old one.
 *
 * @param {any[]} sessions planned sessions (mutated)
 * @param {(session: any) => Promise<Array<{entries: any[], existing: Array<{occurred_at: string, memory_metadata?: Record<string,string>}>}>>} listExisting
 *   For each destination, the session's entries stored there and what it holds.
 */
export async function trimAgainstServer(sessions, listExisting) {
  for (const session of sessions) {
    if (session.skip || session.entries.length === 0) continue;
    let destinations;
    try {
      destinations = await listExisting(session);
    } catch (error) {
      session.skip = `could not check MidBrain (${error.message})`;
      continue;
    }
    const checked = new Set();
    const captured = new Set();
    const imported = new Set();
    const known = session.importIds ?? new Set(session.entries.map((entry) => importId(session, entry)));
    let changed = 0;
    for (const { entries, existing } of destinations) {
      const importIds = new Set();
      let firstCaptured = Infinity;
      for (const memory of existing) {
        if (memory.memory_metadata?.origin === IMPORT_ORIGIN) {
          const id = memory.memory_metadata.import_id;
          if (id) importIds.add(id);
          if (!id || !known.has(id)) changed += 1;
          continue;
        }
        const time = validTime(memory.occurred_at);
        if (time !== null) firstCaptured = Math.min(firstCaptured, time);
      }
      const cutoff = firstCaptured - CAPTURE_LAG_MS;
      for (const entry of entries) {
        checked.add(entry);
        if (Date.parse(entry.occurredAt) >= cutoff) captured.add(entry);
        else if (importIds.has(importId(session, entry))) imported.add(entry);
      }
    }
    if (session.entries.some((entry) => !checked.has(entry))) {
      session.skip = "could not check MidBrain (an entry has no destination)";
      continue;
    }
    if (changed) {
      session.changedSinceImport = changed;
      session.skip = "changed since an earlier import (left as stored)";
      continue;
    }
    // Keep whole turns only: when the prompt or the reply was captured live,
    // the other goes too.
    session.entries.forEach((entry, index) => {
      const reply = session.entries[index + 1];
      if (entry.role !== "user" || reply?.role !== "assistant") return;
      if (captured.has(entry) || captured.has(reply)) {
        captured.add(entry).add(reply);
        imported.delete(entry);
        imported.delete(reply);
      }
    });
    session.capturedLive = captured.size;
    session.alreadyImported = imported.size;
    session.entries = session.entries.filter((entry) => !captured.has(entry) && !imported.has(entry));
    if (session.entries.length === 0) {
      session.skip = session.alreadyImported ? "already imported" : "already captured live";
    }
  }
  return sessions;
}

// How long after a turn live capture can store it (hooks, watchers, agent_end).
export const CAPTURE_LAG_MS = 5 * 60_000;

function validTime(value) {
  if (typeof value !== "string") return null;
  // The API returns naive UTC timestamps (no zone suffix).
  const time = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(time) ? null : time;
}

/** Totals for the preview. */
export function summarize(sessions) {
  const byClient = {};
  for (const session of sessions) {
    const row = byClient[session.client] ??= {
      sessions: 0, user: 0, assistant: 0, chars: 0, first: null, last: null, skipped: {},
    };
    if (session.skip) {
      row.skipped[session.skip] = (row.skipped[session.skip] || 0) + 1;
      continue;
    }
    row.sessions += 1;
    for (const entry of session.entries) {
      row[entry.role] += 1;
      row.chars += entry.text.length;
      if (!row.first || entry.occurredAt < row.first) row.first = entry.occurredAt;
      if (!row.last || entry.occurredAt > row.last) row.last = entry.occurredAt;
    }
  }
  return byClient;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STOP_REASONS = {
  outOfCredits: "out of MidBrain credits",
  rateLimited: "rate limited",
  rejected: "MidBrain rejected an entry",
  unknown: "an upload failed and may or may not have been stored",
};

/**
 * Upload planned sessions, one entry at a time, spaced. Each entry is posted
 * once and never retried: a failed write may still have been stored, and the
 * server does not enforce `import_id`. Any failure stops the upload; a re-run
 * first checks what MidBrain holds (trimAgainstServer), so it resumes without
 * storing anything twice.
 *
 * One exception: an entry the edge firewall blocks never reached MidBrain and
 * would be blocked on every run, so it is skipped and counted (`blocked`)
 * instead of stopping every run at the same entry.
 *
 * @param {object} opts
 * @param {any[]} opts.sessions
 * @param {(session: any, entry: any, metadata: Record<string,string>) => Promise<"ok"|"outOfCredits"|"rateLimited"|"blocked"|"rejected"|"unknown">} opts.post
 * @param {number} [opts.spacingMs]
 * @param {(event: object) => void} [opts.onProgress]
 * @param {(ms: number) => Promise<void>} [opts.wait]
 * @param {string} [opts.importedAt]
 */
export async function uploadImport({
  sessions,
  post,
  spacingMs = 150,
  onProgress = () => {},
  wait = sleep,
  importedAt = new Date().toISOString(),
}) {
  const totals = { sent: 0, sessions: 0, truncated: 0, blocked: [], stopped: null, stoppedOn: null };
  for (const session of sessions) {
    if (session.skip || session.entries.length === 0) continue;
    const key = sessionKey(session);
    for (const [index, entry] of session.entries.entries()) {
      const prepared = prepareText(entry.text);
      if (!prepared.text) continue;
      const metadata = {
        ...buildCaptureMetadata({ client: session.client, cwd: entry.cwd || session.cwd, sessionId: session.sessionId }),
        origin: IMPORT_ORIGIN,
        import_id: importId(session, entry),
        imported_at: importedAt,
      };
      const result = await post(session, { ...entry, text: prepared.text }, metadata);
      if (result === "blocked") {
        totals.blocked.push({ client: session.client, sessionId: session.sessionId, role: entry.role, occurredAt: entry.occurredAt });
      } else if (result !== "ok") {
        totals.stopped = STOP_REASONS[result] ?? STOP_REASONS.unknown;
        totals.stoppedOn = result;
        onProgress({ type: "stopped", session: key, reason: totals.stopped, totals });
        return totals;
      } else {
        totals.sent += 1;
        if (prepared.truncated) totals.truncated += 1;
      }
      onProgress({ type: "entry", session: key, index, total: session.entries.length, totals });
      if (spacingMs) await wait(spacingMs);
    }
    totals.sessions += 1;
    onProgress({ type: "session", session: key, totals });
  }
  return totals;
}
