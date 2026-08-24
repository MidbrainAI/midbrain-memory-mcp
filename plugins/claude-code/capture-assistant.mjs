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

import { readStdinJSON, createApi, captureClientLabel, log, finishHook } from "./common.mjs";
import { scrubInjectedPkContext } from "../../shared/pk-inject.mjs";

async function captureAssistant() {
  const input = await readStdinJSON();
  // input.cwd is confirmed present in Claude Desktop's Stop payload
  if (!input) return;
  if (input.stop_hook_active) return;
  if (!input.last_assistant_message) return;

  let api;
  try {
    api = await createApi(input.cwd);
  } catch {
    log.warn("NO KEY");
    return;
  }

  const text = scrubInjectedPkContext(input.last_assistant_message);
  if (text) await api.storeEpisodic(text, "assistant", log, { client: await captureClientLabel() });
}

try {
  await captureAssistant();
} catch { /* fail silently */ }

await finishHook(0);
