#!/usr/bin/env node
/**
 * codex/capture-assistant.mjs — Stop hook wrapper (PRD-008).
 * Reads Codex hook JSON from stdin, forwards to captureAssistant(), exits 0.
 * Stop hook REQUIRES JSON on stdout when exit 0 (per Codex docs).
 */

import { captureAssistant, makeDefaultDeps } from "./common.mjs";

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", async () => {
  try {
    const input = JSON.parse(buf || "{}");
    await captureAssistant(input, makeDefaultDeps());
  } catch { /* fire-and-forget */ }
  process.stdout.write("{}");
  process.exit(0);
});
