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
  home, readJson, writeJson, backup, writeSecure,
  classifyEntry, formatMigrationLine,
} from './utils.mjs';

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
function stableHookPath() { return path.join(home(), '.midbrain', 'bin', 'codex-hook'); }
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

async function writeToml(filePath, data) {
  const toml = await loadToml();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, toml.stringify(data), 'utf8');
}

async function loadToml() {
  tomlModule ||= await import('smol-toml');
  return tomlModule;
}

function buildEntry({ isDev = false, projectDir, extraEnv = {} } = {}) {
  const env = { ...extraEnv, MIDBRAIN_CLIENT: 'codex' };
  if (projectDir) env.MIDBRAIN_PROJECT_DIR = projectDir;
  if (isDev) {
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildHookCommand(scriptName) {
  return `${shellQuote(stableHookPath())} ${scriptName}`;
}

function shimBody() {
  return `#!/bin/sh
set +e
npx -y midbrain-memory-mcp@latest hook codex "$@"
status=$?
case "$1" in
  assistant|tool)
    if [ "$status" -ne 0 ]; then
      printf '{}'
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
}

async function installStableHookShim() {
  const shim = stableHookPath();
  await fs.mkdir(path.dirname(shim), { recursive: true });
  await fs.writeFile(shim, shimBody(), 'utf8');
  await fs.chmod(shim, 0o755);
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
    await backup(cfp);
    await writeToml(cfp, config);
    summary.push(formatMigrationLine('~/.codex/config.toml', exists, pinned));

    const hooks = patchHooks((await readJson(hp)) || {});
    await installStableHookShim();
    await backup(hp);
    await writeJson(hp, hooks);
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
    await backup(configFile);
    await writeToml(configFile, config);
    return [
      formatMigrationLine(configFile, exists, pinned),
      'Codex project trust required: restart Codex and trust this project config if prompted.',
    ];
  }

  projectConfigFiles(_projectDir) {
    return ['.codex/config.toml'];
  }

  /**
   * Check if hooks point to the current REPO_ROOT. Returns true if fresh.
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
      return existsSync(stableHookPath());
    } catch { return true; }
  }

  /**
   * Repair stale hooks by rewriting with current REPO_ROOT paths.
   */
  async repairHooks() {
    const hp = hooksPath();
    const data = (await readJson(hp)) || {};
    patchHooks(data);
    await installStableHookShim();
    await writeJson(hp, data);
    return ['  ~ Codex hooks repaired (stable Codex hook shim installed)'];
  }
}
