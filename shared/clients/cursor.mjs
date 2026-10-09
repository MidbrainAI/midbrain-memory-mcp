/**
 * Cursor client adapter.
 *
 * Encapsulates Cursor-specific config handling:
 * - ~/.cursor/mcp.json (global MCP server config, `mcpServers`)
 * - ~/.cursor/hooks.json (global capture hooks, `{ version, hooks }`)
 * - ~/.config/cursor/.midbrain-key (per-client key)
 * - <project>/.cursor/mcp.json (project MCP config only)
 *
 * Cursor has no file-based global rules location; project rules ride the
 * shared AGENTS.md path in shared/agent-rules.mjs.
 */

import { BaseClient, readKeyFile } from './base.mjs';
import { writeCredential } from './credential-writer.mjs';
import {
  KEY_FILENAME, MCP_KEY, REPO_ROOT,
  home, readJson, writeJsonIfChanged,
  classifyEntry, formatMigrationLine,
  migrateReservedHostEnv, pinnedHostEnvLine,
  isObjectRecord as isRecord,
} from './utils.mjs';
import {
  shellQuote, stableShimPath, installShim, shimStatus, commandReferencesShim,
  commandHasMidbrainInvocation,
} from './shim.mjs';

import { existsSync } from 'fs';
import path from 'path';

const CLIENT_ID = 'cursor';
const HOOK_TIMEOUT_SEC = 10;
const HOOKS_VERSION = 1;
// Cursor event -> capture role passed to the stable shim.
const HOOK_EVENTS = {
  beforeSubmitPrompt: 'user',
  postToolUse: 'tool',
  afterAgentResponse: 'assistant',
  // Headless `agent -p` fires none of the above prompt/response hooks (#97).
  sessionEnd: 'session-end',
};

function cursorDir() { return path.join(home(), '.cursor'); }
function mcpPath() { return path.join(cursorDir(), 'mcp.json'); }
function hooksPath() { return path.join(cursorDir(), 'hooks.json'); }
function cfgDir() { return path.join(home(), '.config', CLIENT_ID); }
function keyFilePath() { return path.join(cfgDir(), KEY_FILENAME); }

/** Read a JSON object config; fail closed on anything that is not an object. */
async function readConfigObject(filePath) {
  const data = await readJson(filePath);
  if (data === null) return {};
  if (!isRecord(data)) throw new Error(`Expected a JSON object in ${filePath}; not modifying it`);
  return data;
}

function buildEntry({ isDev = false, projectDir, extraEnv = {} } = {}) {
  const env = { ...extraEnv, MIDBRAIN_CLIENT: CLIENT_ID };
  if (projectDir) env.MIDBRAIN_PROJECT_DIR = projectDir;
  if (isDev) {
    env.MIDBRAIN_DEV = '1';
    return { command: process.execPath, args: [path.join(REPO_ROOT, 'index.js')], env };
  }
  return { command: 'npx', args: ['-y', 'midbrain-memory-mcp@latest'], env };
}

async function patchMcpEntry(config, opts) {
  if (config.mcpServers !== undefined && !isRecord(config.mcpServers)) {
    throw new Error(`Expected "mcpServers" to be an object in ${opts.source}; not modifying it`);
  }
  config.mcpServers = config.mcpServers || {};
  const existing = config.mcpServers[MCP_KEY];
  const { exists, pinned, extraEnv } = classifyEntry(existing, 'env');
  const hostLines = pinned
    ? [pinnedHostEnvLine(existing, 'env')].filter(Boolean)
    : await migrateReservedHostEnv(existing?.env, {
        clientId: CLIENT_ID,
        projectDir: opts.projectDir,
        source: opts.source,
      });
  if (!pinned) config.mcpServers[MCP_KEY] = buildEntry({ ...opts, extraEnv });
  return { exists, pinned, hostLines };
}

async function writeMcpConfig(filePath, opts) {
  const config = await readConfigObject(filePath);
  const result = await patchMcpEntry(config, { ...opts, source: filePath });
  const written = await writeJsonIfChanged(filePath, config, { backupFirst: true });
  return { ...result, written };
}

/** Summary line for one MCP config file that reports whether it changed. */
function mcpLine(label, { exists, pinned, written }) {
  if (pinned || written) return formatMigrationLine(label, exists, pinned);
  return `${label}: midbrain-memory entry unchanged`;
}

function buildHookCommand(role) {
  return `${shellQuote(stableShimPath(CLIENT_ID))} ${role}`;
}

// Cursor is a new client (no pre-shim installs), so ownership is the stable
// shim or a midbrain `hook cursor` invocation — never a substring match.
function isMidbrainHook(hook) {
  const command = typeof hook?.command === 'string' ? hook.command : '';
  if (Object.values(HOOK_EVENTS).some((role) => command === buildHookCommand(role))) return true;
  return commandReferencesShim(command, CLIENT_ID) ||
    commandHasMidbrainInvocation(command, CLIENT_ID);
}

