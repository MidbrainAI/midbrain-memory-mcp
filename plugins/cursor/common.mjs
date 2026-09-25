/**
 * Shared Cursor hook runtime.
 *
 * Cursor fires hooks from ~/.cursor/hooks.json with a JSON payload on stdin:
 *   - beforeSubmitPrompt -> capture the user prompt (`prompt`)
 *   - postToolUse        -> buffer one tool event for the turn
 *   - afterAgentResponse -> capture the assistant text (`text`) plus the
 *                           buffered tool summary
 *
 * Tool buffering and assistant capture reuse the Codex runtime: the Cursor
 * payload is mapped onto the Codex field names (conversation_id -> session_id,
 * generation_id -> turn_id, workspace_roots[0] -> cwd). Only mapped fields
 * reach capture, so Cursor's `user_email` is never sent to the API.
 *
 * Failure policy: best-effort capture. A hook never blocks Cursor:
 * beforeSubmitPrompt always answers {"continue": true}, every other hook
 * answers {}, and the process exits 0.
 */

import os from "os";
import path from "path";

import { MidbrainApi } from "../../shared/midbrain-api.mjs";
import { makeLogger, logFile } from "../../shared/logger.mjs";
import { getClient } from "../../shared/clients/registry.mjs";
import { buildCaptureMetadata } from "../../shared/capture-metadata.mjs";
import {
  captureAssistant as captureCodexAssistant,
  captureToolUse as captureCodexToolUse,
} from "../codex/common.mjs";

const CLIENT = "cursor";
const ASSISTANT_BUFFER_DIR = path.join(os.tmpdir(), "midbrain-cursor-assistant-turns");
const TOOL_BUFFER_DIR = path.join(os.tmpdir(), "midbrain-cursor-tool-events");
export const CONTINUE = Object.freeze({ continue: true });

export async function createApi(cwd) {
  return MidbrainApi.create(getClient(CLIENT), cwd);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function payloadCwd(input) {
  const roots = Array.isArray(input?.workspace_roots) ? input.workspace_roots : [];
  return text(roots[0]) ? roots[0] : (text(input?.cwd) ? input.cwd : undefined);
}

function parseToolOutput(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

/** Map a Cursor payload onto the Codex hook fields. Drops everything else. */
export function toCodexInput(input) {
  const mapped = {
    cwd: payloadCwd(input),
    session_id: typeof input?.conversation_id === "string" ? input.conversation_id : undefined,
    turn_id: typeof input?.generation_id === "string" ? input.generation_id : undefined,
  };
  if (input?.tool_name !== undefined) {
    mapped.tool_name = input?.tool_name;
    mapped.tool_use_id = input?.tool_use_id;
    mapped.tool_input = input?.tool_input;
    mapped.tool_response = parseToolOutput(input?.tool_output);
  }
  if (input?.text !== undefined) mapped.last_assistant_message = input.text;
  return mapped;
}

/**
 * Capture the user prompt. Always resolves to {"continue": true} so a
 * capture failure can never block the prompt.
 */
export async function captureUser(input, deps = makeDefaultDeps()) {
  const prompt = text(input?.prompt);
  if (!prompt) return CONTINUE;
  const mapped = toCodexInput(input);
  try {
    const api = await deps.createApi(mapped.cwd);
    const metadata = buildCaptureMetadata({ client: CLIENT, cwd: mapped.cwd, sessionId: mapped.session_id });
    await api.storeEpisodic(prompt, "user", deps.logger, metadata);
  } catch (err) {
    safeLog(deps.logger, `CURSOR CAPTURE ERROR (user): ${err instanceof Error ? err.message : String(err)}`);
  }
  return CONTINUE;
}

/** Buffer one tool event for the current generation (no API call). */
export async function captureToolUse(input, deps = makeDefaultDeps()) {
  await captureCodexToolUse(toCodexInput(input), deps);
}

/** Capture the assistant response plus this generation's tool summary. */
export async function captureAssistant(input, deps = makeDefaultDeps()) {
  await captureCodexAssistant(toCodexInput(input), deps);
}

/**
 * Run a capture function as a Cursor hook: read stdin JSON, capture, write the
 * hook response (the fallback when capture fails), run the throttled update
 * check, exit 0.
 */
export function runCursorHook(captureFn, fallback = {}) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { buf += chunk; });
  process.stdin.on("end", async () => {
    let payload;
    try {
      payload = await captureFn(JSON.parse(buf || "{}"), makeDefaultDeps());
    } catch { /* fail open */ }
    await finishHook(payload ?? fallback);
  });
}

export async function finishHook(payload, deps = {}) {
  const write = deps.write || ((out) => process.stdout.write(out));
  const update = deps.update || runSelfUpdate;
  const exit = deps.exit || ((code) => process.exit(code));
  write(JSON.stringify(payload ?? {}));
  try { await update(); } catch { /* never break the hook */ }
  exit(0);
}

async function runSelfUpdate() {
  try {
    const { maybeSelfUpdate } = await import("../../install.mjs");
    await maybeSelfUpdate();
  } catch { /* never break the hook */ }
}

function safeLog(logger, message, level = "error") {
  try { logger?.[level]?.(message); } catch { /* ignore */ }
}

export function makeDefaultDeps() {
  return {
    client: CLIENT,
    createApi,
    logger: makeLogger(logFile("midbrain-cursor.log")),
    assistantBufferDir: ASSISTANT_BUFFER_DIR,
    toolBufferDir: TOOL_BUFFER_DIR,
  };
}
