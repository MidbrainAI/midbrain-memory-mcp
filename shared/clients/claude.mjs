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
  KEY_FILENAME, MCP_KEY, REPO_ROOT,
  home, readJson, writeJson, backup, classifyEntry, formatMigrationLine,
} from './utils.mjs';

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
    const env = { MIDBRAIN_CLIENT: 'claude' };
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

/** Builds hook entries for capture scripts. */
function buildHooks() {
  const userCmd = `${process.execPath} ${path.join(REPO_ROOT, 'plugins', 'claude-code', 'capture-user.mjs')}`;
  const assistCmd = `${process.execPath} ${path.join(REPO_ROOT, 'plugins', 'claude-code', 'capture-assistant.mjs')}`;
  return {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: userCmd, timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: assistCmd, timeout: 10, async: true }] }],
  };
}

/** Checks if midbrain hooks are already present in settings. */
function hooksAlreadyPresent(settings) {
  const hooks = settings.hooks || {};
  const ups = hooks.UserPromptSubmit || [];
  return ups.some((entry) =>
    (entry.hooks || []).some((h) =>
      typeof h.command === 'string' && h.command.includes('capture-user.mjs')
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
    await this._installClaudeSettings(summary);

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
   * Check if hooks point to the current REPO_ROOT. Returns true if fresh.
   * Returns false if stale or not installed.
   */
  async isFresh() {
    try {
      const data = (await readJson(claudeSettingsPath())) || {};
      if (!hooksAlreadyPresent(data)) return true; // no hooks = nothing to repair
      const hook = data.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
      if (!hook?.command) return true;
      const expectedPath = path.join(REPO_ROOT, 'plugins', 'claude-code', 'capture-user.mjs');
      return hook.command.includes(expectedPath);
    } catch { return true; } // if we can't read, don't repair
  }

  /**
   * Repair stale hooks by rewriting with current REPO_ROOT paths.
   * Returns summary lines or empty array if nothing to repair.
   */
  async repairHooks() {
    const csp = claudeSettingsPath();
    const data = (await readJson(csp)) || {};
    if (!hooksAlreadyPresent(data)) return [];
    data.hooks = buildHooks();
    await writeJson(csp, data);
    return ['  ~ Claude Code hooks repaired (paths updated)'];
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

  async _installClaudeSettings(summary) {
    const csp = claudeSettingsPath();
    const settingsDir = path.dirname(csp);
    await fs.mkdir(settingsDir, { recursive: true });

    const data = (await readJson(csp)) || {};
    await backup(csp);

    if (hooksAlreadyPresent(data)) {
      data.hooks = buildHooks();
      summary.push('  ~ Hooks: updated in ~/.claude/settings.json');
    } else {
      data.hooks = buildHooks();
      summary.push('  + Hooks added to ~/.claude/settings.json');
    }

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

    await writeJson(csp, data);
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
