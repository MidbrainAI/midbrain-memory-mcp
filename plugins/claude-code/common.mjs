/**
 * Shared utilities for Claude Code episodic capture hooks.
 * Node 20 builtins only — no npm dependencies.
 *
 * Provides a pre-configured MidbrainApi instance and debug logger.
 * Hook scripts import from this file — their imports don't change.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";

import { MidbrainApi } from "../../shared/midbrain-api.mjs";
import { makeLogger, logFile } from "../../shared/logger.mjs";
import { getClient } from "../../shared/clients/registry.mjs";

export { MidbrainApi, makeLogger };

/** Capture-client labels must be lowercase slugs, 32 chars max. */
const CLIENT_LABEL_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Marker in the MidbrainApi.create() error thrown when no key resolves. */
const NO_KEY_ERROR_FRAGMENT = "No API key configured";

/** Default bounded key-wait budget (ms). Overridable via env for tests. */
const KEY_WAIT_DEADLINE_MS = 20_000;
const KEY_WAIT_POLL_MS = 500;

function keyWaitDeadlineMs() {
  const raw = Number(process.env.MIDBRAIN_KEY_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : KEY_WAIT_DEADLINE_MS;
}

function keyWaitPollMs() {
  const raw = Number(process.env.MIDBRAIN_KEY_WAIT_POLL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : KEY_WAIT_POLL_MS;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True only for the specific "no key resolved" throw, not other config errors. */
export function isNoKeyError(err) {
  return Boolean(err && typeof err.message === "string" && err.message.includes(NO_KEY_ERROR_FRAGMENT));
}

/**
 * Creates a MidbrainApi instance for the Claude Code client.
 *
 * Bounded key-wait (issue #52): on a cold NanoClaw container wake the opening
 * message's hook can fire before the MCP server has persisted the API key
 * (~/.config/midbrain is ephemeral and repopulated by self-repair after the
 * server connects). Rather than immediately dropping the opener, poll the full
 * key-resolution chain (through MidbrainApi.create — never reading key files
 * directly) until a key appears or a deadline inside the 30s hook timeout is
 * reached. Only the specific "no key" failure is retried; any other error
 * (bad host, malformed config) fails fast. The deadline/poll are env-tunable
 * for tests.
 *
 * The wait applies ONLY when a key is expected imminently — i.e. in a NanoClaw
 * container, detected via the resolved capture-client label ("nanoclaw"). A
 * plain host Claude install with no key must fail open FAST (no 20s block), so
 * when `waitForKey` is false a missing key throws on the first attempt.
 *
 * @param {string|undefined} cwd - The project working directory from the hook payload.
 * @param {{ waitForKey?: boolean }} [opts]
 * @returns {Promise<MidbrainApi>}
 */
export async function createApi(cwd, { waitForKey = false } = {}) {
  const projectDir = cwd?.trim() || undefined;
  const client = getClient("claude");
  const deadline = Date.now() + (waitForKey ? keyWaitDeadlineMs() : 0);
  const pollMs = keyWaitPollMs();
  for (;;) {
    try {
      return await MidbrainApi.create(client, projectDir);
    } catch (err) {
      if (!isNoKeyError(err) || Date.now() + pollMs > deadline) throw err;
      await sleep(pollMs);
    }
  }
}

/** True when the resolved capture-client label indicates a NanoClaw container. */
export function shouldWaitForKey(clientLabel) {
  return clientLabel === "nanoclaw";
}

/**
 * Resolves the client label attached to captured episodic memories.
 *
 * Inside a NanoClaw container the runtime IS Claude Code and hook child
 * processes receive no env, so the label cannot come from container env.
 * Precedence:
 *   1. MIDBRAIN_CAPTURE_CLIENT env — host topologies where env reaches hooks.
 *   2. ~/.claude/.midbrain-capture-client marker (first line, trimmed) — the
 *      only durable in-container surface; NanoClaw's skill writes "nanoclaw"
 *      into the mounted .claude-shared directory.
 *   3. "claude".
 * A value that fails the slug charset is treated as absent (fall through).
 * Never throws — capture hooks are fail-open.
 * @returns {Promise<string>}
 */
export async function captureClientLabel() {
  const fromEnv = process.env.MIDBRAIN_CAPTURE_CLIENT?.trim();
  if (fromEnv && CLIENT_LABEL_RE.test(fromEnv)) return fromEnv;
  try {
    const markerPath = path.join(os.homedir(), ".claude", ".midbrain-capture-client");
    const firstLine = (await fs.readFile(markerPath, "utf8")).split("\n", 1)[0].trim();
    if (CLIENT_LABEL_RE.test(firstLine)) return firstLine;
  } catch { /* missing or unreadable marker — fall through */ }
  return "claude";
}

/**
 * Pre-built leveled logger for Claude Code hooks. Appends timestamped,
 * level-tagged lines to the platform log dir (see shared/logger.mjs).
 * Never throws.
 */
export const log = makeLogger(logFile("midbrain-claude.log"));

/**
 * Reads all of stdin as a string, parses JSON. Returns null on failure.
 * Hook-specific — not part of the shared module.
 * @returns {Promise<object|null>}
 */
export async function readStdinJSON() {
  try {
    // Event-based read (rather than `for await ... of process.stdin`): the
    // async iterator can leave a native read handle attached during forced
    // teardown on Node 24 for Windows. Consuming to the "end" event lets the
    // stream release its handle before the hook exits naturally.
    const raw = await new Promise((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { buf += chunk; });
      process.stdin.on("end", () => resolve(buf));
      process.stdin.on("error", () => resolve(buf));
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Complete a Claude capture hook after capture work has finished: run the
 * throttled npx self-update check, then exit. The update path may delay hook
 * exit by up to install.mjs's UPDATE_FETCH_TIMEOUT_MS; failures are non-fatal.
 *
 * Call this once after hook work completes; it deliberately avoids forced exit.
 * @param {number} [code=0] - Exit code.
 * @returns {Promise<void>}
 */
export async function finishHook(code = 0) {
  try {
    const { maybeSelfUpdate } = await import("../../install.mjs");
    await maybeSelfUpdate();
  } catch { /* never break the hook */ }
  // Natural exit lets Node release native stdin handles cleanly on Windows.
  process.exitCode = code;
}
