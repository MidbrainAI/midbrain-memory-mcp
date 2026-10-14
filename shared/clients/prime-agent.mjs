/**
 * Prime Agent client adapter (Prime Intellect's `prime-agent`).
 *
 * Encapsulates Prime Agent-specific config handling:
 * - <agent>/settings.json `mcpServers["midbrain-memory"]` (agent dir is
 *   ~/.prime/agent, or PRIME_AGENT_CODING_AGENT_DIR); project setup writes
 *   <project>/.prime/agent/settings.json
 * - <agent>/skills/midbrain-memory/: a Python skill. Prime Agent imports
 *   every Python skill into the session's Python kernel when the kernel
 *   starts; the import launches the capture watcher (plugins/prime-agent/)
 *   through the stable ~/.midbrain/bin/prime-agent-hook shim, and the module
 *   gives the model a `midbrain_memory(...)` search shortcut.
 * - ~/.config/prime-agent/.midbrain-key (per-client key)
 *
 * Prime Agent passes an MCP server only HOME, PATH and TMPDIR, and its `env`
 * entries can only reference variables the kernel already has, so the entry
 * runs `/bin/sh -c` to set MIDBRAIN_CLIENT and the project directory. The
 * global entry binds MIDBRAIN_PROJECT_DIR to the server's working directory,
 * which Prime Agent sets to the session's directory, so project keys apply
 * without a per-project install.
 */

import { BaseClient, readKeyFile } from './base.mjs';
import { writeCredential } from './credential-writer.mjs';
import {
  KEY_FILENAME, MCP_KEY, REPO_ROOT, PINNED_RE,
  PLUGIN_MARKER_FILE as MARKER_FILE, PLUGIN_MARKER_VALUE as MARKER_VALUE,
  PLUGIN_MARKER_VALUE_DEV as MARKER_VALUE_DEV, isDevMarkerValue, isDevInstance,
  isObjectRecord as isRecord,
  home, readJson, writeJsonIfChanged, writeFileIfChanged,
} from './utils.mjs';
import { shellQuote, installShim, shimStatus } from './shim.mjs';
import { cacheDir } from '../state-dir.mjs';

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

export const CLIENT_ID = 'prime-agent';
export const SKILL_NAME = 'midbrain-memory';
const SKILL_SOURCE_DIR = path.join(REPO_ROOT, 'plugins', 'prime-agent', 'skill');
const SKILL_FILES = [
  'SKILL.md',
  'pyproject.toml',
  path.join('src', 'midbrain_memory', '__init__.py'),
];
const SH = '/bin/sh';
// Settings the user may set on our entry; a rebuilt entry keeps them.
const USER_ENTRY_KEYS = ['enabled', 'enabledTools', 'disabledTools', 'startupTimeoutMs', 'callTimeoutMs', 'env'];
// A cold `npx` download can outlast Prime Agent's default MCP startup wait.
const STARTUP_TIMEOUT_MS = 60_000;
// Marks when capture was enabled: sessions that started earlier are
// captured from the point the watcher first sees them, not from the start.
const ENABLED_AT_FILE = 'enabled-at';

// --- Paths (lazy: tests override HOME and the PRIME_AGENT_* env) ---

function expandHome(p) {
  if (p === '~') return home();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home(), p.slice(2));
  return p;
}

/** Prime Agent's agent dir: PRIME_AGENT_CODING_AGENT_DIR, else ~/.prime/agent. */
export function primeAgentDir(env = process.env) {
  const configured = env.PRIME_AGENT_CODING_AGENT_DIR?.trim();
  return configured ? expandHome(configured) : path.join(home(), '.prime', 'agent');
}

function settingsPath() { return path.join(primeAgentDir(), 'settings.json'); }
function projectSettingsPath(projectDir) { return path.join(projectDir, '.prime', 'agent', 'settings.json'); }
export function primeSkillDir() { return path.join(primeAgentDir(), 'skills', SKILL_NAME); }
function cfgDir() { return path.join(home(), '.config', CLIENT_ID); }
function keyFilePath() { return path.join(cfgDir(), KEY_FILENAME); }

/** MidBrain's own Prime Agent capture state (cursors, locks). */
export function primeCaptureStateDir() { return path.join(cacheDir(), CLIENT_ID); }

