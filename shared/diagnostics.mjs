/**
 * Secret-free diagnostics helpers shared by the MCP diagnostics tool.
 */

import os from "os";
import path from "path";
import { createHash } from "crypto";
import { inspectCachedEntries } from "./episodic-cache.mjs";
import { logFile } from "./logger.mjs";
import { PKG_VERSION } from "./clients/utils.mjs";

const AUTH_STEP = "check the credential scope against the API host, then re-run the installer";
const CACHE_STEP = "pending entries auto-flush on the next successful capture against this binding";
const HOST_STEP = "verify the non-default host source shown above is intentional";
const SHADOW_STEP = "review the shadowing note before changing any credential";
const FILE_STEP = "repair the credential file shown above, then re-run the installer";

/**
 * Render paths under the user's home with a leading `~` and portable
 * separators. Non-path source labels and paths outside home are unchanged.
 *
 * @param {string} value
 * @param {string} [homeDir]
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function homeRelativePath(
  value,
  homeDir = os.homedir(),
  platform = process.platform,
) {
  if (typeof value !== "string" || !value || /^(?:env:[A-Z0-9_]+|default)$/.test(value)) {
    return value;
  }
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(value) || !paths.isAbsolute(homeDir)) return value;
  const relative = paths.relative(homeDir, value);
  if (relative === "") return "~";
  if (relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) {
    return value;
  }
  return `~/${relative.replaceAll("\\", "/")}`;
}

function keyDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Compare credential contents internally and return only a safe finding. */
export function credentialShadowNote(scope, winnerKey, globalKey) {
  if (!winnerKey || !globalKey || !["project", "client"].includes(scope)) return null;
  if (keyDigest(winnerKey) === keyDigest(globalKey)) return null;
  return `${scope} credential shadows the global credential for this client`;
}

/** Select deterministic remediation guidance from diagnostic findings. */
export function nextStepsFor(state) {
  const steps = [];
  if (state.probeStatus === "auth-failed (401)") steps.push(AUTH_STEP);
  if (state.pendingEntries > 0) steps.push(CACHE_STEP);
  if (state.apiBaseScope && state.apiBaseScope !== "default") {
    steps.push(HOST_STEP);
  }
  if (state.shadowNote) steps.push(SHADOW_STEP);
  if (state.credentialError) steps.push(FILE_STEP);
  return steps;
}

function formatCredentialScope(entry, homeDir) {
  const winner = entry.winner ? " (winner)" : "";
  const source = entry.source ? ` ${homeRelativePath(entry.source, homeDir)}` : "";
  return `  ${entry.scope}: ${entry.status}${winner}${source}`;
}

function credentialCategory(state) {
  return state.keySource?.startsWith("env:")
    ? "environment variable"
    : `${state.keyScope} key file`;
}

function pendingLabel(state) {
  if (state.pendingEntries === 0 && state.cacheFilesPresent) {
    return "0 valid entries (cache files present but unparseable)";
  }
  return String(state.pendingEntries);
}

function staticLines(state) {
  const homeDir = state.homeDir || os.homedir();
  return [
    "MidBrain memory diagnostics",
    `version: ${state.version}`,
    `client: ${state.clientId}`,
    `project: ${state.projectDir ? homeRelativePath(state.projectDir, homeDir) : "not configured"}`,
    `api_host: ${state.apiBase}`,
    `api_scope: ${state.apiBaseScope}`,
    `api_source: ${homeRelativePath(state.apiBaseSource, homeDir)}`,
    `credential_scope: ${state.keyScope}`,
    `credential_source_category: ${credentialCategory(state)}`,
    `credential_source: ${homeRelativePath(state.keySource, homeDir)}`,
  ];
}

