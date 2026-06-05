/**
 * Codex client adapter.
 *
 * Encapsulates Codex-specific config handling:
 * - ~/.codex/config.toml (MCP server config)
 * - ~/.codex/hooks.json (global capture hooks)
 * - ~/.config/codex/.midbrain-key (per-client key)
 * - <project>/.codex/config.toml (project MCP config only)
 */

import { BaseClient, readKeyFile } from './base.mjs';

const KEY_FILENAME = ".midbrain-key";
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const MCP_KEY = 'midbrain-memory';
const RESERVED_ENV_KEYS = new Set(['MIDBRAIN_CONFIG_DIR', 'MIDBRAIN_PROJECT_DIR', 'MIDBRAIN_CLIENT']);
const PINNED_RE = /midbrain-memory-mcp@\d+\.\d+\.\d+/;
const HOOK_TIMEOUT_SEC = 10;
const HOOK_EVENTS = {
  UserPromptSubmit: 'capture-user.mjs',
  PostToolUse: 'capture-tool.mjs',
  Stop: 'capture-assistant.mjs',
};

function home() { return os.homedir(); }
function codexDir() { return path.join(home(), '.codex'); }
function configPath() { return path.join(codexDir(), 'config.toml'); }
function hooksPath() { return path.join(codexDir(), 'hooks.json'); }
function cfgDir() { return path.join(home(), '.config', 'codex'); }
function keyFilePath() { return path.join(cfgDir(), KEY_FILENAME); }

/** Write a key file with chmod 600. */
async function writeSecure(filePath, key) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, key + '\n', 'utf8');
  await fs.chmod(filePath, 0o600);
}

async function readToml(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return parseToml(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Failed to parse ${filePath}: ${err.message}`, { cause: err });
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Failed to parse ${filePath}: ${err.message}`, { cause: err });
  }
}

async function writeToml(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, stringifyToml(data), 'utf8');
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function backup(filePath) {
  if (existsSync(filePath)) await fs.copyFile(filePath, filePath + '.bak');
}

function extractCustomEnv(entry) {
  const source = entry && typeof entry === 'object' && entry.env;
  if (!source || typeof source !== 'object') return {};
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !RESERVED_ENV_KEYS.has(key)),
  );
}

function classifyEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return { exists: false, pinned: false, extraEnv: {} };
  }
  const values = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])];
  const pinned = values.some((value) => typeof value === 'string' && PINNED_RE.test(value));
  return { exists: true, pinned, extraEnv: extractCustomEnv(entry) };
}

function buildEntry({ isDev = false, projectDir, extraEnv = {} } = {}) {
  const env = { ...extraEnv, MIDBRAIN_CLIENT: 'codex' };
  if (projectDir) env.MIDBRAIN_PROJECT_DIR = projectDir;
  if (isDev) {
    return { command: process.execPath, args: [path.join(REPO_ROOT, 'index.js')], env };
  }
  return { command: 'npx', args: ['-y', 'midbrain-memory-mcp@latest'], env };
}

function formatMigrationLine(label, exists, pinned) {
  if (pinned) return `${label}: midbrain-memory pinned version preserved (no change)`;
  return exists
    ? `${label}: midbrain-memory updated`
    : `${label}: midbrain-memory entry added`;
}

function patchFeatureAliases(config) {
  if (!config.features || typeof config.features !== 'object') return;
  const hadDeprecated = Object.hasOwn(config.features, 'codex_hooks');
  const wasDisabled = config.features.hooks === false;
  delete config.features.codex_hooks;
  if (hadDeprecated || wasDisabled) config.features.hooks = true;
}

function patchMcpEntry(config, opts) {
  config.mcp_servers = config.mcp_servers || {};
  const existing = config.mcp_servers[MCP_KEY];
  const { exists, pinned, extraEnv } = classifyEntry(existing);
  if (!pinned) config.mcp_servers[MCP_KEY] = buildEntry({ ...opts, extraEnv });
  return { exists, pinned };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildHookCommand(scriptName) {
  const scriptPath = path.join(REPO_ROOT, 'plugins', 'codex', scriptName);
  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

function midbrainHook(scriptName) {
  return {
    type: 'command',
    command: buildHookCommand(scriptName),
    timeout: HOOK_TIMEOUT_SEC,
  };
}

function isMidbrainHook(hook) {
  const command = typeof hook?.command === 'string' ? hook.command : '';
  return command.includes('capture-user.mjs') ||
    command.includes('capture-tool.mjs') ||
    command.includes('capture-assistant.mjs');
}

function withoutMidbrainGroups(groups) {
  return groups
    .map((group) => ({ ...group, hooks: (group.hooks || []).filter((hook) => !isMidbrainHook(hook)) }))
    .filter((group) => group.hooks.length > 0);
}

function patchHooks(data) {
  data.hooks = data.hooks || {};
  for (const [event, scriptName] of Object.entries(HOOK_EVENTS)) {
    const groups = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
    data.hooks[event] = [...withoutMidbrainGroups(groups), { hooks: [midbrainHook(scriptName)] }];
  }
  return data;
}

export class Codex extends BaseClient {
  get id() { return 'codex'; }
  get displayName() { return 'Codex'; }

  isInstalled() {
    return existsSync(configPath()) || existsSync(codexDir());
  }

  async resolveClientKey() {
    const source = keyFilePath();
    const key = await readKeyFile(source);
    return key ? { key, source } : null;
  }

  async writeKey(key) {
    const kfp = keyFilePath();
    await writeSecure(kfp, key);
    return `Key: ~/.config/codex/${KEY_FILENAME} (chmod 600)`;
  }

  async installGlobal(_opts = {}) {
    const opts = { isDev: _opts.isDev === true };
    const summary = [];
    const cfp = configPath();
    const hp = hooksPath();

    const config = await readToml(cfp);
    const { exists, pinned } = patchMcpEntry(config, opts);
    patchFeatureAliases(config);
    await backup(cfp);
    await writeToml(cfp, config);
    summary.push(formatMigrationLine('~/.codex/config.toml', exists, pinned));

    const hooks = patchHooks(await readJson(hp));
    await backup(hp);
    await writeJson(hp, hooks);
    summary.push('~/.codex/hooks.json: MidBrain hooks written');
    summary.push('Restart Codex and review/trust hooks with /hooks if prompted.');
    return summary;
  }

  async installProject(_projectDir, _opts = {}) {
    return [];
  }

  projectConfigFiles(_projectDir) {
    return ['.codex/config.toml'];
  }
}
