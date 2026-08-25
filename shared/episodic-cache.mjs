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
import path from "path";
import { createHash, randomBytes } from "crypto";
import { cacheDir as defaultCacheDir } from "./state-dir.mjs";

const DEFAULT_CACHE_FILE = "midbrain-episodic-cache.ndjson";
const SCOPED_CACHE_PREFIX = "midbrain-episodic-cache-";
const CACHE_EXT = ".ndjson";
const PROCESSING_EXT = ".processing";
const LOCK_EXT = ".lock";
const LINE_FEED = Buffer.from("\n");

/**
 * Explicit test override for the cache directory. When null the directory is
 * resolved lazily from state-dir on every access — honoring MIDBRAIN_STATE_DIR
 * and a sandbox HOME set after this module is imported.
 */
let cacheDirOverride = null;
function currentCacheDir() {
  return cacheDirOverride ?? defaultCacheDir();
}

/**
 * Override cache paths for testing. Pass `null` to reset to the lazily-resolved
 * default.
 * @param {string|null} dir
 */
export function _setCachePath(dir) {
  cacheDirOverride = dir === null ? null : dir;
}

function cacheFileForScope(scope) {
  if (!scope) return path.join(currentCacheDir(), DEFAULT_CACHE_FILE);
  const scopeText = String(scope);
  const safeScope = /^[a-f0-9]{64}$/i.test(scopeText)
    ? scopeText.toLowerCase()
    : createHash("sha256").update(scopeText).digest("hex");
  return path.join(currentCacheDir(), `${SCOPED_CACHE_PREFIX}${safeScope}${CACHE_EXT}`);
}

function processingFileForScope(scope) {
  return `${cacheFileForScope(scope)}${PROCESSING_EXT}`;
}

function lockFileForScope(scope) {
  return `${processingFileForScope(scope)}${LOCK_EXT}`;
}

