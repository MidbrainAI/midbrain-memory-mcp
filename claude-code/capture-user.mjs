#!/usr/bin/env node
/**
 * Claude Code hook: UserPromptSubmit
 * Captures user prompts as episodic memory.
 *
 * Stdin JSON: { prompt: "...", session_id, ... }
 * Fails silently on any error.
 */

import { readStdinJSON, loadApiKey, storeEpisodic, debugLog } from "./common.mjs";

try {
  const input = await readStdinJSON();
  if (!input?.prompt) process.exit(0);

  const apiKey = loadApiKey();
  if (!apiKey) { debugLog("NO KEY"); process.exit(0); }

  storeEpisodic(apiKey, input.prompt, "user");
} catch { /* fail silently */ }
