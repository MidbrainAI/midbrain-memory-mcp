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
  // input.cwd is confirmed present in Claude Desktop's UserPromptSubmit payload
  if (!input?.prompt) process.exit(0);

  let apiKey;
  try {
    const { key } = loadApiKey(input.cwd);
    apiKey = key;
  } catch {
    debugLog("NO KEY");
    process.exit(0);
  }

  storeEpisodic(apiKey, input.prompt, "user", debugLog);
} catch { /* fail silently */ }
