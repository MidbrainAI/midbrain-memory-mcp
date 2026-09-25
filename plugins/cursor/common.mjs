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
 *
 * Cursor waits for the hook PROCESS to exit before it submits the prompt, so
 * the user hook does no network work itself: it writes the mapped prompt to a
 * private job file, starts a detached background child (store-user.mjs) that
 * performs the store under a hard time limit, and exits at once.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn as nodeSpawn } from "child_process";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

import { MidbrainApi } from "../../shared/midbrain-api.mjs";
import { appendToCache } from "../../shared/episodic-cache.mjs";
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
const STORE_JOB_DIR = path.join(os.tmpdir(), "midbrain-cursor-store-jobs");
const STORE_ENTRY = fileURLToPath(new URL("./store-user.mjs", import.meta.url));
// Hard limit for the background user store. On expiry the entry goes to the
// offline cache (boot-time drain) and the background child exits.
export const STORE_TIME_LIMIT_MS = 20_000;
const STORE_TIME_LIMIT_ENV = "MIDBRAIN_CURSOR_STORE_TIMEOUT_MS";
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

/** The only fields a user store needs. Everything else (user_email) is dropped. */
export function userStoreJob(input) {
  const prompt = text(input?.prompt);
  if (!prompt) return null;
  const mapped = toCodexInput(input);
  return { prompt, cwd: mapped.cwd, session_id: mapped.session_id };
}

/**
 * Capture the user prompt without holding it: hand the store to a detached
 * background child and resolve to {"continue": true}. If the child cannot be
 * started, store inline under the same hard time limit.
 */
export async function captureUser(input, deps = makeDefaultDeps()) {
  const job = userStoreJob(input);
  if (!job) return CONTINUE;
  try {
    await (deps.startBackgroundStore || startBackgroundStore)(job, deps);
    return CONTINUE;
  } catch (err) {
    safeLog(deps.logger, `CURSOR BACKGROUND STORE SPAWN ERROR: ${errorMessage(err)}; storing inline`, "warn");
  }
  await storeUserJob(job, deps);
  return CONTINUE;
}

/**
 * Write the job to a private 0600 file and start the detached store child
 * (node directly, no shell, so it works the same on Windows). Resolves once
 * the child has spawned; rejects when it could not start.
 */
export async function startBackgroundStore(job, deps = {}) {
  const spawn = deps.spawn || nodeSpawn;
  const dir = deps.storeJobDir || STORE_JOB_DIR;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const jobFile = path.join(dir, `${randomUUID()}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(job), { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, deps.storeEntry || STORE_ENTRY, jobFile], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  } catch (err) {
    try { fs.rmSync(jobFile, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

function storeTimeLimitMs() {
  const value = Number(process.env[STORE_TIME_LIMIT_ENV]);
  return Number.isInteger(value) && value > 0 ? value : STORE_TIME_LIMIT_MS;
}

/**
 * Store one user prompt with the Cursor metadata under a hard time limit.
 * On expiry the entry is appended to the offline cache under the resolved
 * API's cache scope, so the boot drain recovers it. Never throws.
 *
 * @returns {Promise<"stored"|"failed"|"timeout">}
 */
export async function storeUserJob(job, deps = makeDefaultDeps()) {
  const limitMs = deps.storeTimeLimitMs ?? storeTimeLimitMs();
  const metadata = buildCaptureMetadata({ client: CLIENT, cwd: job.cwd, sessionId: job.session_id });
  let api;
  const work = (async () => {
    api = await deps.createApi(job.cwd);
    const stored = await api.storeEpisodic(job.prompt, "user", deps.logger, metadata);
    return stored === false ? "failed" : "stored";
  })().catch((err) => {
    safeLog(deps.logger, `CURSOR CAPTURE ERROR (user): ${errorMessage(err)}`);
    return "failed";
  });
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), limitMs); });
  const outcome = await Promise.race([work, expired]);
  clearTimeout(timer);
  if (outcome !== "timeout") return outcome;
  if (api) {
    appendToCache({ text: job.prompt, role: "user", memory_metadata: metadata }, api.cacheScope);
    safeLog(deps.logger, `CURSOR CAPTURE TIMEOUT (user): no reply after ${limitMs}ms; cached for boot-time drain`, "warn");
  } else {
    safeLog(deps.logger, `CURSOR CAPTURE TIMEOUT (user): key/host not resolved after ${limitMs}ms; entry dropped`);
  }
  return "timeout";
}

/**
 * Background child body: read and delete the job file, store under the time
 * limit, then run the throttled self-update. Never throws, never writes stdout.
 */
export async function runBackgroundStore(jobFile, deps = makeDefaultDeps()) {
  let job;
  try {
    job = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch (err) {
    safeLog(deps.logger, `CURSOR BACKGROUND STORE READ ERROR: ${errorMessage(err)}`);
  } finally {
    try { fs.rmSync(jobFile, { force: true }); } catch { /* ignore */ }
  }
  if (job && text(job.prompt)) await storeUserJob(job, deps);
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
export function runCursorHook(captureFn, fallback = {}, { selfUpdate = true } = {}) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { buf += chunk; });
  process.stdin.on("end", async () => {
    let payload;
    try {
      payload = await captureFn(JSON.parse(buf || "{}"), makeDefaultDeps());
    } catch { /* fail open */ }
    await finishHook(payload ?? fallback, selfUpdate ? {} : { update: async () => {} });
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

export async function runSelfUpdate() {
  try {
    const { maybeSelfUpdate } = await import("../../install.mjs");
    await maybeSelfUpdate();
  } catch { /* never break the hook */ }
}

function safeLog(logger, message, level = "error") {
  try { logger?.[level]?.(message); } catch { /* ignore */ }
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
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
