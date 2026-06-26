/**
 * shared/episodic-cache.mjs
 *
 * File-backed NDJSON queue for episodic memories that failed to POST.
 * When storeEpisodic fails (network error, server down, etc.), the entry
 * is appended here. On the next successful storeEpisodic call the cache
 * is flushed — each entry is POSTed and survivors (still-failing) are
 * re-written.
 *
 * File: ~/.cache/midbrain/midbrain-episodic-cache-<scope>.ndjson
 * Format: one JSON object per line: { text, role, memory_metadata, ts }
 *
 * Concurrency: appendFileSync is used for single-line appends. Flush uses an
 * atomic rename from live -> processing so appends after handoff land in a new
 * live file, and failed survivors are appended back without replacing it.
 *
 * Node 20 + Bun compatible. No npm deps.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createHash, randomBytes } from "crypto";

const DEFAULT_CACHE_DIR  = path.join(os.homedir(), ".cache", "midbrain");
const DEFAULT_CACHE_FILE = "midbrain-episodic-cache.ndjson";
const SCOPED_CACHE_PREFIX = "midbrain-episodic-cache-";
const CACHE_EXT = ".ndjson";
const PROCESSING_EXT = ".processing";
const LOCK_EXT = ".lock";

/** Resolve the current cache directory. Tests may override via _setCachePath. */
let cacheDir  = DEFAULT_CACHE_DIR;

/**
 * Override cache paths for testing. Pass `null` to reset to defaults.
 * @param {string|null} dir
 */
export function _setCachePath(dir) {
  if (dir === null) {
    cacheDir  = DEFAULT_CACHE_DIR;
  } else {
    cacheDir  = dir;
  }
}

function cacheFileForScope(scope) {
  if (!scope) return path.join(cacheDir, DEFAULT_CACHE_FILE);
  const scopeText = String(scope);
  const safeScope = /^[a-f0-9]{64}$/i.test(scopeText)
    ? scopeText.toLowerCase()
    : createHash("sha256").update(scopeText).digest("hex");
  return path.join(cacheDir, `${SCOPED_CACHE_PREFIX}${safeScope}${CACHE_EXT}`);
}

function processingFileForScope(scope) {
  return `${cacheFileForScope(scope)}${PROCESSING_EXT}`;
}

function lockFileForScope(scope) {
  return `${processingFileForScope(scope)}${LOCK_EXT}`;
}

function ensureCacheDir() {
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(cacheDir, 0o700); } catch { /* ignore */ }
}

function emptyFlush() {
  return { claimed: false, entries: [] };
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
    const token = makeToken();
    let fd;
    try {
      fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, ts: Date.now() }));
      fs.closeSync(fd);
      try { fs.chmodSync(lockFile, 0o600); } catch { /* ignore */ }
      return token;
    } catch (err) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
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
 * Append a single failed episodic entry to the cache file.
 * Creates the directory and file on first write. Never throws.
 *
 * @param {object} entry
 * @param {string} entry.text
 * @param {"user"|"assistant"} entry.role
 * @param {Record<string, string>} [entry.memory_metadata]
 * @param {string} [scope] Non-secret cache scope, usually a hash.
 */
