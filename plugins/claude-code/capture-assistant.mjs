#!/usr/bin/env node
/**
 * Claude Code hook: Stop
 * Captures the assistant's final response as episodic memory.
 *
 * Stdin JSON: { last_assistant_message: "...", stop_hook_active, ... }
 * If stop_hook_active, skips capture to prevent loops, then completes the
 * non-fatal hook finish/update path.
 * Fails silently on any error.
 */

import { readStdinJSON, createApi, captureClientLabel, shouldWaitForKey, log, finishHook } from "./common.mjs";
import { appendToSpool } from "../../shared/claude-spool.mjs";
import { scrubInjectedPkContext } from "../../shared/pk-inject.mjs";

try {
  const input = await readStdinJSON();
  // input.cwd is confirmed present in Claude Desktop's Stop payload
  if (!input) await finishHook(0);
  if (input.stop_hook_active) await finishHook(0);
  if (!input.last_assistant_message) await finishHook(0);

  const text = scrubInjectedPkContext(input.last_assistant_message);
  const client = await captureClientLabel();

  let api;
  try {
    api = await createApi(input.cwd, { waitForKey: shouldWaitForKey(client) });
  } catch {
    // No key even after the bounded wait (issue #52): spool the assistant reply
    // to the durable ~/.claude surface for a later server-start flush.
    if (text) {
      log.warn("NO KEY — spooling for recovery");
      appendToSpool({ text, role: "assistant", memory_metadata: { client } });
    }
    await finishHook(0);
  }

  if (text) await api.storeEpisodic(text, "assistant", log, { client });
} catch { /* fail silently */ }

await finishHook(0);
