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
import {
  KEY_FILENAME, MCP_KEY, PKG_NAME, REPO_ROOT,
  home, readJson, writeJsonIfChanged, backup, writeSecure,
  classifyEntry, formatMigrationLine,
} from './utils.mjs';
import { shellQuote, stableShimPath, installShim, shimStatus } from './shim.mjs';

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const HOOK_TIMEOUT_SEC = 10;
const HOOK_EVENTS = {
  UserPromptSubmit: 'user',
  PostToolUse: 'tool',
  Stop: 'assistant',
};
const LEGACY_HOOK_SCRIPTS = [
  'capture-user.mjs',
  'capture-tool.mjs',
  'capture-assistant.mjs',
];
let tomlModule;

function codexDir() { return path.join(home(), '.codex'); }
function configPath() { return path.join(codexDir(), 'config.toml'); }
function hooksPath() { return path.join(codexDir(), 'hooks.json'); }
function stableHookPath() { return stableShimPath('codex'); }
function cfgDir() { return path.join(home(), '.config', 'codex'); }
function keyFilePath() { return path.join(cfgDir(), KEY_FILENAME); }

async function readToml(filePath) {
  try {
    const toml = await loadToml();
    const raw = await fs.readFile(filePath, 'utf8');
    return toml.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`Failed to parse ${filePath}: ${err.message}`, { cause: err });
  }
}

/** Content-compared TOML write; backs up only when actually changing. */
async function writeTomlIfChanged(filePath, data, { backupFirst = false } = {}) {
  const toml = await loadToml();
  const content = toml.stringify(data);
  try {
    if ((await fs.readFile(filePath, 'utf8')) === content) return false;
  } catch { /* missing -> write */ }
  if (backupFirst) await backup(filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  return true;
}

async function loadToml() {
  tomlModule ||= await import('smol-toml');
  return tomlModule;
}

function buildEntry({ isDev = false, projectDir, extraEnv = {} } = {}) {
  const env = { ...extraEnv, MIDBRAIN_CLIENT: 'codex' };
  if (projectDir) env.MIDBRAIN_PROJECT_DIR = projectDir;
  if (isDev) {
    env.MIDBRAIN_DEV = '1';
    return { command: process.execPath, args: [path.join(REPO_ROOT, 'index.js')], env };
  }
  return { command: 'npx', args: ['-y', 'midbrain-memory-mcp@latest'], env };
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
  const { exists, pinned, extraEnv } = classifyEntry(existing, 'env');
  if (!pinned) config.mcp_servers[MCP_KEY] = buildEntry({ ...opts, extraEnv });
  return { exists, pinned };
}

function buildHookCommand(scriptName) {
  return `${shellQuote(stableHookPath())} ${scriptName}`;
}

function midbrainHook(scriptName) {
  return {
    type: 'command',
    command: buildHookCommand(scriptName),
    timeout: HOOK_TIMEOUT_SEC,
  };
}

function normalizedHookCommand(command) {
  return command.replace(/['"]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isMidbrainHook(hook) {
  const command = typeof hook?.command === 'string' ? hook.command : '';
  const normalized = normalizedHookCommand(command);
  return normalized.includes(stableHookPath()) ||
    normalized.includes('/.midbrain/bin/codex-hook') ||
    normalized.includes('~/.midbrain/bin/codex-hook') ||
    normalized.includes('$HOME/.midbrain/bin/codex-hook') ||
    LEGACY_HOOK_SCRIPTS.some((script) => command.includes(script)) ||
    (normalized.includes(PKG_NAME) && /\bhook\s+codex\b/.test(normalized));
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
    await writeTomlIfChanged(cfp, config, { backupFirst: true });
    summary.push(formatMigrationLine('~/.codex/config.toml', exists, pinned));

    const hooks = patchHooks((await readJson(hp)) || {});
    await installShim('codex', { mode: 'install', isDev: opts.isDev });
    await writeJsonIfChanged(hp, hooks, { backupFirst: true });
    summary.push('~/.codex/hooks.json: MidBrain hooks written');
    summary.push('~/.midbrain/bin/codex-hook: stable Codex hook shim written');
    summary.push('Restart Codex and review/trust MidBrain hooks with /hooks once if prompted.');
    return summary;
  }

  async installProject(_projectDir, _opts = {}) {
    const opts = {
      isDev: _opts.isDev === true,
      projectDir: _projectDir,
    };
    const configFile = path.join(_projectDir, '.codex', 'config.toml');
    const config = await readToml(configFile);
    const { exists, pinned } = patchMcpEntry(config, opts);
    await writeTomlIfChanged(configFile, config, { backupFirst: true });
    return [
      formatMigrationLine(configFile, exists, pinned),
      'Codex project trust required: restart Codex and trust this project config if prompted.',
    ];
  }

  projectConfigFiles(_projectDir) {
    return ['.codex/config.toml'];
  }

  /**
   * Fresh when midbrain hooks reference the current stable codex-hook shim
   * (and the shim exists). Canonical since PRD-017 — never compares
   * REPO_ROOT. Legacy direct-script commands trigger a migration repair.
   */
  async isFresh() {
    try {
      const data = (await readJson(hooksPath())) || {};
      let hasMidbrainHook = false;
      for (const [event, hookName] of Object.entries(HOOK_EVENTS)) {
        const groups = data.hooks?.[event];
        if (!Array.isArray(groups) || groups.length === 0) continue;
        const commands = groups.flatMap((group) => group.hooks || [])
          .map((hook) => typeof hook?.command === 'string' ? hook.command : '');
        if (!commands.some((command) => isMidbrainHook({ command }))) continue;
        hasMidbrainHook = true;
        if (commands.some((command) => LEGACY_HOOK_SCRIPTS.some((script) => command.includes(script)))) return false;
        if (!commands.some((command) => command === buildHookCommand(hookName))) return false;
      }
      if (!hasMidbrainHook) return true;
      return (await shimStatus('codex')).fresh;
    } catch { return true; }
  }

  /**
   * Repair stale hooks: rewrite midbrain hook entries to the canonical shim
   * command and reinstall the shim when missing or stale. Dev-marked shim
   * bodies are preserved; content-compared writes keep mtimes stable.
   */
  async repairHooks() {
    const hp = hooksPath();
    let data;
    try {
      data = (await readJson(hp)) || {};
    } catch { return []; } // unreadable config: fail open, skip
    patchHooks(data);
    const shim = await installShim('codex', { mode: 'repair' });
    const wrote = await writeJsonIfChanged(hp, data);
    if (!wrote && !shim.written) return [];
    return ['  ~ Codex hooks repaired (stable Codex hook shim installed)'];
  }
}
