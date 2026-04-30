/**
 * OpenCode client adapter.
 *
 * Encapsulates all OpenCode-specific config handling:
 * - JSONC-preserving config patching (opencode.jsonc / opencode.json)
 * - Array command format, `environment` env key, `type: "local"`, `enabled: true`
 * - Plugin file copying (~/.config/opencode/plugins/)
 * - Config resolution (.jsonc preferred over .json)
 * - $schema enforcement + invalid mcpServers cleanup
 */

import { BaseClient } from './base.mjs';

const KEY_FILENAME = ".midbrain-key";
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Lazy-loaded: jsonc-parser is only needed for config writing, not key
// resolution. Keeping it lazy lets the plugin/hook runtime import this
// module without requiring jsonc-parser to be installed.
let _jsonc;
async function jsonc() {
  if (!_jsonc) _jsonc = await import('jsonc-parser');
  return _jsonc;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const MCP_KEY = 'midbrain-memory';
const JSONC_FORMAT = { tabSize: 2, insertSpaces: true, eol: '\n' };

const RESERVED_ENV_KEYS = new Set(['MIDBRAIN_CONFIG_DIR', 'MIDBRAIN_PROJECT_DIR', 'MIDBRAIN_CLIENT']);

// Lazy accessors — must resolve at call time, not module load time,
// because tests override process.env.HOME.
function home() { return os.homedir(); }
function configDir() { return path.join(home(), '.config', 'opencode'); }
function pluginsDir() { return path.join(configDir(), 'plugins'); }
function ownKeyPath() { return path.join(configDir(), KEY_FILENAME); }

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolves opencode.jsonc > opencode.json in a directory. */
function resolveConfig(dir) {
  const jsoncPath = path.join(dir, 'opencode.jsonc');
  if (existsSync(jsoncPath)) return jsoncPath;
  const jsonPath = path.join(dir, 'opencode.json');
  if (existsSync(jsonPath)) return jsonPath;
  return jsonPath; // default for new installs
}

/** Read and parse a JSON/JSONC file. Returns null if missing. */
async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const { parse } = await jsonc();
    const errors = [];
    const result = parse(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      throw new SyntaxError(`Invalid JSON/JSONC content (${errors.length} error(s))`);
    }
    return result;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to parse ${filePath}: ${err.message}`, { cause: err });
  }
}

/** Surgically patch a JSONC file, preserving comments. */
async function patchJsonFile(filePath, modifications) {
  const { modify, applyEdits } = await jsonc();
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') text = '{}';
    else throw err;
  }
  for (const { path: jsonPath, value } of modifications) {
    const edits = modify(text, jsonPath, value, { formattingOptions: JSONC_FORMAT });
    text = applyEdits(text, edits);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (!text.endsWith('\n')) text += '\n';
  await fs.writeFile(filePath, text, 'utf8');
}

/** Back up a file (no-op if source missing). */
async function backup(filePath) {
  if (existsSync(filePath)) {
    await fs.copyFile(filePath, filePath + '.bak');
  }
}

/** Extracts non-reserved env keys from an existing MCP entry. */
function extractCustomEnv(entry) {
  const source = entry && typeof entry === 'object' && entry.environment;
  if (!source || typeof source !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (!RESERVED_ENV_KEYS.has(k)) out[k] = v;
  }
  return out;
}

const PINNED_RE = /midbrain-memory-mcp@\d+\.\d+\.\d+/;

/** Classifies an existing entry for custom env extraction. */
function classifyEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return { exists: false, pinned: false, extraEnv: {} };
  }
  const args = Array.isArray(entry.command) ? entry.command : [];
  const pinned = args.some((a) => PINNED_RE.test(a));
  return { exists: true, pinned, extraEnv: extractCustomEnv(entry) };
}

/** Builds the MCP entry for this client. */
function buildEntry({ isDev = false, projectDir } = {}) {
  if (isDev) {
    const environment = { MIDBRAIN_CLIENT: 'opencode' };
    if (projectDir) environment.MIDBRAIN_PROJECT_DIR = projectDir;
    return {
      type: 'local',
      command: [process.execPath, path.join(REPO_ROOT, 'index.js')],
      environment,
      enabled: true,
    };
  }
  const environment = { MIDBRAIN_CLIENT: 'opencode' };
  if (projectDir) environment.MIDBRAIN_PROJECT_DIR = projectDir;
  return {
    type: 'local',
    command: ['npx', '-y', 'midbrain-memory-mcp@latest'],
    environment,
    enabled: true,
  };
}

/** Builds a status line for install summary. */
function formatMigrationLine(label, exists, pinned) {
  if (pinned) return `${label}: midbrain-memory pinned version preserved (no change)`;
  return exists
    ? `${label}: midbrain-memory updated`
    : `${label}: midbrain-memory entry added`;
}

// ---------------------------------------------------------------------------
// OpenCode concrete implementation
// ---------------------------------------------------------------------------

export class OpenCode extends BaseClient {
  get id() { return 'opencode'; }
  get displayName() { return 'OpenCode'; }

  isInstalled() {
    const config = resolveConfig(configDir());
    return existsSync(config) || existsSync(configDir());
  }

  async resolveClientKey() {
    try {
      const raw = await fs.readFile(ownKeyPath(), 'utf8');
      const key = raw.trim();
      if (key) return { key, source: ownKeyPath() };
    } catch { /* not found */ }
    return null;
  }

  async writeKey(key) {
    const kfp = ownKeyPath();
    await fs.mkdir(path.dirname(kfp), { recursive: true });
    await fs.writeFile(kfp, key + '\n', 'utf8');
    await fs.chmod(kfp, 0o600);
    return `Key: ~/.config/opencode/${KEY_FILENAME} (chmod 600)`;
  }

  async installGlobal(opts = {}) {
    const { isDev = false } = opts;
    const summary = [];

    // Copy plugin + shared files
    const pd = pluginsDir();
    await fs.mkdir(pd, { recursive: true });
    await fs.copyFile(path.join(REPO_ROOT, 'plugins', 'opencode', 'midbrain-memory.ts'), path.join(pd, 'midbrain-memory.ts'));
    summary.push('  + Plugin copied: ~/.config/opencode/plugins/midbrain-memory.ts');
    await fs.copyFile(path.join(REPO_ROOT, 'shared', 'midbrain-api.mjs'), path.join(pd, 'midbrain-api.mjs'));
    summary.push('  + API client copied: ~/.config/opencode/plugins/midbrain-api.mjs');
    await fs.copyFile(path.join(REPO_ROOT, 'shared', 'logger.mjs'), path.join(pd, 'logger.mjs'));
    summary.push('  + Logger copied: ~/.config/opencode/plugins/logger.mjs');

    // Copy client adapters (plugin imports ./clients/registry.mjs for key resolution)
    const clientsSrc = path.join(REPO_ROOT, 'shared', 'clients');
    const clientsDst = path.join(pd, 'clients');
    await fs.mkdir(clientsDst, { recursive: true });
    for (const file of ['base.mjs', 'generic.mjs', 'opencode.mjs', 'claude.mjs', 'registry.mjs']) {
      await fs.copyFile(path.join(clientsSrc, file), path.join(clientsDst, file));
    }
    summary.push('  + Client adapters copied: ~/.config/opencode/plugins/clients/');

    // Patch opencode config (.json or .jsonc)
    const configPath = resolveConfig(configDir());
    const configBasename = path.basename(configPath);
    const config = (await readJson(configPath)) || {};
    if (existsSync(configPath)) await backup(configPath);

    const modifications = [];

    if (!config['$schema']) {
      modifications.push({ path: ['$schema'], value: 'https://opencode.ai/config.json' });
    }
    if (config.mcpServers) {
      modifications.push({ path: ['mcpServers'], value: undefined });
      summary.push(`  ~ Removed invalid "mcpServers" key from ${configBasename} (OpenCode requires "mcp")`);
    }

    const existing = config.mcp && config.mcp[MCP_KEY];
    const { exists, pinned, extraEnv: customEnv } = classifyEntry(existing);
    if (!pinned) {
      const entry = buildEntry({ isDev });
      entry.environment = { ...customEnv, ...entry.environment };
      modifications.push({ path: ['mcp', MCP_KEY], value: entry });
    }

    await patchJsonFile(configPath, modifications);
    summary.push(pinned
      ? `  ~ MCP server: pinned version preserved in ${configBasename}`
      : exists
        ? `  ~ MCP server: updated in ${configBasename}`
        : `  + MCP server added to ${configBasename}`
    );
    summary.push('  -> Restart OpenCode to apply changes');
    return summary;
  }

  async installProject(projectDir, opts = {}) {
    const { isDev = false } = opts;
    const out = [];

    const configPath = resolveConfig(projectDir);
    const config = (await readJson(configPath)) || {};

    const existingEntry = config.mcp && config.mcp[MCP_KEY];
    const { exists, pinned, extraEnv } = classifyEntry(existingEntry);

    const modifications = [];
    if (!config['$schema']) {
      modifications.push({ path: ['$schema'], value: 'https://opencode.ai/config.json' });
    }
    if (config.mcpServers) {
      modifications.push({ path: ['mcpServers'], value: undefined });
      out.push('Removed invalid mcpServers key from ' + path.basename(configPath));
    }

    if (!pinned) {
      const entry = buildEntry({ isDev, projectDir });
      entry.environment = { ...extraEnv, ...entry.environment };
      modifications.push({ path: ['mcp', MCP_KEY], value: entry });
    }

    if (modifications.length > 0) {
      await patchJsonFile(configPath, modifications);
    }
    out.push(formatMigrationLine(configPath, exists, pinned));
    return out;
  }

  projectConfigFiles(projectDir) {
    const configPath = resolveConfig(projectDir);
    return [path.basename(configPath)];
  }
}

// Re-export for backward compat (used by install.mjs tests)
export { resolveConfig as resolveOpencodeConfig };
