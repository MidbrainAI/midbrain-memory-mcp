#!/usr/bin/env node
/**
 * Claude Code hook: Stop
 * Captures the assistant's final response as episodic memory.
 *
 * Stdin JSON: { last_assistant_message: "...", stop_hook_active, ... }
 * Exits immediately if stop_hook_active (prevents infinite loops).
 * Fails silently on any error.
 */

import { readStdinJSON, loadApiKey, storeEpisodic, debugLog } from "./common.mjs";

try {
  const input = await readStdinJSON();
  if (!input) process.exit(0);
  if (input.stop_hook_active) process.exit(0);
  if (!input.last_assistant_message) process.exit(0);

  const apiKey = loadApiKey();
  if (!apiKey) { debugLog("NO KEY"); process.exit(0); }

  storeEpisodic(apiKey, input.last_assistant_message, "assistant");
} catch { /* fail silently */ }
