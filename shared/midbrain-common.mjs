/**
 * shared/midbrain-common.mjs
 *
 * Shared utilities and constants for MidBrain Memory components.
 * Consumed by: server.js, claude-code/common.mjs, and plugin/midbrain-memory.ts.
 *
 * Plain JavaScript — Node 20 + Bun compatible. No TypeScript. No npm deps.
 * Uses only Node 20 built-ins: fs, os, path.
 */

import { readFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// --- Constants ---

export const API_BASE_URL = "https://memory.midbrain.ai";
export const EPISODIC_ENDPOINT = `${API_BASE_URL}/api/v1/memories/episodic`;
export const SEARCH_ENDPOINT = `${API_BASE_URL}/api/v1/memories/search`;
export const KEY_ENV_VAR = "MIDBRAIN_API_KEY";
export const KEY_FILENAME = ".midbrain-key";
export const PROJECT_DIR_ENV_VAR = "MIDBRAIN_PROJECT_DIR";
export const CONFIG_DIR_ENV_VAR = "MIDBRAIN_CONFIG_DIR";
export const GLOBAL_KEY_PATH = join(homedir(), ".config", "midbrain", KEY_FILENAME);
export const DEFAULT_SEARCH_LIMIT = 10;

// --- loadApiKey ---

/**
 * Resolves the MidBrain API key using a file-first priority chain:
 * 1a. .midbrain-key in projectDir argument (per-project override)
 * 1b. .midbrain/.midbrain-key in projectDir argument (subdirectory convention)
 * 2a. .midbrain-key from MIDBRAIN_PROJECT_DIR env (when projectDir arg is falsy)
 * 2b. .midbrain/.midbrain-key from MIDBRAIN_PROJECT_DIR env (subdirectory convention)
 * 3.  .midbrain-key in configDir argument (per-client config dir)
 * 4.  .midbrain-key in MIDBRAIN_CONFIG_DIR env (when configDir arg is falsy)
 * 5.  MIDBRAIN_API_KEY env var (CI / debug fallback only)
 * 6.  ~/.config/midbrain/.midbrain-key (global default)
 * 7.  Throws a human-readable error if none found.
 *
 * EACCES on any key file is a hard error (throw). Empty key files are hard errors.
 *
 * @param {string|undefined} projectDir - Optional project directory to check first.
 * @param {string|undefined} configDir  - Optional client-specific config directory.
 * @returns {{ key: string, source: string }} The resolved key and a debug description of its source.
 */
export function loadApiKey(projectDir, configDir) {
  // Normalize: empty/whitespace-only projectDir treated as undefined
  projectDir = projectDir?.trim() || undefined;

  const hadProjectDir = Boolean(projectDir);

  // 1a. Explicit projectDir arg — flat file
  if (projectDir) {
    const result = tryReadKey(join(projectDir, KEY_FILENAME), `project-arg:${projectDir}`);
    if (result) return result;
  }

  // 1b. Explicit projectDir arg — .midbrain/ subdirectory
  if (projectDir) {
    const result = tryReadKey(join(projectDir, ".midbrain", KEY_FILENAME), `project-arg:${projectDir}/.midbrain`);
    if (result) return result;
  }

  // 2a. MIDBRAIN_PROJECT_DIR env — flat file (only when no explicit projectDir arg)
  if (!projectDir && process.env[PROJECT_DIR_ENV_VAR]) {
    const envDir = process.env[PROJECT_DIR_ENV_VAR];
    const result = tryReadKey(join(envDir, KEY_FILENAME), `project-env:${envDir}`);
    if (result) return result;

    // 2b. MIDBRAIN_PROJECT_DIR env — .midbrain/ subdirectory
    const resultSub = tryReadKey(join(envDir, ".midbrain", KEY_FILENAME), `project-env:${envDir}/.midbrain`);
    if (resultSub) return resultSub;
  }

  // 3. Explicit configDir arg (per-client config directory)
  if (configDir) {
    const result = tryReadKey(join(configDir, KEY_FILENAME), `config-arg:${configDir}`);
    if (result) return result;
  }

  // 4. MIDBRAIN_CONFIG_DIR env (when configDir arg is falsy)
  if (!configDir && process.env[CONFIG_DIR_ENV_VAR]) {
    const envCfg = process.env[CONFIG_DIR_ENV_VAR];
    const result = tryReadKey(join(envCfg, KEY_FILENAME), `config-env:${envCfg}`);
    if (result) return result;
  }

  // 5. MIDBRAIN_API_KEY env var (CI / debug fallback)
  if (process.env[KEY_ENV_VAR]) {
    const key = process.env[KEY_ENV_VAR].trim();
    if (key) return { key, source: "env" };
  }

  // 6. Global default ~/.config/midbrain/.midbrain-key
  {
    const result = tryReadKey(GLOBAL_KEY_PATH, `global:${GLOBAL_KEY_PATH}`);
    if (result) {
      // WARN: project-tier was specified but fell through to global
      if (hadProjectDir) {
        console.error(
          `[midbrain] WARN: project dir "${projectDir}" has no .midbrain-key — ` +
          `using global key from ${GLOBAL_KEY_PATH}. ` +
          `To scope memory to this project, create .midbrain/.midbrain-key in the project root.`
        );
      }
      return result;
    }
  }

  throw new Error(
    `API key not found. Create ${KEY_FILENAME} or .midbrain/${KEY_FILENAME} in your project directory, ` +
    `or ${KEY_FILENAME} in your client config directory, ` +
    `or in ${GLOBAL_KEY_PATH}, or set ${KEY_ENV_VAR} env var.`
  );
}

/**
 * Attempts to read a key from a file path. Returns { key, source } or null.
 * Throws on EACCES (permission denied) or empty key file — these are broken
 * configs, not "key not found". All other fs errors fall through silently.
 * @param {string} filePath
 * @param {string} source
 * @returns {{ key: string, source: string }|null}
 */
function tryReadKey(filePath, source) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const key = raw.trim();
    if (!key) {
      throw new Error(
        `Key file is empty: ${filePath}. Remove it or add a valid API key.`
      );
    }
    return { key, source };
  } catch (err) {
    if (err.code === "EACCES") {
      throw new Error(
        `Permission denied reading key file: ${filePath}. Check file permissions (expected chmod 600).`
      );
    }
    // Empty-key error (no .code) — re-throw as-is
    if (!err.code) throw err;
    // ENOENT, ENOTDIR, and any other fs error — fall through
    return null;
  }
}

// --- storeEpisodic ---

/**
 * Fire-and-forget POST of an episodic memory to the MidBrain API.
 * Returns void immediately; network call runs in the background.
 *
 * @param {string} apiKey - The MidBrain API key.
 * @param {string} text - The message text to store.
 * @param {"user"|"assistant"} role - The role of the message author.
 * @param {function(string): void} debugLogFn - A logging function for debug output.
 */
export function storeEpisodic(apiKey, text, role, debugLogFn) {
  debugLogFn(`STORE: role=${role} textLen=${text.length}`);
  fetch(EPISODIC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ text, role }),
  })
    .then((r) => debugLogFn(`STORED: status=${r.status}`))
    .catch((e) => debugLogFn(`STORE ERROR: ${e instanceof Error ? e.message : String(e)}`));
}

// --- makeDebugLogger ---

/**
 * Creates a debug logging function that appends timestamped lines to a file.
 * The returned function never throws — all errors are silently swallowed.
 *
 * @param {string} logPath - Absolute path to the log file.
 * @returns {function(string): void} A debugLog(msg) function.
 */
export function makeDebugLogger(logPath) {
  return function debugLog(msg) {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {
      // swallow — never crash callers over logging
    }
  };
}
