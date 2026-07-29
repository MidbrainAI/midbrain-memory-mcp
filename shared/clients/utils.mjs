/**
 * shared/clients/utils.mjs
 *
 * Shared constants and utility functions used by all client adapters.
 * Eliminates duplication across opencode.mjs, claude.mjs, codex.mjs, generic.mjs.
 */

import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { readKeyFile } from './base.mjs';

// --- Constants ---

export const KEY_FILENAME = ".midbrain-key";
export const MIDBRAIN_DIR = '.midbrain';
export const MCP_KEY = 'midbrain-memory';
// MIDBRAIN_DEV is the dev-install marker (PRD-034 S3): reserved so
// extractCustomEnv never carries it into rebuilt entries — an explicit
// non-dev install therefore drops the marker and restores canonical.
export const RESERVED_ENV_KEYS = new Set([
  'MIDBRAIN_CONFIG_DIR',
  'MIDBRAIN_PROJECT_DIR',
  'MIDBRAIN_CLIENT',
  'MIDBRAIN_DEV',
  'MIDBRAIN_API_URL',
]);
export const DEV_ENV_MARKER = 'MIDBRAIN_DEV';
export const PINNED_RE = /midbrain-memory-mcp@\d+\.\d+\.\d+/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Package metadata read from package.json at REPO_ROOT. */
const _pkg = (() => {
  try { return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')); }
  catch { return {}; }
})();
export const PKG_NAME = _pkg.name || 'midbrain-memory-mcp';
export const PKG_VERSION = _pkg.version || 'unknown';

// --- Lazy accessors ---

export function home() { return os.homedir(); }

// --- Filesystem helpers ---

/** Read and parse a JSON file. Returns null if missing. */
export async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to parse ${filePath}: ${err.message}`, { cause: err });
  }
}

/** Write object as formatted JSON (creates dirs if needed). */
export async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** Back up a file (no-op if source missing). */
export async function backup(filePath) {
  if (existsSync(filePath)) {
    await fs.copyFile(filePath, filePath + '.bak');
  }
}

/**
 * Write content only when it differs from what is on disk (PRD-034 S2, D4).
 * Skipped writes leave mtime untouched, which keeps Hermes' hook-approval
 * layer (and any other mtime-sensitive consumer) undisturbed.
 *
 * @returns {Promise<boolean>} true when the file was written.
 */
export async function writeFileIfChanged(filePath, content) {
  try {
    const current = await fs.readFile(filePath, 'utf8');
    if (current === content) return false;
  } catch { /* missing/unreadable -> write */ }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return true;
}

/**
 * Content-compared JSON write in writeJson's exact format (PRD-034 S2, D4).
 * Optionally backs the file up first, but only when actually changing it.
 *
 * @returns {Promise<boolean>} true when the file was written.
 */
export async function writeJsonIfChanged(filePath, data, { backupFirst = false } = {}) {
  const content = JSON.stringify(data, null, 2) + '\n';
  try {
    if ((await fs.readFile(filePath, 'utf8')) === content) return false;
  } catch { /* missing/unreadable -> write */ }
  if (backupFirst) await backup(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return true;
}

/** Write a key file with chmod 600 (creates parent dirs). */
export async function writeSecure(filePath, key) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, key + '\n', 'utf8');
  await fs.chmod(filePath, 0o600);
}

// --- MCP entry helpers ---

/**
 * Extract non-reserved env keys from an existing MCP entry.
 * @param {object} entry - The MCP config entry object.
 * @param {string} envKey - Property name holding env vars ("environment" or "env").
 */
export function extractCustomEnv(entry, envKey) {
  const source = entry && typeof entry === 'object' && entry[envKey];
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (!RESERVED_ENV_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/**
 * Classifies an existing MCP entry: presence, pinned status, custom env.
 * @param {object} entry - The MCP config entry object.
 * @param {string} envKey - Property name holding env vars ("environment" or "env").
 */
export function classifyEntry(entry, envKey) {
  if (!entry || typeof entry !== 'object') {
    return { exists: false, pinned: false, extraEnv: {} };
  }
  // Check both command (string or array) and args for pinned version
  const cmd = Array.isArray(entry.command) ? entry.command : [entry.command];
  const args = Array.isArray(entry.args) ? entry.args : [];
  const values = [...cmd, ...args];
  const pinned = values.some((v) => typeof v === 'string' && PINNED_RE.test(v));
  return { exists: true, pinned, extraEnv: extractCustomEnv(entry, envKey) };
}

/** Builds a human-readable status line for install summary. */
export function formatMigrationLine(label, exists, pinned) {
  if (pinned) return `${label}: midbrain-memory pinned version preserved (no change)`;
  return exists
    ? `${label}: midbrain-memory updated`
    : `${label}: midbrain-memory entry added`;
}

function envObject(entry, envKey) {
  const value = entry && typeof entry === 'object' ? entry[envKey] : null;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function isObjectRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Pinned-entry warning for the reserved host env residual. */
export function pinnedHostEnvLine(entry, envKey) {
  if (!Object.hasOwn(envObject(entry, envKey), 'MIDBRAIN_API_URL')) return null;
  return '! pinned entry retains MIDBRAIN_API_URL; unpin (remove @x.y.z) and re-run install to migrate';
}

function hostMigrationTarget(clientId, projectDir) {
  if (projectDir) {
    return {
      filePath: path.join(projectDir, MIDBRAIN_DIR, 'config.json'),
      field: 'apiUrl',
      read: (config) => config.apiUrl,
      has: (config) => Object.hasOwn(config, 'apiUrl'),
      write(config, value) { config.apiUrl = value; },
    };
  }
  const filePath = path.join(home(), '.config', 'midbrain', 'config.json');
  return {
    filePath,
    field: `clients.${clientId}.apiUrl`,
    read: (config) => config.clients?.[clientId]?.apiUrl,
    has: (config) => Object.hasOwn(config.clients?.[clientId] || {}, 'apiUrl'),
    write(config, value) {
      config.clients = isObjectRecord(config.clients)
        ? config.clients
        : {};
      config.clients[clientId] = isObjectRecord(config.clients[clientId])
        ? config.clients[clientId]
        : {};
      config.clients[clientId].apiUrl = value;
    },
  };
}

/**
 * Move a legacy entry-local MIDBRAIN_API_URL into shared host configuration.
 * The existing file value always wins.
 *
 * @param {object} extraEnv Existing MCP entry environment.
 * @param {{clientId: string, projectDir?: string, source: string}} options
 * @returns {Promise<string[]>} Installer summary lines.
 */
export async function migrateReservedHostEnv(extraEnv, { clientId, projectDir, source }) {
  if (!Object.hasOwn(extraEnv || {}, 'MIDBRAIN_API_URL')) return [];
  const target = hostMigrationTarget(clientId, projectDir);
  const parsed = (await readJson(target.filePath)) || {};
  const config = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed
    : {};
  if (target.has(config)) {
    if (target.read(config) !== extraEnv.MIDBRAIN_API_URL) {
      const message =
        `${source} MIDBRAIN_API_URL conflicts with ${target.filePath} ${target.field}; file value wins`;
      console.error(`WARN: ${message}`);
      return [`  ! ${message}`];
    }
    return [`  ~ MIDBRAIN_API_URL already configured at ${target.filePath} ${target.field}`];
  }
  target.write(config, extraEnv.MIDBRAIN_API_URL);
  await writeJsonIfChanged(target.filePath, config);
  return [`  ~ MIDBRAIN_API_URL migrated from ${source} to ${target.filePath} ${target.field}`];
}

// --- Key resolution helper ---

/**
 * Resolve project-level API key (.midbrain/.midbrain-key then flat .midbrain-key).
 * @param {string} projDir - Absolute path to the project root.
 * @returns {Promise<{key: string, source: string} | null>}
 */
export async function resolveProjectKey(projDir) {
  const subPath = path.join(projDir, MIDBRAIN_DIR, KEY_FILENAME);
  const subKey = await readKeyFile(subPath);
  if (subKey) return { key: subKey, source: subPath };

  const flatPath = path.join(projDir, KEY_FILENAME);
  const flatKey = await readKeyFile(flatPath);
  if (flatKey) return { key: flatKey, source: flatPath };

  return null;
}
