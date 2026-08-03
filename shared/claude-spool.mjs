/**
 * shared/claude-spool.mjs
 *
 * Keyless recovery spool for Claude/NanoClaw episodic capture (issue #52).
 *
 * On a cold NanoClaw container wake the conversation-opening message's hook can
 * fire before the MCP server has persisted the API key (~/.config/midbrain is
 * ephemeral and rebuilt per spawn). Such a hook resolves NO KEY and, before
 * this spool existed, dropped the message entirely — the offline episodic cache
 * is only reachable through an authenticated api instance whose filename is
 * key-scoped, and it lives under the ephemeral ~/.cache.
 *
 * This spool is deliberately different:
 *   - It lives under ~/.claude — the ONLY durable in-container mount (NanoClaw
 *     mounts .claude-shared there), so a spooled entry survives the --rm spawn.
 *   - Its filename is key-INDEPENDENT, so a keyless hook can write it and a
 *     later authenticated server-start flush can read it.
 *
 * Hard invariant: entries are NEVER dropped. There is no cap and no eviction;
 * only a successful flush removes an entry. A partial flush preserves the
 * survivors. If the flush is rate-limited (WAF/429), the pass stops and a
 * cooldown timestamp defers the next attempt — entries are kept, not lost.
 *
 * Format: ~/.claude/.midbrain-spool.ndjson — one JSON object per line:
 *   { text, role, memory_metadata?, ts }
 *
 * Node 20 + Bun compatible. No npm deps. Every export is best-effort and never
 * throws (capture and self-repair are fail-open).
 */

import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "crypto";

const SPOOL_FILENAME = ".midbrain-spool.ndjson";
const PROCESSING_EXT = ".processing";
const LOCK_EXT = ".lock";
const COOLDOWN_FILENAME = ".midbrain-spool-cooldown";

function defaultSpoolDir() {
  return path.join(os.homedir(), ".claude");
}

/**
 * Explicit test override for the spool directory. When null the directory is
 * resolved lazily from os.homedir() on every access, so a sandbox that sets
 * HOME/USERPROFILE after this module is imported is still honored.
 */
let spoolDirOverride = null;

function currentSpoolDir() {
  return spoolDirOverride ?? defaultSpoolDir();
}

/**
 * Override the spool directory for testing. Pass `null` to reset to the
 * lazily-resolved default.
 * @param {string|null} dir
 */
export function _setSpoolDir(dir) {
  spoolDirOverride = dir === null ? null : dir;
}

export function spoolFilePath() {
  return path.join(currentSpoolDir(), SPOOL_FILENAME);
}

function processingFilePath() {
  return `${spoolFilePath()}${PROCESSING_EXT}`;
}

function lockFilePath() {
  return `${spoolFilePath()}${LOCK_EXT}`;
}

function cooldownFilePath() {
  return path.join(currentSpoolDir(), COOLDOWN_FILENAME);
}

function ensureSpoolDir() {
  const dir = currentSpoolDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
}

/** Reject a symlink at the target so a hostile link can't redirect our write. */
function isSymlink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function makeToken() {
  return `${process.pid}:${Date.now()}:${randomBytes(8).toString("hex")}`;
}

function readLock(lockFile) {
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function removeDeadLock(lockFile) {
  const lock = readLock(lockFile);
  if (!lock || isProcessAlive(lock.pid)) return false;
  try {
    fs.unlinkSync(lockFile);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockFile) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(lockFile, "wx", 0o600);
      const token = makeToken();
      fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, ts: Date.now() }));
      fs.closeSync(fd);
      try { fs.chmodSync(lockFile, 0o600); } catch { /* ignore */ }
      return token;
    } catch (err) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      if (err && err.code === "EEXIST" && removeDeadLock(lockFile)) continue;
      return null;
    }
  }
  return null;
}

function ownsLock(flush) {
  const lock = readLock(flush.lockFile);
  return Boolean(lock && lock.token === flush.token && lock.pid === process.pid);
}

function releaseLock(flush) {
  try {
    if (ownsLock(flush)) fs.unlinkSync(flush.lockFile);
  } catch {
    // Best effort.
  }
}

function validEntriesFromRaw(raw) {
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((entry) => entry && typeof entry.text === "string" && typeof entry.role === "string");
}

