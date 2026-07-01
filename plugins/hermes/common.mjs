/**
 * Shared Hermes Agent hook runtime.
 *
 * Hermes fires shell hooks with a JSON payload on stdin and reads an optional
 * JSON response on stdout (both CLI and gateway). We map:
 *   - pre_llm_call  -> capture the user prompt   (extra.user_message)
 *   - post_llm_call -> capture the assistant text (extra.response_text)
 *
 * Failure policy: best-effort capture. A hook must never crash Hermes — every
 * path fails open and returns {} (or the injection payload) on stdout.
 */

import { MidbrainApi } from "../../shared/midbrain-api.mjs";
import { makeLogger, logFile } from "../../shared/logger.mjs";
import { getClient } from "../../shared/clients/registry.mjs";
import { formatPkContext, isPkInjectionEnabled, scrubInjectedPkContext } from "../../shared/pk-inject.mjs";

const HERMES_METADATA = { client: "hermes" };

export async function createApi(cwd) {
  return MidbrainApi.create(getClient("hermes"), cwd);
}

/** Pull a trimmed string field from the Hermes payload's `extra` (or top level). */
function payloadText(input, keys) {
  const sources = [input?.extra, input];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

function payloadCwd(input) {
  const cwd = typeof input?.cwd === "string" && input.cwd.trim() ? input.cwd : undefined;
  return cwd;
}

/**
 * Capture the user prompt as episodic memory. When PK injection is explicitly
 * enabled (legacy opt-in), search for relevant entries and return a Hermes
 * context-injection payload: { context: "..." }.
 *
 * @returns {Promise<object|undefined>} stdout payload, or undefined for none.
 */
export async function captureUser(input, deps = makeDefaultDeps()) {
  const prompt = payloadText(input, ["user_message", "message", "prompt", "text"]);
  if (!prompt) return undefined;

  const projectDir = payloadCwd(input);
  let api;
  try {
    api = await deps.createApi(projectDir);
  } catch (err) {
    safeLog(deps.logger, `HERMES CAPTURE ERROR (user): ${errorMessage(err)}`);
    return undefined;
  }

  await postEpisodic(prompt, "user", deps, api);

  if (!isPkInjectionEnabled()) return undefined;

  // Opt-in legacy PK injection. Hermes prepends `context` to the LLM turn.
  try {
    const entries = await api.searchProcedural({ query: prompt, excludeIds: [] });
    if (entries.length > 0) {
      safeLog(deps.logger, `PK: injected ${entries.length} entries`, "debug");
      return { context: formatPkContext(entries) };
    }
  } catch (err) {
    safeLog(deps.logger, `PK INJECT ERROR: ${errorMessage(err)}`);
  }
  return undefined;
}

/** Capture the assistant's final response as episodic memory. */
export async function captureAssistant(input, deps = makeDefaultDeps()) {
  const raw = payloadText(input, ["response_text", "response", "assistant_message", "text"]);
  const text = scrubInjectedPkContext(raw);
  if (!text) return undefined;

  const projectDir = payloadCwd(input);
  let api;
  try {
    api = await deps.createApi(projectDir);
  } catch (err) {
    safeLog(deps.logger, `HERMES CAPTURE ERROR (assistant): ${errorMessage(err)}`);
    return undefined;
  }

  await postEpisodic(text, "assistant", deps, api);
  return undefined;
}

async function postEpisodic(text, role, deps, api) {
  try {
    if (!text) return true;
    const stored = await Promise.resolve(api.storeEpisodic(text, role, deps.logger, HERMES_METADATA));
    return stored !== false;
  } catch (err) {
    safeLog(deps.logger, `HERMES CAPTURE ERROR (${role}): ${errorMessage(err)}`);
    return false;
  }
}

/**
 * Run a capture function as a Hermes shell hook. Reads stdin JSON, calls
 * captureFn, writes any returned payload to stdout, always emits at least "{}".
 */
export function runJsonHook(captureFn) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { buf += chunk; });
  process.stdin.on("end", async () => {
    let payload;
    try {
      payload = await captureFn(JSON.parse(buf || "{}"), makeDefaultDeps());
    } catch { /* fail open */ }
    if (payload !== undefined && payload !== null) {
      process.stdout.write(JSON.stringify(payload));
    } else {
      process.stdout.write("{}");
    }
    process.exit(0);
  });
}

function safeLog(logger, message, level = "error") {
  try { logger?.[level]?.(message); } catch { /* ignore */ }
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

export function makeDefaultDeps() {
  return {
    createApi,
    logger: makeLogger(logFile("midbrain-hermes.log")),
  };
}