/**
 * Merge MidBrain hooks into a Cursor hooks.json object. Foreign hooks keep
 * their order; every owned entry is replaced by one canonical entry per event.
 * Non-array event values are user data we do not understand: fail closed.
 */
function patchHooks(data, filePath) {
  if (data.hooks !== undefined && !isRecord(data.hooks)) {
    throw new Error(`Expected "hooks" to be an object in ${filePath}; not modifying it`);
  }
  if (data.version === undefined) data.version = HOOKS_VERSION;
  data.hooks = data.hooks || {};
  for (const [event, role] of Object.entries(HOOK_EVENTS)) {
    const current = data.hooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      throw new Error(`Expected "hooks.${event}" to be an array in ${filePath}; not modifying it`);
    }
    const kept = (current || []).filter((hook) => !isMidbrainHook(hook));
    data.hooks[event] = [...kept, { command: buildHookCommand(role), timeout: HOOK_TIMEOUT_SEC }];
  }
  return data;
}

export class Cursor extends BaseClient {
  get id() { return CLIENT_ID; }
  get displayName() { return 'Cursor'; }

  isInstalled() {
    return existsSync(mcpPath()) || existsSync(cursorDir());
  }

  async resolveClientKey() {
    const source = keyFilePath();
    const key = await readKeyFile(source);
    return key ? { key, source } : null;
  }

  async writeKey(key, { replaceApproved = false } = {}) {
    await writeCredential({
      clientId: this.id,
      scope: 'client',
      targetPath: keyFilePath(),
      key,
      replaceApproved,
    });
    return `Key: ~/.config/cursor/${KEY_FILENAME} (chmod 600)`;
  }

  async installGlobal(_opts = {}) {
    const opts = { isDev: _opts.isDev === true };
    const hp = hooksPath();
    // Validate both files before writing either, so a malformed hooks.json
    // never leaves a half-applied install behind.
    const hooks = patchHooks(await readConfigObject(hp), hp);
    const mcp = await writeMcpConfig(mcpPath(), opts);

    const shim = await installShim(CLIENT_ID, { mode: 'install', isDev: opts.isDev });
    const hooksWritten = await writeJsonIfChanged(hp, hooks, { backupFirst: true });
    const lines = [
      mcpLine('~/.cursor/mcp.json', mcp),
      ...mcp.hostLines,
      `~/.cursor/hooks.json: MidBrain hooks ${hooksWritten ? 'written' : 'unchanged'}`,
      `~/.midbrain/bin/cursor-hook: stable Cursor hook shim ${shim.written ? 'written' : 'unchanged'}`,
    ];
    if (mcp.written || hooksWritten || shim.written) {
      lines.push('Restart Cursor (or reload the window) so it picks up the MCP server and hooks.');
    }
    return lines;
  }

  async installProject(projectDir, _opts = {}) {
    const configFile = path.join(projectDir, '.cursor', 'mcp.json');
    const mcp = await writeMcpConfig(configFile, {
      isDev: _opts.isDev === true,
      projectDir,
    });
    return [mcpLine(configFile, mcp), ...mcp.hostLines];
  }

  projectConfigFiles(_projectDir) {
    return ['.cursor/mcp.json'];
  }

  /**
   * Fresh when no MidBrain hook is installed, or when every event carries
   * exactly the canonical shim command and the shim body/mode is canonical
   * (or dev).
   */
  async isFresh() {
    try {
      const data = (await readJson(hooksPath())) || {};
      let hasMidbrainHook = false;
      let missingEvent = false;
      for (const [event, role] of Object.entries(HOOK_EVENTS)) {
        const entries = Array.isArray(data.hooks?.[event]) ? data.hooks[event] : [];
        const owned = entries.filter((hook) => isMidbrainHook(hook));
        if (owned.length === 0) { missingEvent = true; continue; }
        hasMidbrainHook = true;
        if (owned.length !== 1 || owned[0].command !== buildHookCommand(role)) return false;
      }
      if (!hasMidbrainHook) return true;
      // An install from before an event was added (sessionEnd, #97) is stale.
      if (missingEvent) return false;
      return (await shimStatus(CLIENT_ID)).fresh;
    } catch { return true; }
  }

  /**
   * Rewrite owned hook entries to the canonical shim command and reinstall a
   * missing or stale shim. Dev shim bodies are preserved; writes are
   * content-compared so a converged config sees no mtime churn.
   */
  async repairHooks() {
    const hp = hooksPath();
    let data;
    try {
      data = patchHooks(await readConfigObject(hp), hp);
    } catch { return []; } // unreadable/unexpected config: fail open, skip
    const shim = await installShim(CLIENT_ID, { mode: 'repair' });
    const wrote = await writeJsonIfChanged(hp, data);
    if (!wrote && !shim.written) return [];
    return ['  ~ Cursor hooks repaired (stable Cursor hook shim installed)'];
  }
}