/** Assemble the successful diagnostics response in deterministic field order. */
export function assembleDiagnosticsReport(state) {
  const homeDir = state.homeDir || os.homedir();
  const lines = staticLines(state);
  lines.push("credential_scopes:");
  lines.push(...(state.credentialScopes || []).map((entry) => formatCredentialScope(entry, homeDir)));
  if (state.shadowNote) lines.push(`note: ${state.shadowNote}`);
  lines.push(`probe: ${state.probeStatus}`);
  lines.push("capture_mode: fail-open (failures never block the client)");
  lines.push(`pending_entries: ${pendingLabel(state)}`);
  lines.push(`pending_binding: host=${state.apiBase} key_scope=${state.keyScope}`);
  lines.push(`other_cache_bindings_with_pending_entries: ${state.otherBindings}`);
  lines.push(`cache_location: ${homeRelativePath(state.cacheDir, homeDir)}`);
  lines.push(`capture_log: ${homeRelativePath(state.logPath, homeDir)}`);
  lines.push("next_steps:");
  const steps = nextStepsFor(state);
  lines.push(...(steps.length ? steps : ["no action required"]).map((step) => `  - ${step}`));
  return lines.join("\n");
}

function credentialErrorDetails(message, homeDir) {
  if (/No API key configured/i.test(message)) return "no credential found";
  const empty = message.match(/^Key file is empty:\s*(.+)$/i);
  if (empty) return `empty file ${homeRelativePath(empty[1], homeDir)}`;
  const denied = message.match(/^Permission denied reading key file:\s*(.+)$/i);
  if (denied) return `unreadable file ${homeRelativePath(denied[1], homeDir)}`;
  return "credential resolution failed";
}

/** Assemble a paste-safe report when credential resolution prevents API creation. */
export function assembleResolutionFailureReport(state) {
  const homeDir = state.homeDir || os.homedir();
  const detail = credentialErrorDetails(state.error?.message || String(state.error), homeDir);
  const lines = [
    "MidBrain memory diagnostics",
    `version: ${state.version}`,
    `client: ${state.clientId}`,
    `project: ${state.projectDir ? homeRelativePath(state.projectDir, homeDir) : "not configured"}`,
    `credential_error: ${detail}`,
    "scopes_checked: project, client, global, environment",
    "probe: unavailable (credential resolution failed)",
    "next_steps:",
  ];
  const install = detail === "no credential found" ? "run: npx midbrain-memory-mcp install" : FILE_STEP;
  lines.push(`  - ${install}`);
  return lines.join("\n");
}

/** Classify the optional authenticated diagnostics probe without throwing. */
export async function probeApi(api, enabled = true) {
  if (!enabled) return "skipped";
  if (process.env.MIDBRAIN_SIMULATE_OFFLINE === "1") return "network-error";
  try {
    await api.fetch(api.EPISODIC, { page: 1, limit: 1 });
    return "ok";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(message.match(/\bAPI\s+(\d{3})\b/)?.[1]);
    if (status === 401) return "auth-failed (401)";
    if (status >= 400 && status <= 599) return `http-${Math.floor(status / 100)}xx`;
    return "network-error";
  }
}

/** Collect diagnostics from the resolved API instance and return plain text. */
export async function runMemoryDiagnostics(options) {
  const state = {
    version: options.version || PKG_VERSION,
    clientId: options.clientId || "generic",
    projectDir: options.projectDir,
    homeDir: options.homeDir || os.homedir(),
  };
  let api;
  try {
    api = await options.createApi();
  } catch (error) {
    return assembleResolutionFailureReport({ ...state, error });
  }
  const cache = inspectCachedEntries(api.cacheScope);
  return assembleDiagnosticsReport({
    ...state,
    apiBase: api.effectiveApiBase,
    apiBaseScope: api.apiBaseScope,
    apiBaseSource: api.apiBaseSource,
    keyScope: api.keyScope,
    keySource: api.keySource,
    credentialScopes: api.credentialScopes,
    shadowNote: api.credentialShadowNote,
    probeStatus: await probeApi(api, options.probe !== false),
    pendingEntries: cache.count,
    cacheFilesPresent: cache.unparseable,
    otherBindings: cache.otherBindings,
    cacheDir: cache.cacheDir,
    logPath: options.logPath || logFile(`midbrain-${state.clientId}.log`),
  });
}