/**
 * Where Prime Agent writes session logs: PRIME_AGENT_SESSION_DIR (or the
 * legacy PRIME_AGENT_CODING_AGENT_SESSION_DIR), then the `sessionDir`
 * setting, then <agent>/sessions.
 */
export async function primeSessionsDir(env = process.env) {
  const fromEnv = env.PRIME_AGENT_SESSION_DIR?.trim() || env.PRIME_AGENT_CODING_AGENT_SESSION_DIR?.trim();
  if (fromEnv) return expandHome(fromEnv);
  try {
    const settings = await readJson(path.join(primeAgentDir(env), 'settings.json'));
    const configured = settings?.sessionDir;
    if (typeof configured === 'string' && configured.trim()) return expandHome(configured.trim());
  } catch { /* unreadable settings: Prime Agent's default */ }
  return path.join(primeAgentDir(env), 'sessions');
}

// --- MCP entry ---

/** The `sh -c` script that starts the server with MidBrain's env. */
function serverScript({ isDev, projectDir }) {
  const project = projectDir ? shellQuote(projectDir) : '"$PWD"';
  const vars = [`MIDBRAIN_CLIENT=${CLIENT_ID}`];
  if (isDev) vars.push('MIDBRAIN_DEV=1');
  vars.push(`MIDBRAIN_PROJECT_DIR=${project}`);
  const command = isDev
    ? `${shellQuote(process.execPath)} ${shellQuote(path.join(REPO_ROOT, 'index.js'))}`
    : 'npx -y midbrain-memory-mcp@latest';
  return `${vars.join(' ')} exec ${command}`;
}

function buildEntry(existing, opts) {
  const kept = {};
  for (const key of USER_ENTRY_KEYS) {
    if (isRecord(existing) && existing[key] !== undefined) kept[key] = existing[key];
  }
  return {
    type: 'stdio',
    command: SH,
    args: ['-c', serverScript(opts)],
    startupTimeoutMs: STARTUP_TIMEOUT_MS,
    ...kept,
  };
}

/** A user-pinned `midbrain-memory-mcp@x.y.z` anywhere in the entry stays as is. */
function isPinned(entry) {
  if (!isRecord(entry)) return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return [entry.command, ...args].some((v) => typeof v === 'string' && PINNED_RE.test(v));
}

/** Read a JSON object config; fail closed on anything that is not an object. */
async function readConfigObject(filePath) {
  const data = await readJson(filePath);
  if (data === null) return {};
  if (!isRecord(data)) throw new Error(`Expected a JSON object in ${filePath}; not modifying it`);
  return data;
}

async function writeMcpConfig(filePath, opts) {
  const config = await readConfigObject(filePath);
  if (config.mcpServers !== undefined && !isRecord(config.mcpServers)) {
    throw new Error(`Expected "mcpServers" to be an object in ${filePath}; not modifying it`);
  }
  config.mcpServers = config.mcpServers || {};
  const existing = config.mcpServers[MCP_KEY];
  const exists = existing !== undefined;
  const pinned = isPinned(existing);
  if (!pinned) config.mcpServers[MCP_KEY] = buildEntry(existing, opts);
  const written = pinned ? false : await writeJsonIfChanged(filePath, config, { backupFirst: true });
  return { exists, pinned, written };
}

function mcpLine(label, { exists, pinned, written }) {
  if (pinned) return `${label}: midbrain-memory pinned version preserved (no change)`;
  if (!written) return `${label}: midbrain-memory entry unchanged`;
  return exists ? `${label}: midbrain-memory updated` : `${label}: midbrain-memory entry added`;
}

// --- Skill copy ---

function skillSources() {
  return SKILL_FILES.map((name) => [path.join(SKILL_SOURCE_DIR, name), name]);
}

/** Copy the skill files (content-compared). Returns true if any changed. */
async function copySkill(markerValue) {
  const dir = primeSkillDir();
  let changed = false;
  for (const [src, name] of skillSources()) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (await writeFileIfChanged(target, await fs.readFile(src, 'utf8'))) changed = true;
  }
  if (await writeFileIfChanged(path.join(dir, MARKER_FILE), markerValue + '\n')) changed = true;
  return changed;
}

