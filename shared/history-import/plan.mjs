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
import path from "node:path";

import { buildCaptureMetadata } from "../capture-metadata.mjs";
import { stripInjectedContext } from "../pk-inject.mjs";
import { redactSecrets } from "../redact.mjs";

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

function underDir(cwd, dir) {
  if (!cwd || !dir) return false;
  const relative = path.relative(path.resolve(dir), path.resolve(cwd));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Clean one entry's text the way it will be stored. */
export function prepareText(text) {
  const stripped = stripInjectedContext(text);
  const { text: redacted, count } = redactSecrets(stripped);
  const trimmed = redacted.trim();
  if (trimmed.length <= MAX_TEXT_CHARS) return { text: trimmed, redactions: count, truncated: false };
  return {
    text: trimmed.slice(0, MAX_TEXT_CHARS - TRUNCATED.length) + TRUNCATED,
    redactions: count,
    truncated: true,
  };
}

/**
 * Read and filter local sessions. Pure apart from reading the session files.
 *
 * @param {object} opts
 * @param {Record<string, {list: () => string[], read: (file: string) => Promise<any>}>} opts.readers
 * @param {string[]} opts.clients
 * @param {string|null} [opts.since]   ISO date; entries before it are left out.
 * @param {string|null} [opts.until]   ISO date; entries at or after it are left out.
 * @param {string|null} [opts.project] Only sessions whose cwd is inside this dir.
 * @param {boolean} [opts.includeAutomated] Also import sessions no person typed in.
 * @param {number} [opts.now]
 * @param {(file: string) => number} [opts.mtimeMs]
 */
export async function planImport({
  readers,
  clients,
  since = null,
  until = null,
  project = null,
  includeAutomated = false,
  now = Date.now(),
  mtimeMs = (file) => fs.statSync(file).mtimeMs,
}) {
  const sessions = [];
  for (const client of clients) {
    const reader = readers[client];
    if (!reader) continue;
    for (const file of reader.list()) {
      let session;
      try {
        session = await reader.read(file);
      } catch (error) {
        sessions.push({ client, file, sessionId: null, cwd: null, entries: [], skip: `unreadable (${error.code || "error"})` });
        continue;
      }
      if (!session.skip) {
        try {
          if (now - mtimeMs(file) < ACTIVE_SESSION_MS) session.skip = "active (written in the last 10 minutes)";
        } catch { /* deleted while reading: keep what was read */ }
      }
      if (!session.skip && session.automated && !includeAutomated) session.skip = "automated (started by a program, not typed)";
      if (!session.skip && project && !underDir(session.cwd, project)) session.skip = "outside --project";
      if (!session.skip) {
        session.entries = session.entries.filter((entry) => (
          (!since || entry.occurredAt >= since) && (!until || entry.occurredAt < until)
        ));
        if (session.entries.length === 0) session.skip = "no turns in range";
      }
      sessions.push(session);
    }
  }
  return sessions;
}

/**
 * Trim sessions MidBrain already has.
 * - Entries an earlier import stored (same `import_id`) are dropped, so an
 *   interrupted or repeated import picks up where it stopped.
 * - When live capture covered part of the session (MidBrain was installed
 *   during it), only the turns from before the first live capture are kept.
 *
 * @param {any[]} sessions planned sessions (mutated)
 * @param {(session: any) => Promise<Array<{occurred_at: string, memory_metadata?: Record<string,string>}>>} listExisting
 */
export async function trimAgainstServer(sessions, listExisting) {
  for (const session of sessions) {
    if (session.skip) continue;
    let existing;
    try {
      existing = await listExisting(session);
    } catch (error) {
      session.skip = `could not check MidBrain (${error.message})`;
      continue;
    }
    if (existing.length === 0) continue;
    const imported = new Set();
    let firstCaptured = Infinity;
    for (const memory of existing) {
      if (memory.memory_metadata?.origin === IMPORT_ORIGIN) {
        if (memory.memory_metadata.import_id) imported.add(memory.memory_metadata.import_id);
        continue;
      }
      const time = validTime(memory.occurred_at);
      if (time !== null) firstCaptured = Math.min(firstCaptured, time);
    }
    const before = session.entries.length;
    // Keep whole turns only: a reply whose prompt was captured live goes too.
    const kept = [];
    for (const entry of session.entries) {
      if (Date.parse(entry.occurredAt) >= firstCaptured) break;
      kept.push(entry);
    }
    if (kept.length && kept[kept.length - 1].role === "user" && session.entries[kept.length]?.role === "assistant") {
      kept.pop();
    }
    session.alreadyImported = kept.filter((entry) => imported.has(importId(session, entry))).length;
    session.capturedLive = before - kept.length;
    session.entries = kept.filter((entry) => !imported.has(importId(session, entry)));
    if (session.entries.length === 0) {
      session.skip = session.alreadyImported ? "already imported" : "already captured live";
    }
  }
  return sessions;
}

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

/**
 * Upload planned sessions. Sequential, spaced, with exponential back-off on
 * rate limits. Stops at the first entry that still fails, so a re-run
 * resumes from there (see trimAgainstServer).
 *
 * @param {object} opts
 * @param {any[]} opts.sessions
 * @param {(session: any, entry: any, metadata: Record<string,string>) => Promise<"ok"|"rateLimited"|"failed">} opts.post
 * @param {number} [opts.spacingMs]
 * @param {number} [opts.maxRetries]
 * @param {(event: object) => void} [opts.onProgress]
 * @param {(ms: number) => Promise<void>} [opts.wait]
 * @param {string} [opts.importedAt]
 */
export async function uploadImport({
  sessions,
  post,
  spacingMs = 150,
  maxRetries = 6,
  onProgress = () => {},
  wait = sleep,
  importedAt = new Date().toISOString(),
}) {
  const totals = { sent: 0, sessions: 0, redactions: 0, truncated: 0, stopped: null };
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
      let result = "failed";
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        result = await post(session, { ...entry, text: prepared.text }, metadata);
        if (result !== "rateLimited") break;
        await wait(Math.min(60_000, 2_000 * 2 ** attempt));
      }
      if (result !== "ok") {
        totals.stopped = result === "rateLimited" ? "rate limited" : "store failed";
        onProgress({ type: "stopped", session: key, reason: totals.stopped, totals });
        return totals;
      }
      totals.sent += 1;
      totals.redactions += prepared.redactions;
      if (prepared.truncated) totals.truncated += 1;
      onProgress({ type: "entry", session: key, index, total: session.entries.length, totals });
      if (spacingMs) await wait(spacingMs);
    }
    totals.sessions += 1;
    onProgress({ type: "session", session: key, totals });
  }
  return totals;
}
