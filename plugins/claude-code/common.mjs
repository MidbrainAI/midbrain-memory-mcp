/**
 * Shared utilities for Claude Code episodic capture hooks.
 * Node 20 builtins only — no npm dependencies.
 *
 * Provides a pre-configured MidbrainApi instance and debug logger.
 * Hook scripts import from this file — their imports don't change.
 */

import { MidbrainApi } from "../../shared/midbrain-api.mjs";
import { makeLogger, logFile } from "../../shared/logger.mjs";
import { getClient } from "../../shared/clients/registry.mjs";

export { MidbrainApi, makeLogger };

/**
 * Creates a MidbrainApi instance for the Claude Code client.
 * Accepts optional cwd (from hook stdin payload) for project-scoped key resolution.
 * @param {string|undefined} cwd - The project working directory from the hook payload.
 * @returns {Promise<MidbrainApi>}
 */
export async function createApi(cwd) {
  const projectDir = cwd?.trim() || undefined;
  return MidbrainApi.create(getClient("claude"), projectDir);
}

/**
 * Pre-built leveled logger for Claude Code hooks. Appends timestamped,
 * level-tagged lines to the platform log dir (see shared/logger.mjs).
 * Never throws.
 */
export const log = makeLogger(logFile("midbrain-claude.log"));

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

/**
 * Complete a Claude capture hook after capture work has finished: run the
 * throttled npx self-update check, then exit. The update path may delay hook
 * exit by up to install.mjs's UPDATE_FETCH_TIMEOUT_MS; failures are non-fatal.
 *
 * Call this at every hook exit point instead of process.exit(0) directly.
 * @param {number} [code=0] - Exit code.
 * @returns {Promise<never>}
 */
export async function finishHook(code = 0) {
  try {
    const { maybeSelfUpdate } = await import("../../install.mjs");
    await maybeSelfUpdate();
  } catch { /* never break the hook */ }
  process.exit(code);
}