function ensureCacheDir() {
  const dir = currentCacheDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
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

function sameFileIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function pathMatchesFile(target, stat) {
  try {
    const current = fs.lstatSync(target);
    return current.isFile() && sameFileIdentity(current, stat);
  } catch {
    return false;
  }
}

function appendCacheBytes(target, bytes) {
  let fd;
  try {
    const flags = fs.constants.O_RDWR
      | fs.constants.O_APPEND
      | fs.constants.O_CREAT
      | (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(target, flags, 0o600);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) return false;
    fs.writeFileSync(fd, bytes);
    try { fs.fchmodSync(fd, 0o600); } catch { /* ignore */ }
    const written = fs.fstatSync(fd);
    if (!sameFileIdentity(opened, written)) return false;
    return pathMatchesFile(target, written) ? "stable" : "moved";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readCacheSource(target) {
  let fd;
  try {
    const before = fs.lstatSync(target);
    if (!before.isFile()) return null;
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(target, flags);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameFileIdentity(before, opened)) return null;
    const raw = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (!sameFileIdentity(opened, after) || after.size !== raw.length) return null;
    return pathMatchesFile(target, after) ? { raw, stat: after } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
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

function parseCacheRaw(raw) {
  const entries = [];
  const segments = [];
  let start = 0;
  while (start < raw.length) {
    const newline = raw.indexOf(0x0a, start);
    const end = newline === -1 ? raw.length : newline + 1;
    const bytes = Buffer.from(raw.subarray(start, end));
    const line = bytes.toString("utf8").trim();
    if (!line) {
      // Leading LF separators are framing, not malformed cache evidence.
      start = end;
      continue;
    }
    let entry = null;
    try { entry = JSON.parse(line); } catch { /* preserve below */ }
    if (entry && typeof entry.text === "string" && typeof entry.role === "string") {
      entries.push(entry);
      segments.push({ entry, bytes });
    } else {
      segments.push({ bytes });
    }
    start = end;
  }
  return { entries, segments };
}

function preservedCacheBytes(flush, survivors) {
  const survivorSet = new Set(survivors);
  const represented = new Set();
  const chunks = [];
  for (const segment of flush.segments ?? []) {
    if (!segment.entry || survivorSet.has(segment.entry)) {
      chunks.push(segment.bytes);
      if (segment.entry) represented.add(segment.entry);
    }
  }
  for (const entry of survivors) {
    if (!represented.has(entry)) chunks.push(Buffer.from(`${JSON.stringify(entry)}\n`));
  }
  return Buffer.concat(chunks);
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
    const line = Buffer.concat([
      LINE_FEED,
      Buffer.from(`${JSON.stringify({ ...entry, ts: Date.now() })}\n`),
    ]);
    if (appendCacheBytes(cacheFile, line) === "moved"
      && appendCacheBytes(cacheFile, line) === "moved") appendCacheBytes(cacheFile, line);
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
    const claimed = readCacheSource(processingFile);
    if (!claimed) {
      releaseLock(flush);
      return emptyFlush();
    }
    const parsed = parseCacheRaw(claimed.raw);
    return {
      claimed: true,
      entries: parsed.entries,
      segments: parsed.segments,
      snapshotRaw: claimed.raw,
      sourceStat: claimed.stat,
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
    const current = readCacheSource(flush.processingFile);
    if (!current || !sameFileIdentity(current.stat, flush.sourceStat)) return;
    const snapshot = flush.snapshotRaw || Buffer.alloc(0);
    if (current.raw.length < snapshot.length
      || !current.raw.subarray(0, snapshot.length).equals(snapshot)) return;
    const retained = preservedCacheBytes(flush, survivors);
    const pending = Buffer.concat([
      retained.length > 0 ? LINE_FEED : Buffer.alloc(0),
      retained,
      current.raw.subarray(snapshot.length),
    ]);
    if (pending.length > 0) {
      ensureCacheDir();
      if (appendCacheBytes(flush.liveFile, pending) !== "stable") return;
    }
    const final = readCacheSource(flush.processingFile);
    if (!final || !sameFileIdentity(final.stat, current.stat) || !final.raw.equals(current.raw)) return;
    if (!pathMatchesFile(flush.processingFile, final.stat)) return;
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

function countEntriesInFile(filePath) {
  try {
    return validEntriesFromRaw(fs.readFileSync(filePath, "utf8")).length;
  } catch {
    return 0;
  }
}

function inspectFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return { count: validEntriesFromRaw(raw).length, hasContent: Boolean(raw.trim()) };
  } catch {
    return { count: 0, hasContent: false };
  }
}

function isBindingFile(name) {
  if (name === DEFAULT_CACHE_FILE || name === `${DEFAULT_CACHE_FILE}${PROCESSING_EXT}`) {
    return true;
  }
  return (
    name.startsWith(SCOPED_CACHE_PREFIX) &&
    (name.endsWith(CACHE_EXT) || name.endsWith(`${CACHE_EXT}${PROCESSING_EXT}`))
  );
}

function cacheBindingFiles() {
  try {
    return fs.readdirSync(currentCacheDir())
      .filter(isBindingFile)
      .map((name) => name.endsWith(PROCESSING_EXT) ? name.slice(0, -PROCESSING_EXT.length) : name);
  } catch {
    return [];
  }
}

/**
 * Count valid pending entries across the live and processing files for a
 * binding. Malformed lines are ignored and files are never mutated.
 *
 * @param {string} [scope]
 * @returns {number}
 */
export function countCachedEntries(scope) {
  return countEntriesInFile(cacheFileForScope(scope)) +
    countEntriesInFile(processingFileForScope(scope));
}

/**
 * Inspect pending cache state without reading entry content into diagnostics.
 * Binding filenames remain internal and are never returned.
 * @param {string} [scope]
 */
export function inspectCachedEntries(scope) {
  const liveFile = cacheFileForScope(scope);
  const files = [liveFile, processingFileForScope(scope)].map(inspectFile);
  const currentBase = path.basename(liveFile);
  const otherBindings = new Set(cacheBindingFiles().filter((name) => name !== currentBase));
  let otherPending = 0;
  for (const name of otherBindings) {
    const base = path.join(currentCacheDir(), name);
    const live = inspectFile(base);
    const processing = inspectFile(`${base}${PROCESSING_EXT}`);
    // A binding counts as pending when it holds any content — including a
    // malformed-only file that yields zero parsed entries. This mirrors the
    // current binding's `unparseable` semantics (AC-6).
    if (live.hasContent || processing.hasContent) {
      otherPending += 1;
    }
  }
  const count = files.reduce((sum, file) => sum + file.count, 0);
  const filesPresent = files.some((file) => file.hasContent);
  return {
    count,
    filesPresent,
    unparseable: filesPresent && count === 0,
    otherBindings: otherPending,
    cacheDir: currentCacheDir(),
  };
}

// ---------------------------------------------------------------------------
// Boot drain support (issue #53): enumerate ALL scope bindings so a single
// authenticated drain at server start can recover entries orphaned by a past
// key rotation or host change — not just the current scope.
// ---------------------------------------------------------------------------

/**
 * Extract the scope token from a base binding filename. Returns undefined for
 * the unscoped default file (so cacheFileForScope(undefined) maps back to it).
 * @param {string} name
 * @returns {string|undefined}
 */
function scopeFromFilename(name) {
  if (name === DEFAULT_CACHE_FILE) return undefined;
  if (name.startsWith(SCOPED_CACHE_PREFIX) && name.endsWith(CACHE_EXT)) {
    return name.slice(SCOPED_CACHE_PREFIX.length, -CACHE_EXT.length);
  }
  return undefined;
}

/**
 * List every cache-binding scope currently on disk (live or processing),
 * de-duplicated. Each returned value round-trips through cacheFileForScope()
 * to the same file, so a caller can begin/finish a flush per binding.
 * @returns {Array<string|undefined>}
 */
export function listCacheBindings() {
  const seen = new Map(); // key -> scope (dedupes undefined default too)
  for (const name of cacheBindingFiles()) {
    const scope = scopeFromFilename(name);
    seen.set(scope ?? "", scope);
  }
  return [...seen.values()];
}

/** True when ANY binding (current or orphaned) holds pending entries. */
export function hasAnyCachedEntries() {
  return listCacheBindings().some((scope) => hasCachedEntries(scope));
}

// ---------------------------------------------------------------------------
// Cache-wide cooldown sidecar (issue #53): a WAF rejection during the boot
// drain persists one "do not drain before" timestamp for the whole cache so a
// rapid restart under a different binding cannot re-burst. Never throws.
// ---------------------------------------------------------------------------

const COOLDOWN_EXT = ".cooldown";

function cacheCooldownFile() {
  return `${path.join(currentCacheDir(), DEFAULT_CACHE_FILE)}${COOLDOWN_EXT}`;
}

/** @returns {number} epoch-ms before which draining should be skipped; 0 when unset/corrupt. */
export function readCacheCooldownUntil(_scope) {
  try {
    const raw = fs.readFileSync(cacheCooldownFile(), "utf8").trim();
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeCacheCooldownUntil(_scope, until) {
  try {
    if (!Number.isFinite(until) || until <= 0) return;
    ensureCacheDir();
    fs.writeFileSync(cacheCooldownFile(), String(Math.floor(until)), { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(cacheCooldownFile(), 0o600); } catch { /* ignore */ }
  } catch {
    // Best effort.
  }
}

export function clearCacheCooldown(_scope) {
  try { fs.unlinkSync(cacheCooldownFile()); } catch { /* ignore */ }
}
