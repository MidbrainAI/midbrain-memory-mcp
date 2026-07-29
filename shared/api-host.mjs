/**
 * Unified API-host resolution for MCP and capture runtimes.
 *
 * The resolver performs local file I/O only. It never probes the selected
 * host and never handles credential contents.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const DEFAULT_API_BASE = "https://memory.midbrain.ai";
export const API_URL_ENV = "MIDBRAIN_API_URL";

const CONFIG_FILENAME = "config.json";
const MIDBRAIN_DIR = ".midbrain";
const TERMINAL_CWD_PLACEHOLDER = "${TERMINAL_CWD}";

function warn(message) {
  console.error(`WARN: ${message}`);
}

function valueShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Normalize and validate one configured API base.
 * @param {unknown} value
 * @returns {{url: string} | {error: string} | null}
 */
export function normalizeApiBase(value) {
  if (typeof value !== "string") {
    return value === undefined ? null : { error: `expected string, got ${valueShape(value)}` };
  }
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) return null;
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return { error: "invalid URL string" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `unsupported ${parsed.protocol || "unknown"} protocol` };
  }
  if (parsed.username || parsed.password) {
    return { error: "must not contain URL credentials" };
  }
  if (parsed.search) {
    return { error: "must not contain query parameters" };
  }
  if (parsed.hash) {
    return { error: "must not contain a fragment" };
  }
  if (parsed.pathname.replace(/\/+$/, "").endsWith("/api/v1")) {
    return { error: "must not end in /api/v1" };
  }
  return { url: normalized };
}

async function readConfig(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      warn(`${filePath} could not be read as a configuration object`);
      return null;
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    warn(`${filePath} could not be read or parsed; API-host scope skipped`);
    return null;
  }
}

function selectCandidate(value, { source, field, scope }) {
  const result = normalizeApiBase(value);
  if (!result) return null;
  if (result.error) {
    warn(`${source} ${field} is invalid (${result.error}); API-host scope skipped`);
    return null;
  }
  return { url: result.url, source, scope };
}

function resolveProjectDir(projectDir) {
  const explicit = typeof projectDir === "string" && projectDir.trim()
    ? projectDir
    : undefined;
  const envProjectDir = explicit ? undefined : process.env.MIDBRAIN_PROJECT_DIR;
  const candidate = explicit || envProjectDir;
  if (candidate === TERMINAL_CWD_PLACEHOLDER) {
    warn(
      "MIDBRAIN_PROJECT_DIR TERMINAL_CWD placeholder is unresolved " +
      "(${TERMINAL_CWD}); project API-host scope skipped.",
    );
    return undefined;
  }
  return candidate || undefined;
}

async function projectCandidate(projectDir, keyScope) {
  if (!projectDir) return null;
  const filePath = path.join(projectDir, MIDBRAIN_DIR, CONFIG_FILENAME);
  const config = await readConfig(filePath);
  if (!config || !Object.hasOwn(config, "apiUrl")) return null;
  const candidate = selectCandidate(config.apiUrl, {
    source: filePath,
    field: "apiUrl",
    scope: "project",
  });
  if (!candidate) return null;
  if (keyScope !== "project") {
    warn(
      `project apiUrl ignored: credential resolves at ${keyScope || "unknown"} — ` +
      "a project host may not redirect a higher-scope credential",
    );
    return null;
  }
  return candidate;
}

function clientCandidate(config, filePath, clientId) {
  const clients = config?.clients;
  const client = clients && typeof clients === "object" && !Array.isArray(clients)
    ? clients[clientId]
    : undefined;
  if (!client || !Object.hasOwn(client, "apiUrl")) return null;
  return selectCandidate(client.apiUrl, {
    source: filePath,
    field: `clients.${clientId}.apiUrl`,
    scope: "client",
  });
}

/**
 * Resolve the effective API host for one client/key binding.
 * @param {{clientId: string, projectDir?: string, keyScope?: string}} options
 * @returns {Promise<{url: string, source: string, scope: string}>}
 */
export async function resolveApiHost({ clientId, projectDir, keyScope } = {}) {
  const environment = selectCandidate(process.env[API_URL_ENV], {
    source: `env:${API_URL_ENV}`,
    field: API_URL_ENV,
    scope: "environment",
  });
  if (environment) return environment;

  const project = await projectCandidate(resolveProjectDir(projectDir), keyScope);
  if (project) return project;

  const globalPath = path.join(os.homedir(), ".config", "midbrain", CONFIG_FILENAME);
  const globalConfig = await readConfig(globalPath);
  const client = clientCandidate(globalConfig, globalPath, clientId);
  if (client) return client;
  const global = selectCandidate(globalConfig?.apiUrl, {
    source: globalPath,
    field: "apiUrl",
    scope: "global",
  });
  return global || { url: DEFAULT_API_BASE, source: "default", scope: "default" };
}
