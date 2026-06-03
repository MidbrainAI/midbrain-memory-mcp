#!/usr/bin/env node
/**
 * Claude Code hook: Stop
 * Captures the assistant's final response as episodic memory.
 *
 * Stdin JSON: { last_assistant_message: "...", stop_hook_active, ... }
 * Exits immediately if stop_hook_active (prevents infinite loops).
 * Fails silently on any error.
 */

import { readStdinJSON, createApi, debugLog } from "./common.mjs";

try {
  const input = await readStdinJSON();
  // input.cwd is confirmed present in Claude Desktop's Stop payload
  if (!input) process.exit(0);
  if (input.stop_hook_active) process.exit(0);
  if (!input.last_assistant_message) process.exit(0);

  let api;
  try {
    api = await createApi(input.cwd);
  } catch {
    debugLog("NO KEY");
    process.exit(0);
  }

  api.storeEpisodic(input.last_assistant_message, "assistant", debugLog, { client: "claude" });
} catch { /* fail silently */ }
