/**
 * Claude Code client adapter.
 *
 * Encapsulates all Claude Code-specific config handling:
 * - ~/.claude.json (global MCP entry)
 * - ~/.claude/settings.json (hooks + permissions)
 * - <project>/.mcp.json (project-level MCP config)
 * - ~/.claude.json project-local scope (trust gate bypass)
 * - Split command/args format, `env` key, `type: "stdio"`
 */

import { BaseClient, readKeyFile } from './base.mjs';
import {
  KEY_FILENAME, MCP_KEY, PKG_NAME, REPO_ROOT,
  home, readJson, writeJson, writeJsonIfChanged, backup, classifyEntry, formatMigrationLine,
} from './utils.mjs';
import { shellQuote, stableShimPath, installShim, shimStatus } from './shim.mjs';

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// Lazy accessors — must resolve at call time, not module load time,
// because tests override process.env.HOME.
function cfgDir() { return path.join(home(), '.config', 'claude'); }
function keyFilePathFn() { return path.join(cfgDir(), KEY_FILENAME); }
function claudeJsonPath() { return path.join(home(), '.claude.json'); }
function claudeSettingsPath() { return path.join(home(), '.claude', 'settings.json'); }

const PERM_KEYS = [
  'mcp__midbrain-memory__memory_search',
  'mcp__midbrain-memory__grep',
  'mcp__midbrain-memory__get_episodic_memories_by_date',
  'mcp__midbrain-memory__list_files',
  'mcp__midbrain-memory__read_file',
  'mcp__midbrain-memory__memory_setup_project',
];

// ---------------------------------------------------------------------------
// Internal helpers (Claude-specific only)
// ---------------------------------------------------------------------------

/** Builds the MCP entry for this client. */
function buildEntry({ isDev = false, projectDir } = {}) {
  if (isDev) {
    const env = { MIDBRAIN_CLIENT: 'claude', MIDBRAIN_DEV: '1' };
    if (projectDir) env.MIDBRAIN_PROJECT_DIR = projectDir;
    return {
      type: 'stdio',
      command: process.execPath,
      args: [path.join(REPO_ROOT, 'index.js')],
      env,
    };
  }
  const env = { MIDBRAIN_CLIENT: 'claude' };
  if (projectDir) env.MIDBRAIN_PROJECT_DIR = projectDir;
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'midbrain-memory-mcp@latest'],
    env,
  };
}

// Hooks always call the stable ~/.midbrain/bin/claude-hook shim (PRD-034 S2):
// the command string in user config survives package moves, cache cleans, and
// Node upgrades. 30s timeout absorbs cold npx resolution inside the shim
// (the 10s value starved exactly that path in the 2026-07 Hermes incident).
const HOOK_TIMEOUT_SEC = 30;
const HOOK_EVENTS = {
  UserPromptSubmit: 'user',
  Stop: 'assistant',
};
const LEGACY_HOOK_SCRIPTS = ['capture-user.mjs', 'capture-assistant.mjs'];

function buildHookCommand(role) {
  return `${shellQuote(stableShimPath('claude'))} ${role}`;
}

function midbrainHookEntry(role) {
  const entry = { type: 'command', command: buildHookCommand(role), timeout: HOOK_TIMEOUT_SEC };
  if (role === 'assistant') entry.async = true;
  return entry;
}

