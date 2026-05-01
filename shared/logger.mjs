/**
 * shared/logger.mjs
 *
 * Debug file logger for MidBrain capture hooks and plugins.
 * Appends timestamped lines to a file. Never throws.
 * Node 20 + Bun compatible. No npm deps.
 */

import { appendFileSync } from "fs";

/**
 * Creates a debug logging function that appends timestamped lines to a file.
 * The returned function never throws — all errors are silently swallowed.
 * @param {string} logPath - Absolute path to the log file.
 * @returns {function(string): void}
 */
export function makeDebugLogger(logPath) {
  return function debugLog(msg) {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      // swallow — never crash callers over logging
    }
  };
}
