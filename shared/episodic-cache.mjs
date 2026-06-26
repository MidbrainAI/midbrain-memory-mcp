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
import { createHash } from "crypto";

const DEFAULT_CACHE_DIR  = path.join(os.homedir(), ".cache", "midbrain");
const DEFAULT_CACHE_FILE = "midbrain-episodic-cache.ndjson";
const SCOPED_CACHE_PREFIX = "midbrain-episodic-cache-";
const CACHE_EXT = ".ndjson";
const PROCESSING_EXT = ".processing";

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

function ensureCacheDir() {
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(cacheDir, 0o700); } catch { /* ignore */ }
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
 * @returns {Array<{ text: string, role: string, memory_metadata?: Record<string, string>, ts: number }>}
 */
export function beginCacheFlush(scope) {
  const cacheFile = cacheFileForScope(scope);
  const processingFile = processingFileForScope(scope);
  try {
    if (!fs.existsSync(processingFile)) {
      fs.renameSync(cacheFile, processingFile);
    }
    const raw = fs.readFileSync(processingFile, "utf8");
    return validEntriesFromRaw(raw);
  } catch {
    return [];
  }
}

/**
 * Finish a processing batch. Survivors are appended back to the live file so
 * any concurrent appends already in that file remain intact. The processing
 * file is removed only after survivor preservation succeeds.
 *
 * @param {Array<{ text: string, role: string, memory_metadata?: Record<string, string>, ts: number }>} survivors
 * @param {string} [scope]
 */
export function finishCacheFlush(survivors, scope) {
  const processingFile = processingFileForScope(scope);
  try {
    if (survivors.length > 0) {
      ensureCacheDir();
      const liveFile = cacheFileForScope(scope);
      fs.appendFileSync(liveFile, serializeEntries(survivors), { encoding: "utf8", mode: 0o600 });
      try { fs.chmodSync(liveFile, 0o600); } catch { /* ignore */ }
    }
    fs.unlinkSync(processingFile);
  } catch {
    // Best effort. Leaving the processing file is recoverable on next flush.
  }
}

/**
 * Read cached entries and complete them as successful. Returns an empty array
 * if no recoverable live or processing file exists. Malformed lines are skipped.
 *
 * @returns {Array<{ text: string, role: string, memory_metadata?: Record<string, string>, ts: number }>}
 */
export function readAndClearCache(scope) {
  const entries = beginCacheFlush(scope);
  finishCacheFlush([], scope);
  return entries;
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