/** Detect whether a hook object belongs to midbrain (shim, legacy, or npx form). */
function isMidbrainHook(hook) {
  const command = typeof hook?.command === 'string' ? hook.command : '';
  const normalized = command.replace(/['"]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.includes(stableShimPath('claude')) ||
    normalized.includes('/.midbrain/bin/claude-hook') ||
    normalized.includes('~/.midbrain/bin/claude-hook') ||
    normalized.includes('$HOME/.midbrain/bin/claude-hook') ||
    LEGACY_HOOK_SCRIPTS.some((script) => command.includes(script)) ||
    (normalized.includes(PKG_NAME) && /\bhook\s+claude\b/.test(normalized));
}

/** Drop midbrain hooks from groups, keeping every user-defined hook. */
function withoutMidbrainGroups(groups) {
  return groups
    .map((group) => ({ ...group, hooks: (group.hooks || []).filter((hook) => !isMidbrainHook(hook)) }))
    .filter((group) => group.hooks.length > 0);
}

/**
 * Rewrite only the midbrain hooks: exactly one canonical group per capture
 * event, all non-midbrain hooks and unrelated events preserved (the previous
 * wholesale `data.hooks = buildHooks()` wiped user hooks on repair).
 */
function patchHooks(data) {
  data.hooks = data.hooks || {};
  for (const [event, role] of Object.entries(HOOK_EVENTS)) {
    const groups = Array.isArray(data.hooks[event]) ? data.hooks[event] : [];
    data.hooks[event] = [...withoutMidbrainGroups(groups), { hooks: [midbrainHookEntry(role)] }];
  }
  return data;
}

/** Checks if midbrain hooks are already present in settings. */
function hooksAlreadyPresent(settings) {
  const hooks = settings.hooks || {};
  return Object.keys(HOOK_EVENTS).some((event) =>
    (Array.isArray(hooks[event]) ? hooks[event] : []).some((entry) =>
      (entry.hooks || []).some((h) => isMidbrainHook(h))
    )
  );
}

// ---------------------------------------------------------------------------
// Claude Code concrete implementation
// ---------------------------------------------------------------------------

export class Claude extends BaseClient {
  get id() { return 'claude'; }
  get displayName() { return 'Claude Code'; }

  isInstalled() {
    return existsSync(claudeJsonPath()) || existsSync(claudeSettingsPath());
  }

  async resolveClientKey() {
    const source = keyFilePathFn();
    const key = await readKeyFile(source);
    return key ? { key, source } : null;
  }

  async writeKey(key) {
    const kfp = keyFilePathFn();
    await fs.mkdir(path.dirname(kfp), { recursive: true });
    await fs.writeFile(kfp, key + '\n', 'utf8');
    await fs.chmod(kfp, 0o600);
    return `Key: ~/.config/claude/${KEY_FILENAME} (chmod 600)`;
  }

  async installGlobal(opts = {}) {
    const { isDev = false } = opts;
    const summary = [];

    // 1. ~/.claude.json — MCP server entry
    await this._installClaudeJson(summary, { isDev });

    // 2. ~/.claude/settings.json — hooks + permissions
    await this._installClaudeSettings(summary, { isDev });

    summary.push('  -> Restart Claude Code to apply changes');
    return summary;
  }

  async installProject(projectDir, opts = {}) {
    const { isDev = false } = opts;
    const out = [];

    // 1. <project>/.mcp.json
    const mcpJsonPath = path.join(projectDir, '.mcp.json');
    const mcpJson = (await readJson(mcpJsonPath)) || {};
    mcpJson.mcpServers = mcpJson.mcpServers || {};
    const { exists: mcpExists, pinned: mcpPinned, extraEnv: mcpExtraEnv } = classifyEntry(mcpJson.mcpServers[MCP_KEY], 'env');
    if (!mcpPinned) {
      const entry = buildEntry({ isDev, projectDir });
      entry.env = { ...mcpExtraEnv, ...entry.env };
      mcpJson.mcpServers[MCP_KEY] = entry;
      await writeJson(mcpJsonPath, mcpJson);
    }
    out.push(formatMigrationLine(mcpJsonPath, mcpExists, mcpPinned));

    // 2. ~/.claude.json project-local scope (bypass trust gate)
    try {
      const patched = await this._patchProjectLocal(projectDir, { isDev });
      if (patched.line) out.push(patched.line);
    } catch (err) {
      if (err.code === 'EACCES') {
        out.push(`Warning: could not patch ${claudeJsonPath()}: ${err.code}`);
      } else {
        throw err;
      }
    }

    return out;
  }

  projectConfigFiles(_projectDir) {
    return [".mcp.json"];
  }

  /**
   * Fresh when midbrain hooks reference the current stable claude-hook shim
   * and the shim itself is canonical (exact body or dev-marked) and
   * executable (AC-11). Never compares against REPO_ROOT: the running
   * instance's location must not define what user config should contain.
   * Legacy direct-script commands trigger a migration repair.
   */
  async isFresh() {
    try {
      const data = (await readJson(claudeSettingsPath())) || {};
      if (!hooksAlreadyPresent(data)) return true; // no hooks = nothing to repair

      for (const [event, role] of Object.entries(HOOK_EVENTS)) {
        const groups = Array.isArray(data.hooks?.[event]) ? data.hooks[event] : [];
        const hooks = groups.flatMap((group) => group.hooks || []);
        if (hooks.some((h) => typeof h?.command === 'string' &&
          LEGACY_HOOK_SCRIPTS.some((script) => h.command.includes(script)))) return false;
        const midbrain = hooks.filter((h) => isMidbrainHook(h));
        if (midbrain.length !== 1) return false;
        if (midbrain[0].command !== buildHookCommand(role)) return false;
        if (midbrain[0].timeout !== HOOK_TIMEOUT_SEC) return false;
        if (role === 'assistant' && midbrain[0].async !== true) return false;
      }
      return (await shimStatus('claude')).fresh;
    } catch { return true; } // if we can't read, don't repair
  }

  /**
   * Repair stale hooks: rewrite midbrain hook entries to the canonical shim
   * command (preserving user hooks) and reinstall the shim when it is missing
   * or stale. Dev-marked shim bodies are preserved. Content-compared writes —
   * an unchanged file keeps its mtime (Hermes hook-approval safety).
   */
  async repairHooks() {
    const csp = claudeSettingsPath();
    let data;
    try {
      data = (await readJson(csp)) || {};
    } catch { return []; } // unreadable config: fail open, skip
    if (!hooksAlreadyPresent(data)) return [];
    patchHooks(data);
    const shim = await installShim('claude', { mode: 'repair' });
    const wrote = await writeJsonIfChanged(csp, data);
    if (!wrote && !shim.written) return [];
    return ['  ~ Claude Code hooks repaired (stable claude-hook shim installed)'];
  }

  // --- Private helpers ---

  async _installClaudeJson(summary, { isDev }) {
    const cjp = claudeJsonPath();
    const data = (await readJson(cjp)) || {};
    await backup(cjp);

    const existing = data.mcpServers && data.mcpServers[MCP_KEY];
    const { pinned, extraEnv: customEnv } = classifyEntry(existing, 'env');

    if (!pinned) {
      const entry = buildEntry({ isDev });
      entry.env = { ...customEnv, ...entry.env };
      data.mcpServers = data.mcpServers || {};
      data.mcpServers[MCP_KEY] = entry;
      await writeJson(cjp, data);
    }

    if (pinned) {
      summary.push('  ~ MCP server: pinned version preserved in ~/.claude.json');
    } else if (existing) {
      summary.push('  ~ MCP server: updated in ~/.claude.json');
    } else {
      summary.push('  + MCP server added to ~/.claude.json');
    }
  }

  async _installClaudeSettings(summary, { isDev = false } = {}) {
    const csp = claudeSettingsPath();
    const data = (await readJson(csp)) || {};

    const had = hooksAlreadyPresent(data);
    patchHooks(data);
    summary.push(had
      ? '  ~ Hooks: updated in ~/.claude/settings.json'
      : '  + Hooks added to ~/.claude/settings.json');

    // Permissions
    data.permissions = data.permissions || {};
    data.permissions.allow = data.permissions.allow || [];
    for (const perm of PERM_KEYS) {
      if (!data.permissions.allow.includes(perm)) {
        data.permissions.allow.push(perm);
        summary.push(`  + Permission added: ${perm}`);
      } else {
        summary.push(`  - Permission: ${perm} already present (skipped)`);
      }
    }

    // Explicit install always writes the shim per its flags (dev or canonical).
    await installShim('claude', { mode: 'install', isDev });
    summary.push('  + Stable claude-hook shim written: ~/.midbrain/bin/claude-hook');
    await writeJsonIfChanged(csp, data, { backupFirst: true });
  }

  async _patchProjectLocal(projectDir, { isDev }) {
    const cjp = claudeJsonPath();
    let data;
    try {
      data = (await readJson(cjp)) || {};
    } catch (err) {
      throw new Error(
        `Could not patch ${cjp}: Claude config could not be read or parsed (${err.message})`,
        { cause: err }
      );
    }
    return await this.#patchProjectLocalData(cjp, data, projectDir, { isDev });
  }

  async #patchProjectLocalData(cjp, data, projectDir, { isDev }) {
    const existingEntry =
      data.projects &&
      data.projects[projectDir] &&
      data.projects[projectDir].mcpServers &&
      data.projects[projectDir].mcpServers[MCP_KEY];

    const { exists, pinned, extraEnv } = classifyEntry(existingEntry, 'env');
    if (!pinned) {
      const entry = buildEntry({ isDev, projectDir });
      entry.env = { ...extraEnv, ...entry.env };
      data.projects = data.projects || {};
      data.projects[projectDir] = data.projects[projectDir] || {};
      data.projects[projectDir].mcpServers = data.projects[projectDir].mcpServers || {};
      data.projects[projectDir].mcpServers[MCP_KEY] = entry;
      await writeJson(cjp, data);
    }

    return { line: formatMigrationLine(`${cjp} (project-local)`, exists, pinned) };
  }
}
