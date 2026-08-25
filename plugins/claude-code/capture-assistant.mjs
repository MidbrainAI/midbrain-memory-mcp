#!/usr/bin/env node
/**
 * Claude Code hook: Stop
 * Captures the assistant's final response as episodic memory.
 *
 * Stdin JSON: { last_assistant_message: "...", transcript_path, stop_hook_active, ... }
 * If stop_hook_active, skips capture to prevent loops, then completes the
 * non-fatal hook finish/update path.
 * Fails silently on any error.
 */

import fs from "node:fs/promises";

import { readStdinJSON, createApi, captureClientLabel, shouldWaitForKey, isNoKeyError, log, finishHook } from "./common.mjs";
import { appendToSpool } from "../../shared/claude-spool.mjs";
import { scrubInjectedPkContext } from "../../shared/pk-inject.mjs";

const NANOCLAW_SEND_MESSAGE = "mcp__nanoclaw__send_message";
const INTERNAL_ONLY_RE = /^\s*<internal>[\s\S]*<\/internal>\s*$/;

/** Recover the last message NanoClaw actually delivered in the current human turn. */
async function deliveredNanoclawMessage(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath.trim()) return "";
  try {
    let delivered = "";
    for (const line of (await fs.readFile(transcriptPath, "utf8")).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      const message = item?.message;
      if (item?.type === "user" && message?.role === "user" && typeof message.content === "string") {
        delivered = "";
        continue;
      }
      if (item?.type !== "assistant" || message?.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type === "tool_use" && block.name === NANOCLAW_SEND_MESSAGE &&
            typeof block.input?.text === "string" && block.input.text.trim()) {
          delivered = block.input.text.trim();
        }
      }
    }
    return delivered;
  } catch {
    return "";
  }
}

async function captureAssistant() {
  const input = await readStdinJSON();
  // input.cwd is confirmed present in Claude Desktop's Stop payload
  if (!input) return;
  if (input.stop_hook_active) return;
  if (!input.last_assistant_message) return;

  const client = await captureClientLabel();
  let text = scrubInjectedPkContext(input.last_assistant_message);
  if (client === "nanoclaw" && INTERNAL_ONLY_RE.test(text)) {
    text = scrubInjectedPkContext(await deliveredNanoclawMessage(input.transcript_path));
  }
  if (!text) return;

  let api;
  try {
    api = await createApi(input.cwd, { waitForKey: shouldWaitForKey(client) });
  } catch (error) {
    // No key even after the bounded wait (issue #52): spool the assistant reply
    // to the durable ~/.claude surface for a later server-start flush.
    if (text) {
      if (client === "nanoclaw" && isNoKeyError(error) && appendToSpool({
        text,
        role: "assistant",
        memory_metadata: { client },
      })) log.warn("NO KEY — spooling for recovery");
    }
    return;
  }

  if (text) await api.storeEpisodic(text, "assistant", log, { client });
}

try {
  await captureAssistant();
} catch { /* fail silently */ }

await finishHook(0);
