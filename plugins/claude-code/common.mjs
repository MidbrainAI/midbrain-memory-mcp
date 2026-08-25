/**
 * Shared utilities for Claude Code episodic capture hooks.
 * Node 20 builtins only — no npm dependencies.
 *
 * Provides a pre-configured MidbrainApi instance and debug logger.
 * Hook scripts import from this file — their imports don't change.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";

import { MidbrainApi } from "../../shared/midbrain-api.mjs";
import { makeLogger, logFile } from "../../shared/logger.mjs";
import { getClient } from "../../shared/clients/registry.mjs";

export { MidbrainApi, makeLogger };

/** Capture-client labels must be lowercase slugs, 32 chars max. */
const CLIENT_LABEL_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Creates a MidbrainApi instance for the Claude Code client.
 * Accepts optional cwd (from hook stdin payload) for project-scoped key resolution.
 *
 * Passes the dynamically-detected capture-client label (see
 * captureClientLabel) as the UA client token, so a NanoClaw-hosted Claude
 * Code process self-identifies as "nanoclaw" rather than the static "claude"
 * adapter id -- matching the identity already used for memory_metadata.client.
 *
 * @param {string|undefined} cwd - The project working directory from the hook payload.
 * @returns {Promise<MidbrainApi>}
 */
export async function createApi(cwd) {
  const projectDir = cwd?.trim() || undefined;
  return MidbrainApi.create(getClient("claude"), projectDir, { clientLabel: await captureClientLabel() });
}

/**
 * Resolves the client label attached to captured episodic memories.
 *
 * Inside a NanoClaw container the runtime IS Claude Code and hook child
 * processes receive no env, so the label cannot come from container env.
 * Precedence:
 *   1. MIDBRAIN_CAPTURE_CLIENT env — host topologies where env reaches hooks.
 *   2. ~/.claude/.midbrain-capture-client marker (first line, trimmed) — the
 *      only durable in-container surface; NanoClaw's skill writes "nanoclaw"
 *      into the mounted .claude-shared directory.
 *   3. "claude".
 * A value that fails the slug charset is treated as absent (fall through).
 * Never throws — capture hooks are fail-open.
 * @returns {Promise<string>}
 */
export async function captureClientLabel() {
  const fromEnv = process.env.MIDBRAIN_CAPTURE_CLIENT?.trim();
  if (fromEnv && CLIENT_LABEL_RE.test(fromEnv)) return fromEnv;
  try {
    const markerPath = path.join(os.homedir(), ".claude", ".midbrain-capture-client");
    const firstLine = (await fs.readFile(markerPath, "utf8")).split("\n", 1)[0].trim();
    if (CLIENT_LABEL_RE.test(firstLine)) return firstLine;
  } catch { /* missing or unreadable marker — fall through */ }
  return "claude";
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
    // Event-based read (rather than `for await ... of process.stdin`): the
    // async iterator can leave a native read handle attached during forced
    // teardown on Node 24 for Windows. Consuming to the "end" event lets the
    // stream release its handle before the hook exits naturally.
    const raw = await new Promise((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { buf += chunk; });
      process.stdin.on("end", () => resolve(buf));
      process.stdin.on("error", () => resolve(buf));
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Complete a Claude capture hook after capture work has finished: run the
 * throttled npx self-update check, then exit. The update path may delay hook
 * exit by up to install.mjs's UPDATE_FETCH_TIMEOUT_MS; failures are non-fatal.
 *
 * Call this once after hook work completes; it deliberately avoids forced exit.
 * @param {number} [code=0] - Exit code.
 * @returns {Promise<void>}
 */
export async function finishHook(code = 0) {
  try {
    const { maybeSelfUpdate } = await import("../../install.mjs");
    await maybeSelfUpdate();
  } catch { /* never break the hook */ }
  // Natural exit lets Node release native stdin handles cleanly on Windows.
  process.exitCode = code;
}
