/**
 * shared/logger.mjs
 *
 * Leveled file logger for MidBrain capture hooks and plugins.
 * Appends timestamped, level-tagged lines to a platform-appropriate log
 * directory. Never throws. Node 20 + Bun compatible. No npm deps.
 *
 * Configuration (environment):
 *   MIDBRAIN_LOG_LEVEL     error | warn | info | debug   (default: info)
 *   MIDBRAIN_LOG_MAX_SIZE  max bytes before rotation     (default: 5 MiB)
 *
 * Log directory resolution (overridable via MIDBRAIN_LOG_DIR):
 *   Linux/other  $XDG_STATE_HOME/midbrain or ~/.local/state/midbrain
 *   macOS        ~/Library/Logs/midbrain
 *   Windows      %LOCALAPPDATA%/midbrain/logs or %APPDATA%/midbrain/logs
 */

import { appendFileSync, statSync, renameSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const DEFAULT_LEVEL = "info";
const DEFAULT_MAX_SIZE = 5 * 1024 * 1024; // 5 MiB

/**
 * Resolve the configured log level from an explicit value or the
 * MIDBRAIN_LOG_LEVEL env var, falling back to "info". Unknown values
 * fall back to the default rather than silencing or flooding logs.
 */
function resolveLevel(level) {
  const candidate = (level || process.env.MIDBRAIN_LOG_LEVEL || DEFAULT_LEVEL)
    .toString()
    .trim()
    .toLowerCase();
  return candidate in LEVELS ? candidate : DEFAULT_LEVEL;
}

/** Resolve the max log size in bytes from MIDBRAIN_LOG_MAX_SIZE or the default. */
function resolveMaxSize(maxSize) {
  const raw = maxSize ?? process.env.MIDBRAIN_LOG_MAX_SIZE;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SIZE;
}

/**
 * Platform-appropriate directory for MidBrain log files.
 * Honors MIDBRAIN_LOG_DIR as an explicit override.
 * @returns {string}
 */
export function logDir() {
  const override = process.env.MIDBRAIN_LOG_DIR;
  if (override && override.trim()) return override.trim();

  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Logs", "midbrain");
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || join(home, "AppData", "Local");
    return join(base, "midbrain", "logs");
  }
  // Linux and other POSIX: XDG Base Directory state location.
  const xdgState = process.env.XDG_STATE_HOME;
  const base = xdgState && xdgState.trim() ? xdgState.trim() : join(home, ".local", "state");
  return join(base, "midbrain");
}

/** Convenience: absolute path to a named log file inside logDir(). */
export function logFile(name) {
  return join(logDir(), name);
}

/**
 * Rotate the log file if it has reached the size cap. Keeps a single
 * previous generation as "<path>.1" (overwriting any older backup).
 * Best-effort: any error is swallowed so logging never crashes callers.
 */
function rotateIfNeeded(logPath, maxSize) {
  try {
    const { size } = statSync(logPath);
    if (size < maxSize) return;
    renameSync(logPath, `${logPath}.1`);
  } catch {
    // ENOENT (no file yet) or any other error — nothing to rotate.
  }
}

/**
 * Creates a leveled logger that appends timestamped lines to a file.
 * Returned methods never throw — all errors are silently swallowed.
 *
 * @param {string} logPath - Absolute path to the log file.
 * @param {object} [opts]
 * @param {string} [opts.level] - Threshold: error|warn|info|debug. Defaults to
 *   MIDBRAIN_LOG_LEVEL or "info".
 * @param {number} [opts.maxSize] - Bytes before rotation. Defaults to
 *   MIDBRAIN_LOG_MAX_SIZE or 5 MiB.
 * @returns {{error: function(string): void, warn: function(string): void,
 *   info: function(string): void, debug: function(string): void, level: string}}
 */
export function makeLogger(logPath, opts = {}) {
  const threshold = LEVELS[resolveLevel(opts.level)];
  const maxSize = resolveMaxSize(opts.maxSize);
  let dirEnsured = false;

  function write(level, msg) {
    if (LEVELS[level] > threshold) return; // below threshold — skip entirely
    try {
      if (!dirEnsured) {
        mkdirSync(dirnameOf(logPath), { recursive: true });
        dirEnsured = true;
      }
      rotateIfNeeded(logPath, maxSize);
      const tag = level.toUpperCase();
      appendFileSync(logPath, `[${new Date().toISOString()}] [${tag}] ${msg}\n`);
    } catch {
      // swallow — never crash callers over logging
    }
  }

  return {
    level: resolveLevel(opts.level),
    error: (msg) => write("error", msg),
    warn: (msg) => write("warn", msg),
    info: (msg) => write("info", msg),
    debug: (msg) => write("debug", msg),
  };
}

/** Minimal dirname without importing path twice in hot paths. */
function dirnameOf(p) {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx <= 0 ? "." : p.slice(0, idx);
}
