/**
 * Shared utilities for Claude Code episodic capture hooks.
 * Node 20 builtins only — no npm dependencies.
 *
 * Provides a pre-configured MidbrainApi instance and debug logger.
 * Hook scripts import from this file — their imports don't change.
 */

import { join } from "path";
import { homedir } from "os";
import { MidbrainApi } from "../../shared/midbrain-api.mjs";
import { makeDebugLogger } from "../../shared/logger.mjs";
import { getClient } from "../../shared/clients/registry.mjs";

export { MidbrainApi, makeDebugLogger };

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
