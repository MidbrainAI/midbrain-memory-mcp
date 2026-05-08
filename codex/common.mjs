/**
 * codex/common.mjs — Codex embodiment pure functions (PRD-008).
 *
 * Exports pure capture functions with a DI seam for testing.
 * Failure policy: fire-and-forget. Never throw. Never crash the hook.
 */

import path from "path";
import os from "os";

import {
  loadApiKey as sharedLoadApiKey,
  storeEpisodic as sharedStoreEpisodic,
  makeDebugLogger,
} from "../shared/midbrain-common.mjs";

export const CODEX_CONFIG_DIR = path.join(os.homedir(), ".config", "codex");
export const DEBUG_LOG = path.join(os.homedir(), "midbrain-codex-debug.log");

/**
 * Capture a Codex UserPromptSubmit event as episodic memory.
 * @param {{prompt?: string, cwd?: string}} input
 * @param {{loadApiKey: Function, storeEpisodic: Function, debugLog: Function}} deps
 */
export async function captureUser(input, deps) {
  const prompt = input?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) return;
  await postEpisodic(prompt, "user", input?.cwd, deps);
}

/**
 * Capture a Codex Stop event as episodic memory.
 * @param {{last_assistant_message?: string, stop_hook_active?: boolean, cwd?: string}} input
 * @param {{loadApiKey: Function, storeEpisodic: Function, debugLog: Function}} deps
 */
export async function captureAssistant(input, deps) {
  if (input?.stop_hook_active === true) return;
  const msg = input?.last_assistant_message;
  if (typeof msg !== "string" || !msg.trim()) return;
  await postEpisodic(msg, "assistant", input?.cwd, deps);
}

/** @param {string} text @param {"user"|"assistant"} role */
async function postEpisodic(text, role, cwd, deps) {
  try {
    const projectDir = typeof cwd === "string" && cwd.trim() ? cwd : undefined;
    const { key } = deps.loadApiKey(projectDir, CODEX_CONFIG_DIR);
    deps.storeEpisodic(key, text, role, deps.debugLog, "codex");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try { deps.debugLog(`CODEX CAPTURE ERROR (${role}): ${msg}`); } catch { /* swallow */ }
  }
}

/** Build real-world dependency bundle for production wrappers. */
export function makeDefaultDeps() {
  return {
    loadApiKey: sharedLoadApiKey,
    storeEpisodic: sharedStoreEpisodic,
    fetch: globalThis.fetch,
    debugLog: makeDebugLogger(DEBUG_LOG),
  };
}
