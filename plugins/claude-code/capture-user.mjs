#!/usr/bin/env node
/**
 * Claude Code hook: UserPromptSubmit
 * Captures user prompts as episodic memory and injects relevant procedural
 * knowledge as additionalContext before the LLM processes the message.
 *
 * Stdin JSON: { prompt: "...", session_id, cwd, ... }
 * Stdout JSON (on PK match): { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "..." } }
 * Fails silently on any error — capture and injection never block the turn.
 *
 * Note: Claude Code does not provide conversation history in the hook payload,
 * so exclude_ids is always empty. The same PK entry may appear on subsequent
 * turns within one session. min_score=0.5 limits repetition to relevant entries.
 */

import { readStdinJSON, createApi, debugLog } from "./common.mjs";
import { formatPkContext } from "../../shared/pk-inject.mjs";

try {
  const input = await readStdinJSON();
  if (!input?.prompt) process.exit(0);

  let api;
  try {
    api = await createApi(input.cwd);
  } catch {
    debugLog("NO KEY");
    process.exit(0);
  }

  // Episodic capture — fire-and-forget.
  api.storeEpisodic(input.prompt, "user", debugLog, { client: "claude" });

  // PK injection — 2s timeout inside searchProcedural; returns [] on failure.
  const entries = await api.searchProcedural({ query: input.prompt, excludeIds: [] });
  if (entries.length > 0) {
    const ctx = formatPkContext(entries);
    debugLog(`PK: injected ${entries.length} entries ids=${entries.map((e) => e.id).join(",")}`);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: ctx,
      },
    }));
  }
} catch { /* fail silently */ }
