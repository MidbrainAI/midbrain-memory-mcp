#!/usr/bin/env node
/**
 * codex/capture-tool.mjs — PostToolUse hook wrapper.
 * Reads Codex hook JSON from stdin, forwards to captureToolUse(), exits 0.
 */

import { captureToolUse, makeDefaultDeps } from "./common.mjs";

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", async () => {
  try {
    const input = JSON.parse(buf || "{}");
    await captureToolUse(input, makeDefaultDeps());
  } catch { /* best-effort */ }
  process.stdout.write("{}");
  process.exit(0);
});