/** Record when capture was enabled, once; never moved forward by a re-install. */
async function markCaptureEnabled() {
  const file = path.join(primeCaptureStateDir(), ENABLED_AT_FILE);
  if (existsSync(file)) return;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, new Date().toISOString() + '\n', { encoding: 'utf8', flag: 'wx' }).catch((err) => {
    if (err.code !== 'EEXIST') throw err;
  });
}

/** When capture was enabled (ms since epoch), or null when never recorded. */
export async function captureEnabledAt() {
  try {
    const parsed = Date.parse((await fs.readFile(path.join(primeCaptureStateDir(), ENABLED_AT_FILE), 'utf8')).trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch { return null; }
}

export { markCaptureEnabled };

export class PrimeAgent extends BaseClient {
  get id() { return CLIENT_ID; }
  get displayName() { return 'Prime Agent'; }

  isInstalled() {
    return existsSync(primeAgentDir());
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
    return `Key: ~/.config/${CLIENT_ID}/${KEY_FILENAME} (chmod 600)`;
  }

  async installGlobal(opts = {}) {
    if (process.platform === 'win32') {
      return ['Prime Agent on Windows is not supported yet (the MCP entry needs /bin/sh); skipped.'];
    }
    const isDev = opts.isDev === true;
    const sp = settingsPath();
    // Validate settings.json before writing anything else.
    await readConfigObject(sp);
    const mcp = await writeMcpConfig(sp, { isDev });
    const skillChanged = await copySkill(isDev ? MARKER_VALUE_DEV : MARKER_VALUE);
    const shim = await installShim(CLIENT_ID, { mode: 'install', isDev });
    await markCaptureEnabled();
    const lines = [
      mcpLine('~/.prime/agent/settings.json', mcp),
      `~/.prime/agent/skills/${SKILL_NAME}: capture skill ${skillChanged ? 'installed' : 'unchanged'}`,
      `~/.midbrain/bin/${CLIENT_ID}-hook: stable Prime Agent hook shim ${shim.written ? 'written' : 'unchanged'}`,
    ];
    if (mcp.written || skillChanged || shim.written) {
      lines.push('New Prime Agent sessions pick this up; restart running ones (`prime-agent shutdown`) to load it now.');
    }
    return lines;
  }

  async installProject(projectDir, _opts = {}) {
    if (process.platform === 'win32') return [];
    const configFile = projectSettingsPath(projectDir);
    const mcp = await writeMcpConfig(configFile, { isDev: _opts.isDev === true, projectDir });
    return [mcpLine(configFile, mcp)];
  }

  projectConfigFiles(_projectDir) {
    return ['.prime/agent/settings.json'];
  }

  /**
   * Fresh when the skill marker matches this version, every copied file
   * matches the package's bytes, and the shim is canonical. Dev state is
   * pinned in both directions.
   */
  async isFresh() {
    try {
      if (isDevInstance()) return true;
      const dir = primeSkillDir();
      if (!existsSync(dir)) return true; // never installed: nothing to repair
      const raw = await fs.readFile(path.join(dir, MARKER_FILE), 'utf8');
      if (isDevMarkerValue(raw)) return true;
      if (raw.trim() !== MARKER_VALUE) return false;
      for (const [src, name] of skillSources()) {
        const [source, installed] = await Promise.all([
          fs.readFile(src, 'utf8'),
          fs.readFile(path.join(dir, name), 'utf8'),
        ]);
        if (source !== installed) return false;
      }
      return (await shimStatus(CLIENT_ID)).fresh;
    } catch { return false; }
  }

  /** Re-copy a stale skill and shim; never touches settings.json. */
  async repairPlugins() {
    if (isDevInstance()) return [];
    if (!existsSync(primeSkillDir())) return [];
    try {
      if (isDevMarkerValue(await fs.readFile(path.join(primeSkillDir(), MARKER_FILE), 'utf8'))) return [];
    } catch { /* marker missing or unreadable -> proceed with canonical repair */ }
    const skillChanged = await copySkill(MARKER_VALUE);
    const shim = await installShim(CLIENT_ID, { mode: 'repair' });
    if (!skillChanged && !shim.written) return [];
    return ['  ~ Prime Agent capture skill repaired; new sessions load it'];
  }
}