function serializeEntries(entries) {
  if (entries.length === 0) return "";
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/**
 * Append a single episodic entry to the spool. Creates the directory and file
 * on first write. Never throws. Drops nothing — this is the whole point.
 *
 * @param {{ text: string, role: "user"|"assistant", memory_metadata?: Record<string, string> }} entry
 */
export function appendToSpool(entry) {
  try {
    // A non-serializable entry must be dropped rather than crash the caller,
    // but that is a programming error, not a lost memory in practice (the hook
    // always passes a plain {text, role, memory_metadata}).
    const line = JSON.stringify({ ...entry, ts: Date.now() }) + "\n";
    ensureSpoolDir();
    const spoolFile = spoolFilePath();
    if (isSymlink(spoolFile)) return; // never write through a symlink
    fs.appendFileSync(spoolFile, line, { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(spoolFile, 0o600); } catch { /* ignore */ }
  } catch {
    // Best effort — never crash capture over spooling.
  }
}

/**
 * Atomically hand the live spool to a processing file and read that batch.
 * New appends after handoff continue into a fresh live file, so a hook that
 * fires mid-flush is never lost. Mirrors episodic-cache.beginCacheFlush.
 *
 * @returns {{ claimed: boolean, entries: Array<object>, liveFile?: string, processingFile?: string, lockFile?: string, token?: string }}
 */
export function beginSpoolFlush() {
  const empty = { claimed: false, entries: [] };
  const spoolFile = spoolFilePath();
  const processingFile = processingFilePath();
  const lockFile = lockFilePath();
  let flush;
  try {
    if (!fs.existsSync(spoolFile) && !fs.existsSync(processingFile)) return empty;
    ensureSpoolDir();
    const token = acquireLock(lockFile);
    if (!token) return empty;
    flush = { claimed: true, entries: [], liveFile: spoolFile, processingFile, lockFile, token };
    if (!fs.existsSync(processingFile)) {
      try {
        fs.renameSync(spoolFile, processingFile);
      } catch {
        releaseLock(flush);
        return empty;
      }
    }
    const raw = fs.readFileSync(processingFile, "utf8");
    return { ...flush, entries: validEntriesFromRaw(raw) };
  } catch {
    if (flush) releaseLock(flush);
    return empty;
  }
}

/**
 * Finish a flush batch. Survivors (entries that did not send) are appended
 * back to the live file so any concurrent appends there remain intact, then
 * the processing file is removed. Preserves everything on any failure — a
 * leftover processing file is recovered on the next flush.
 *
 * @param {object} flush
 * @param {Array<object>} survivors
 */
export function finishSpoolFlush(flush, survivors) {
  if (!flush || !flush.claimed || !ownsLock(flush)) return;
  try {
    if (survivors.length > 0) {
      ensureSpoolDir();
      if (!isSymlink(flush.liveFile)) {
        fs.appendFileSync(flush.liveFile, serializeEntries(survivors), { encoding: "utf8", mode: 0o600 });
        try { fs.chmodSync(flush.liveFile, 0o600); } catch { /* ignore */ }
      }
    }
    fs.unlinkSync(flush.processingFile);
  } catch {
    // Best effort. Leaving the processing file is recoverable next flush.
  } finally {
    releaseLock(flush);
  }
}

/** Quick check: are there spooled entries (live or processing) awaiting flush? */
export function hasSpooledEntries() {
  const spoolFile = spoolFilePath();
  const processingFile = processingFilePath();
  try {
    return fs.statSync(spoolFile).size > 0;
  } catch {
    try {
      return fs.statSync(processingFile).size > 0;
    } catch {
      return false;
    }
  }
}

function countEntriesInFile(filePath) {
  try {
    return validEntriesFromRaw(fs.readFileSync(filePath, "utf8")).length;
  } catch {
    return 0;
  }
}

/** Count valid pending entries across the live and processing files. */
export function countSpooledEntries() {
  return countEntriesInFile(spoolFilePath()) + countEntriesInFile(processingFilePath());
}

// ---------------------------------------------------------------------------
// Cooldown state — WAF backoff across server starts.
//
// The flush runs once per server start, not in a loop. When a pass is rate-
// limited we persist a "do not flush before" timestamp so the next server
// start (which may be seconds later on a rapid respawn) defers instead of
// re-bursting into the edge. Entries are never touched by this — only the
// scheduling of the next attempt.
// ---------------------------------------------------------------------------

/**
 * Read the epoch-ms timestamp before which flushing should be skipped.
 * Returns 0 when unset, corrupt, or in the past-safe default. Never throws.
 * @returns {number}
 */
export function readCooldownUntil() {
  try {
    const raw = fs.readFileSync(cooldownFilePath(), "utf8").trim();
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Persist the epoch-ms timestamp before which flushing should be skipped.
 * Never throws.
 * @param {number} until
 */
export function writeCooldownUntil(until) {
  try {
    if (!Number.isFinite(until) || until <= 0) return;
    ensureSpoolDir();
    const file = cooldownFilePath();
    if (isSymlink(file)) return;
    fs.writeFileSync(file, String(Math.floor(until)), { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
  } catch {
    // Best effort.
  }
}

/** Clear any persisted cooldown (e.g. after a fully successful flush). */
export function clearCooldown() {
  try { fs.unlinkSync(cooldownFilePath()); } catch { /* ignore */ }
}
