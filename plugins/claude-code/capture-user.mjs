#!/usr/bin/env node
/**
 * Claude Code hook: UserPromptSubmit
 * Captures user prompts as episodic memory. Automatic procedural-knowledge
 * injection is disabled by default and only runs when explicitly opted in.
 *
 * Stdin JSON: { prompt: "...", session_id, cwd, ... }
 * session_id and cwd are forwarded into episodic memory_metadata for scoping.
 * Stdout JSON (on opted-in PK match): { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "..." } }
 * Capture failures are non-fatal. Capture completes before finishHook(), whose
 * throttled self-update check may delay hook exit by up to UPDATE_FETCH_TIMEOUT_MS.
 *
 * Note: Claude Code does not provide conversation history in the hook payload,
 * so exclude_ids is always empty. The same PK entry may appear on subsequent
 * turns within one session. min_score=0.5 limits repetition to relevant entries.
 */

import { readStdinJSON, createApi, captureClientLabel, shouldWaitForKey, isNoKeyError, log, finishHook } from "./common.mjs";
import { appendToSpool } from "../../shared/claude-spool.mjs";
import { buildCaptureMetadata } from "../../shared/capture-metadata.mjs";
import { formatPkContext, isPkInjectionEnabled } from "../../shared/pk-inject.mjs";

async function captureUser() {
  const input = await readStdinJSON();
  if (!input?.prompt) return;

  const client = await captureClientLabel();
  const metadata = buildCaptureMetadata({
    client,
    cwd: input.cwd,
    sessionId: input.session_id,
  });

  let api;
  try {
    api = await createApi(input.cwd, {
      waitForKey: shouldWaitForKey(client),
      clientLabel: client,
    });
  } catch (error) {
    // No key even after the bounded wait (issue #52): spool the opener to the
    // durable ~/.claude surface so a later authenticated server-start flush
    // recovers it, instead of dropping it.
    if (client === "nanoclaw" && isNoKeyError(error) && appendToSpool({
      text: input.prompt,
      role: "user",
      memory_metadata: metadata,
    })) log.warn("NO KEY — spooling for recovery");
    return;
  }

  // Episodic capture must complete before default-off exits.
  await api.storeEpisodic(input.prompt, "user", log, metadata);

  if (!isPkInjectionEnabled()) return;

  // Opt-in legacy PK injection — 2s timeout inside searchProcedural.
  const entries = await api.searchProcedural({ query: input.prompt, excludeIds: [] });
  if (entries.length > 0) {
    const ctx = formatPkContext(entries);
    log.debug(`PK: injected ${entries.length} entries ids=${entries.map((e) => e.id).join(",")}`);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: ctx,
      },
    }));
  }
}

try {
  await captureUser();
} catch { /* fail silently */ }

await finishHook(0);
