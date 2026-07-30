/**
 * Secret-free diagnostics helpers shared by the MCP diagnostics tool.
 */

import os from "os";
import path from "path";
import { inspectCachedEntries } from "./episodic-cache.mjs";
import { logFile } from "./logger.mjs";
import { PKG_VERSION } from "./clients/utils.mjs";

export { credentialShadowNote } from "./credential-scope.mjs";

const AUTH_STEP = "check the credential scope against the API host, then re-run the installer";
const CACHE_STEP = "pending entries auto-flush on the next successful capture against this binding";
const HOST_STEP = "verify the non-default host source shown above is intentional";
const SHADOW_STEP = "review the shadowing note before changing any credential";
const FILE_STEP = "repair the credential file shown above, then re-run the installer";

/**
 * Render paths under the user's home with a leading `~` and portable
 * separators. Non-path source labels are returned unchanged. Absolute paths
 * OUTSIDE the home directory are redacted to their trailing segments (which
 * are non-identifying, e.g. `.midbrain/.midbrain-key`) so a project or network
 * path never leaks a username-bearing prefix into diagnostics output.
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
  if (!paths.isAbsolute(value)) return value;
  if (paths.isAbsolute(homeDir)) {
    const relative = paths.relative(homeDir, value);
    if (relative === "") return "~";
    if (!(relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative))) {
      return `~/${relative.replaceAll("\\", "/")}`;
    }
  }
  // Absolute path outside the current home. Redact only when it traverses a
  // user-home-like directory (another user's home / network mount), which is
  // where a username would leak. System paths (/opt, /srv, /usr, ...) are
  // non-identifying and left intact.
  return traversesUserHome(value) ? redactUserPath(value) : value;
}

const USER_HOME_SEGMENT = /^(?:users|home)$/i;

/** True when an absolute path descends through a user-home-like segment. */
function traversesUserHome(value) {
  const segments = value.split(/[\\/]+/).filter(Boolean);
  // Drop a leading drive letter (e.g. "C:") on win32-style paths.
  const start = /^[a-z]:$/i.test(segments[0]) ? 1 : 0;
  return segments.slice(start, -1).some((seg) => USER_HOME_SEGMENT.test(seg));
}

/** Mask leading directories, keeping only trailing non-identifying segments. */
function redactUserPath(value) {
  const segments = value.split(/[\\/]+/).filter(Boolean);
  const tail = segments.slice(-2).join("/");
  return tail ? `<redacted>/${tail}` : "<redacted>";
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
  // `reason` is a fixed path-free label for error status; `source` is a
  // sanitized path for present entries. Never emit both.
  const detail = entry.reason
    ? ` (${entry.reason})`
    : entry.source
      ? ` ${homeRelativePath(entry.source, homeDir)}`
      : "";
  return `  ${entry.scope}: ${entry.status}${winner}${detail}`;
}

function credentialCategory(state) {
  // Derive from the authoritative resolution scope, not a keySource string
  // prefix, so the category can never disagree with `credential_scope`.
  return state.keyScope === "environment"
    ? "environment variable"
    : `${state.keyScope} key file`;
}

function pendingLabel(state) {
  if (state.pendingEntries === 0 && state.cacheUnparseable) {
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
    // Read-only probe: forbid the GET->POST fallback so the probe can never
    // issue a write-method request against the episodic write endpoint.
    await api.fetch(api.EPISODIC, { page: 1, limit: 1 }, { allowPostFallback: false });
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
    cacheUnparseable: cache.unparseable,
    otherBindings: cache.otherBindings,
    cacheDir: cache.cacheDir,
    logPath: options.logPath || logFile(`midbrain-${state.clientId}.log`),
  });
}
