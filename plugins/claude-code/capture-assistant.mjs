#!/usr/bin/env node
/**
 * Claude Code hook: Stop
 * Captures the assistant's final response as episodic memory.
 *
 * Stdin JSON: { last_assistant_message: "...", transcript_path, stop_hook_active, session_id, cwd, ... }
 * session_id and cwd are forwarded into episodic memory_metadata for scoping.
 * If stop_hook_active, skips capture to prevent loops, then completes the
 * non-fatal hook finish/update path.
 * Fails silently on any error.
 */

import { readStdinJSON, createApi, captureClientLabel, shouldWaitForKey, isNoKeyError, log, finishHook } from "./common.mjs";
import { appendToSpool } from "../../shared/claude-spool.mjs";
import { claimLegacyOpenerRecovery } from "../../shared/claude-opener-recovery.mjs";
import {
  deliveredNanoclawMessage,
  readClaudeTranscript,
  recoverLegacyOpener,
} from "../../shared/claude-transcript.mjs";
import { buildCaptureMetadata } from "../../shared/capture-metadata.mjs";
import { scrubInjectedPkContext } from "../../shared/pk-inject.mjs";

const INTERNAL_ONLY_RE = /^\s*<internal>[\s\S]*<\/internal>\s*$/;

async function captureAssistant() {
  const input = await readStdinJSON();
  // input.cwd is confirmed present in Claude Desktop's Stop payload
  if (!input) return;
  if (input.stop_hook_active) return;
  if (!input.last_assistant_message) return;

  const client = await captureClientLabel();
  const metadata = buildCaptureMetadata({
    client,
    cwd: input.cwd,
    sessionId: input.session_id,
  });
  const transcriptRows = client === "nanoclaw"
    ? readClaudeTranscript(input.transcript_path)
    : null;
  let text = scrubInjectedPkContext(input.last_assistant_message);
  if (client === "nanoclaw" && INTERNAL_ONLY_RE.test(text)) {
    text = scrubInjectedPkContext(deliveredNanoclawMessage(transcriptRows));
  }
  if (!text) return;

  let recoveredUser = "";
  if (client === "nanoclaw") {
    try {
      const candidate = recoverLegacyOpener(transcriptRows, {
        sessionId: input.session_id,
        cwd: input.cwd,
        hookEventName: input.hook_event_name,
        lastAssistantMessage: input.last_assistant_message,
      });
      if (candidate && claimLegacyOpenerRecovery()) recoveredUser = candidate;
    } catch { /* recovery uncertainty never blocks assistant capture */ }
  }

  let api;
  try {
    api = await createApi(input.cwd, {
      waitForKey: shouldWaitForKey(client),
      clientLabel: client,
    });
  } catch (error) {
    // No key even after the bounded wait (issue #52): spool the assistant reply
    // to the durable ~/.claude surface for a later server-start flush.
    if (text) {
      if (client === "nanoclaw" && isNoKeyError(error) && appendToSpool({
        text,
        role: "assistant",
        memory_metadata: metadata,
      })) log.warn("NO KEY — spooling for recovery");
    }
    return;
  }

  if (recoveredUser) {
    try { await api.postEpisodicResult(recoveredUser, "user", metadata); } catch { /* terminal: never retry */ }
  }
  await api.storeEpisodic(text, "assistant", log, metadata);
}

try {
  await captureAssistant();
} catch { /* fail silently */ }

await finishHook(0);
