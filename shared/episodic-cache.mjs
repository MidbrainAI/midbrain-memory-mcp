/**
 * shared/episodic-cache.mjs
 *
 * File-backed NDJSON queue for episodic memories that failed to POST.
 * When storeEpisodic fails (network error, server down, etc.), the entry
 * is appended here. On the next successful storeEpisodic call the cache
 * is flushed — each entry is POSTed and survivors (still-failing) are
 * re-written.
 *
 * File: ~/.cache/midbrain/midbrain-episodic-cache.ndjson
 * Format: one JSON object per line: { text, role, memory_metadata, ts }
 *
 * Concurrency: appendFileSync is used for single-line appends — safe for
 * the one-shot hook processes that call storeEpisodic sequentially.
 * rewriteCache uses atomic temp-file rename for the rewrite path.
 *
 * Node 20 + Bun compatible. No npm deps.
 */

import fs from "fs";
import os from "os";
import path from "path";

const DEFAULT_CACHE_DIR  = path.join(os.homedir(), ".cache", "midbrain");
const DEFAULT_CACHE_FILE = "midbrain-episodic-cache.ndjson";

/** Resolve the current cache directory. Tests may override via _setCachePath. */
let cacheDir  = DEFAULT_CACHE_DIR;
let cacheFile = path.join(DEFAULT_CACHE_DIR, DEFAULT_CACHE_FILE);

/**
 * Override cache paths for testing. Pass `null` to reset to defaults.
 * @param {string|null} dir
 */
export function _setCachePath(dir) {
  if (dir === null) {
    cacheDir  = DEFAULT_CACHE_DIR;
    cacheFile = path.join(DEFAULT_CACHE_DIR, DEFAULT_CACHE_FILE);
  } else {
    cacheDir  = dir;
    cacheFile = path.join(dir, DEFAULT_CACHE_FILE);
  }
}

/**
 * Append a single failed episodic entry to the cache file.
 * Creates the directory and file on first write. Never throws.
 *
 * @param {object} entry
 * @param {string} entry.text
 * @param {"user"|"assistant"} entry.role
 * @param {Record<string, string>} [entry.memory_metadata]
 */
export function appendToCache(entry) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ...entry, ts: Date.now() }) + "\n";
    fs.appendFileSync(cacheFile, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Best effort — never crash callers over caching.
  }
}

/**
 * Read all cached entries and delete the cache file.
 * Returns an empty array if the file does not exist or is unreadable.
 * Malformed lines are silently skipped.
 *
 * @returns {Array<{ text: string, role: string, memory_metadata?: Record<string, string>, ts: number }>}
 */
export function readAndClearCache() {
  try {
    const raw = fs.readFileSync(cacheFile, "utf8");
    fs.unlinkSync(cacheFile);
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((entry) => entry && typeof entry.text === "string" && typeof entry.role === "string");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      // Corrupted file — remove it so we don't retry garbage forever.
      try { fs.unlinkSync(cacheFile); } catch { /* ignore */ }
    }
    return [];
  }
}

/**
 * Re-write the cache file with only the given entries (survivors from a
 * partial flush). Atomic: writes to a temp file then renames.
 * If entries is empty the cache file is removed.
 *
 * @param {Array<{ text: string, role: string, memory_metadata?: Record<string, string>, ts: number }>} entries
 */
export function rewriteCache(entries) {
  try {
    if (entries.length === 0) {
      try { fs.unlinkSync(cacheFile); } catch { /* ignore */ }
      return;
    }
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const tmp = cacheFile + ".tmp";
    const data = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, cacheFile);
  } catch {
    // Best effort.
  }
}

/**
 * Quick check: are there cached entries waiting to flush?
 * @returns {boolean}
 */
export function hasCachedEntries() {
  try {
    return fs.statSync(cacheFile).size > 0;
  } catch {
    return false;
  }
}
