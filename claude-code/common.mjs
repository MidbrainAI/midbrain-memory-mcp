/**
 * Shared utilities for Claude Code episodic capture hooks.
 * Node 20 builtins only — no npm dependencies.
 */

import { appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// --- Constants ---
const API_BASE_URL = "https://memory.midbrain.ai";
const EPISODIC_ENDPOINT = `${API_BASE_URL}/api/v1/memories/episodic`;
const KEY_ENV_VAR = "MIDBRAIN_API_KEY";
const DEBUG_LOG_PATH = join(homedir(), "midbrain-claude-code-debug.log");

/**
 * Appends a timestamped line to the debug log. Never throws.
 */
export function debugLog(msg) {
  try {
    appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
}

/**
 * Reads the API key from MIDBRAIN_API_KEY env var.
 * For Claude Code hooks, this is set via the command prefix in settings.json.
 * @returns {string|null}
 */
export function loadApiKey() {
  if (process.env[KEY_ENV_VAR]) return process.env[KEY_ENV_VAR].trim();
  return null;
}

/**
 * Reads all of stdin as a string, parses JSON. Returns null on failure.
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
 * POSTs an episodic memory. Fire-and-forget — caller should not await.
 */
export function storeEpisodic(apiKey, text, role) {
  debugLog(`STORE role=${role} len=${text.length}`);
  fetch(EPISODIC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ text, role }),
  })
    .then((r) => debugLog(`STORED status=${r.status}`))
    .catch((e) => debugLog(`STORE ERROR: ${e.message}`));
}
