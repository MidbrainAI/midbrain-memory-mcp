#!/usr/bin/env node
/**
 * codex/capture-user.mjs — UserPromptSubmit hook wrapper (PRD-008).
 * Reads Codex hook JSON from stdin, forwards to captureUser(), exits 0.
 */

import { captureUser, makeDefaultDeps } from "./common.mjs";

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", async () => {
  try {
    const input = JSON.parse(buf || "{}");
    await captureUser(input, makeDefaultDeps());
  } catch { /* fire-and-forget */ }
  process.exit(0);
});
