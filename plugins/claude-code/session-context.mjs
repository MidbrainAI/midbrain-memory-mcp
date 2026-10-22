#!/usr/bin/env node
/**
 * Claude Code hook: SessionStart
 * Adds the MidBrain persona and user profile to the session once (issue #61).
 *
 * Claude Code fires SessionStart on startup, resume, /clear and after
 * compaction, so the context comes back whenever the conversation is reset
 * or summarized, and is never repeated on ordinary turns.
 *
 * Stdin JSON: { session_id, cwd, source, ... }
 * Stdout JSON (persona or profile set): { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "..." } }
 * Cursor-hosted runs (Third-Party Imports) are skipped: Cursor gets the same
 * context from the MCP server instructions. Fails open: no output on error.
 */

import {
  readStdinJSON, createApi, captureClientLabel, shouldWaitForKey, isCursorPayload, log, finishHook,
} from "./common.mjs";
import { loadIdentityContext } from "../../shared/identity-context.mjs";

async function sessionContext() {
  const input = await readStdinJSON();
  if (!input || isCursorPayload(input)) return;

  const client = await captureClientLabel();
  const api = await createApi(input.cwd, {
    waitForKey: shouldWaitForKey(client),
    clientLabel: client,
  });
  const context = await loadIdentityContext(api);
  if (!context) return;
  log.info(`IDENTITY: session=${input.session_id || "-"} source=${input.source || "-"} len=${context.length}`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }));
}

try {
  await sessionContext();
} catch (err) {
  log.error(`IDENTITY ERROR: ${err instanceof Error ? err.message : String(err)}`);
}

await finishHook(0);
