/**
 * Shared utilities for Claude Code episodic capture hooks.
 * Node 20 builtins only — no npm dependencies.
 *
 * Re-exports storeEpisodic, makeDebugLogger from the shared module.
 * Wraps loadApiKey to pass Claude Code's config dir (~/.config/claude).
 * Hook scripts import from this file — their imports don't change.
 */

import { join } from "path";
import { homedir } from "os";
import {
  loadApiKey as sharedLoadApiKey,
  storeEpisodic,
  makeDebugLogger,
  KEY_ENV_VAR,
  CONFIG_DIR_ENV_VAR,
} from "../shared/midbrain-common.mjs";

export { storeEpisodic, makeDebugLogger, KEY_ENV_VAR };

/** Claude Code config dir where .midbrain-key lives for this client. */
const CLAUDE_CONFIG_DIR = join(homedir(), ".config", "claude");

/**
 * Loads API key with Claude Code's config dir pre-filled.
 * Falls through to MIDBRAIN_CONFIG_DIR env, env var, then global fallback.
 * @returns {{ key: string, source: string }}
 */
export function loadApiKey() {
  const configDir = process.env[CONFIG_DIR_ENV_VAR] || CLAUDE_CONFIG_DIR;
  return sharedLoadApiKey(undefined, configDir);
}

/**
 * Pre-built debug logger for Claude Code hooks. Appends timestamped lines
 * to ~/midbrain-claude-code-debug.log. Never throws.
 */
export const debugLog = makeDebugLogger(
  join(homedir(), "midbrain-claude-code-debug.log")
);

/**
 * Reads all of stdin as a string, parses JSON. Returns null on failure.
 * Hook-specific — not part of the shared module.
 * @returns {Promise<object|null>}
 */
export async function readStdinJSON() {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return null;
  }
}
