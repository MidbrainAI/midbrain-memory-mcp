#!/usr/bin/env node
/**
 * Claude Code hook: Stop
 * Captures the assistant's final response as episodic memory.
 *
 * Stdin JSON: { last_assistant_message: "...", stop_hook_active, ... }
 * Exits immediately if stop_hook_active (prevents infinite loops).
 * Fails silently on any error.
 */

import { readStdinJSON, createApi, log, finishHook } from "./common.mjs";
import { scrubInjectedPkContext } from "../../shared/pk-inject.mjs";

try {
  const input = await readStdinJSON();
  // input.cwd is confirmed present in Claude Desktop's Stop payload
  if (!input) await finishHook(0);
  if (input.stop_hook_active) await finishHook(0);
  if (!input.last_assistant_message) await finishHook(0);

  let api;
  try {
    api = await createApi(input.cwd);
  } catch {
    log.warn("NO KEY");
    await finishHook(0);
  }

  const text = scrubInjectedPkContext(input.last_assistant_message);
  if (text) await api.storeEpisodic(text, "assistant", log, { client: "claude" });
} catch { /* fail silently */ }

await finishHook(0);
