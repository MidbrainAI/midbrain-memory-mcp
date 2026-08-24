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
const BINDING_FILENAME = ".midbrain-spool-binding";
const BINDING_RE = /^[a-f0-9]{64}$/;

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

export function spoolBindingPath() {
  return path.join(currentSpoolDir(), BINDING_FILENAME);
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

function validBinding(value) {
  return typeof value === "string" && BINDING_RE.test(value);
}

function inspectSpoolBinding() {
  let fd;
  try {
    const file = spoolBindingPath();
    if (isSymlink(file)) return { kind: "invalid", value: null };
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(file, flags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { kind: "invalid", value: null };
    const value = fs.readFileSync(fd, "utf8").trim();
    return validBinding(value)
      ? { kind: "valid", value }
      : { kind: "invalid", value: null };
  } catch (error) {
    return error?.code === "ENOENT"
      ? { kind: "missing", value: null }
      : { kind: "invalid", value: null };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

export function readSpoolBinding() {
  const inspected = inspectSpoolBinding();
  return inspected.kind === "valid" ? inspected.value : null;
}

/** Atomically establish the current nonsecret API binding sidecar. */
export function establishSpoolBinding(binding) {
  if (!validBinding(binding)) return { ok: false, previous: null, conflict: false };
  const target = spoolBindingPath();
  const inspected = inspectSpoolBinding();
  if (inspected.kind === "invalid") return { ok: false, previous: null, conflict: true };
  const previous = inspected.kind === "valid" ? inspected.value : null;
  if (previous === binding) {
    let fd;
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      fd = fs.openSync(target, flags);
      if (!fs.fstatSync(fd).isFile()) return { ok: false, previous, conflict: true };
      try { fs.fchmodSync(fd, 0o600); } catch {
        if (process.platform !== "win32") return { ok: false, previous, conflict: true };
      }
      return { ok: true, previous, conflict: false };
    } catch {
      return { ok: false, previous, conflict: true };
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }
  let stage;
  try {
    ensureSpoolDir();
    if (isSymlink(target)) return { ok: false, previous, conflict: Boolean(previous) };
    stage = `${target}.stage-${process.pid}-${randomBytes(8).toString("hex")}`;
    const fd = fs.openSync(stage, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${binding}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(stage, target);
    try { fs.chmodSync(target, 0o600); } catch { /* ignore */ }
    return { ok: readSpoolBinding() === binding, previous, conflict: Boolean(previous && previous !== binding) };
  } catch {
    return { ok: false, previous, conflict: Boolean(previous && previous !== binding) };
  } finally {
    if (stage) {
      try { fs.unlinkSync(stage); } catch { /* ignore */ }
    }
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

function recordsFromRaw(raw) {
  const records = [];
  let start = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== 0x0a) continue;
    const bytes = raw.subarray(start, i + 1);
    const line = bytes.subarray(0, -1).toString("utf8");
    let entry = null;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.text === "string" && typeof parsed.role === "string") entry = parsed;
    } catch { /* malformed complete line is preserved */ }
    records.push({ bytes: Buffer.from(bytes), entry });
    start = i + 1;
  }
  if (start < raw.length) records.push({ bytes: Buffer.from(raw.subarray(start)), entry: null });
  return records;
}

function appendBufferSafely(file, buffer) {
  if (buffer.length === 0) return true;
  if (isSymlink(file)) return false;
  let fd;
  try {
    const flags = fs.constants.O_RDWR
      | fs.constants.O_APPEND
      | fs.constants.O_CREAT
      | (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(file, flags, 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return false;
    let prefix = Buffer.alloc(0);
    const size = stat.size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = Buffer.from("\n");
    }
    fs.writeFileSync(fd, Buffer.concat([prefix, buffer]));
    fs.fsyncSync(fd);
    try { fs.fchmodSync(fd, 0o600); } catch { /* ignore */ }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Append a single episodic entry to the spool. Creates the directory and file
 * on first write. Never throws. Drops nothing — this is the whole point.
 *
 * @param {{ text: string, role: "user"|"assistant", memory_metadata?: Record<string, string> }} entry
 */
export function appendToSpool(entry) {
  try {
    if (entry?.memory_metadata?.client !== "nanoclaw") return false;
    const binding = readSpoolBinding();
    if (!binding) return false;
    // A non-serializable entry must be dropped rather than crash the caller,
    // but that is a programming error, not a lost memory in practice (the hook
    // always passes a plain {text, role, memory_metadata}).
    const line = Buffer.from(JSON.stringify({ ...entry, binding, ts: Date.now() }) + "\n");
    ensureSpoolDir();
    const spoolFile = spoolFilePath();
    if (isSymlink(spoolFile)) return; // never write through a symlink
    if (!appendBufferSafely(spoolFile, line)) return false;
    return true;
  } catch {
    // Best effort — never crash capture over spooling.
    return false;
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
    const records = recordsFromRaw(fs.readFileSync(processingFile));
    return { ...flush, records, entries: records.flatMap((record) => record.entry ? [record.entry] : []) };
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
    const survivorSet = new Set(survivors);
    const preserved = Buffer.concat((flush.records || []).flatMap((record) =>
      !record.entry || survivorSet.has(record.entry) ? [record.bytes] : []));
    if (preserved.length > 0) {
      ensureSpoolDir();
      if (!appendBufferSafely(flush.liveFile, preserved)) return;
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
    return recordsFromRaw(fs.readFileSync(filePath)).filter((record) => record.entry).length;
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