export function appendToCache(entry, scope) {
  try {
    ensureCacheDir();
    const cacheFile = cacheFileForScope(scope);
    const line = JSON.stringify({ ...entry, ts: Date.now() }) + "\n";
    fs.appendFileSync(cacheFile, line, { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(cacheFile, 0o600); } catch { /* ignore */ }
  } catch {
    // Best effort — never crash callers over caching.
  }
}

/**
 * Atomically hand the live cache file to a processing file and read that batch.
 * If a previous processing file exists, it is recovered first. New appends
 * after handoff continue into the live file.
 *
 * @param {string} [scope]
 * @returns {{ claimed: boolean, entries: Array<{ text: string, role: string, memory_metadata?: Record<string, string>, ts: number }> }}
 */
export function beginCacheFlush(scope) {
  const cacheFile = cacheFileForScope(scope);
  const processingFile = processingFileForScope(scope);
  const lockFile = lockFileForScope(scope);
  let flush;
  try {
    if (!fs.existsSync(cacheFile) && !fs.existsSync(processingFile)) return emptyFlush();
    ensureCacheDir();
    const token = acquireLock(lockFile);
    if (!token) return emptyFlush();
    flush = { claimed: true, entries: [], liveFile: cacheFile, processingFile, lockFile, token };
    if (!fs.existsSync(processingFile)) {
      try {
        fs.renameSync(cacheFile, processingFile);
      } catch (err) {
        releaseLock(flush);
        if (err && err.code === "ENOENT") return emptyFlush();
        return emptyFlush();
      }
    }
    const raw = fs.readFileSync(processingFile, "utf8");
    return {
      claimed: true,
      entries: validEntriesFromRaw(raw),
      liveFile: cacheFile,
      processingFile,
      lockFile,
      token,
    };
  } catch {
    if (flush) releaseLock(flush);
    return emptyFlush();
  }
}

/**
 * Finish a processing batch. Survivors are appended back to the live file so
 * any concurrent appends already in that file remain intact. The processing
 * file is removed only after survivor preservation succeeds.
 *
 * @param {{ claimed: boolean, liveFile?: string, processingFile?: string, lockFile?: string, token?: string }} flush
 * @param {Array<{ text: string, role: string, memory_metadata?: Record<string, string>, ts: number }>} survivors
 */
export function finishCacheFlush(flush, survivors) {
  if (!flush || !flush.claimed || !ownsLock(flush)) return;
  try {
    if (survivors.length > 0) {
      ensureCacheDir();
      fs.appendFileSync(flush.liveFile, serializeEntries(survivors), { encoding: "utf8", mode: 0o600 });
      try { fs.chmodSync(flush.liveFile, 0o600); } catch { /* ignore */ }
    }
    fs.unlinkSync(flush.processingFile);
  } catch {
    // Best effort. Leaving the processing file is recoverable on next flush.
  } finally {
    releaseLock(flush);
  }
}

/**
 * Read cached entries and complete them as successful. Returns an empty array
 * if no recoverable live or processing file exists. Malformed lines are skipped.
 *
 * @returns {Array<{ text: string, role: string, memory_metadata?: Record<string, string>, ts: number }>}
 */
export function readAndClearCache(scope) {
  const flush = beginCacheFlush(scope);
  if (!flush.claimed) return [];
  finishCacheFlush(flush, []);
  return flush.entries;
}

/**
 * Re-write the cache file with only the given entries (survivors from a
 * partial flush). Atomic: writes to a temp file then renames.
 * If entries is empty the cache file is removed.
 *
 * @param {Array<{ text: string, role: string, memory_metadata?: Record<string, string>, ts: number }>} entries
 */
export function rewriteCache(entries, scope) {
  const cacheFile = cacheFileForScope(scope);
  try {
    if (entries.length === 0) {
      try { fs.unlinkSync(cacheFile); } catch { /* ignore */ }
      return;
    }
    ensureCacheDir();
    const tmp = cacheFile + ".tmp";
    const data = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, cacheFile);
    try { fs.chmodSync(cacheFile, 0o600); } catch { /* ignore */ }
  } catch {
    // Best effort.
  }
}

/**
 * Quick check: are there cached entries waiting to flush?
 * @returns {boolean}
 */
export function hasCachedEntries(scope) {
  const cacheFile = cacheFileForScope(scope);
  const processingFile = processingFileForScope(scope);
  try {
    return fs.statSync(cacheFile).size > 0 || fs.statSync(processingFile).size > 0;
  } catch {
    try {
      return fs.statSync(processingFile).size > 0;
    } catch {
      return false;
    }
  }
}
