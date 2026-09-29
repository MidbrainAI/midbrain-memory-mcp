/**
 * OpenClaw client adapter.
 *
 * Encapsulates OpenClaw-specific config handling:
 * - <state>/openclaw.json (JSON5; state dir ~/.openclaw, or OPENCLAW_STATE_DIR,
 *   OPENCLAW_HOME, OPENCLAW_PROFILE; file OPENCLAW_CONFIG_PATH)
 *   - mcp.servers["midbrain-memory"]: the stdio MCP server entry
 *   - plugins.load.paths + plugins.entries["midbrain-memory"]: the capture
 *     plugin, enabled with hooks.allowConversationAccess (needed for agent_end)
 * - ~/.config/openclaw/midbrain-plugin/: the copied capture plugin + bundle
 * - ~/.config/openclaw/.midbrain-key (per-client key)
 *
 * Config writes, in order of preference:
 * 1. JSON/JSONC-compatible file: surgical jsonc-parser edit (keeps comments).
 * 2. JSON5-only syntax and `openclaw` on PATH: `openclaw config patch --stdin`
 *    (OpenClaw validates and rewrites the file; it strips JSON5 comments).
 * 3. Otherwise: JSON5 parse, merge and rewrite as JSON after a backup.
 *
 * OpenClaw has no per-project MCP config; installProject is a no-op. The
 * managed rules block goes into the default agent workspace's AGENTS.md
 * (shared/agent-rules.mjs), only when OpenClaw has already created that file.
 */

import { BaseClient, readKeyFile } from './base.mjs';
import { writeCredential } from './credential-writer.mjs';
import {
  KEY_FILENAME, MCP_KEY, REPO_ROOT, PKG_NAME, PKG_VERSION,
  home, backup, writeFileIfChanged, classifyEntry,
  migrateReservedHostEnv, pinnedHostEnvLine,
} from './utils.mjs';

import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const CLIENT_ID = 'openclaw';
export const PLUGIN_ID = 'midbrain-memory';
const PLUGIN_SOURCE_DIR = path.join(REPO_ROOT, 'plugins', 'openclaw');
const PLUGIN_FILES = ['index.js', 'openclaw.plugin.json', 'package.json'];
const BUNDLE_FILE = 'midbrain-shared.mjs';
const MARKER_FILE = '.midbrain-repo-root';
// Version-only marker, dev-flagged for --dev installs: same freshness contract
// as the OpenCode plugin copy (PRD-034 S2/M6, AC-14).
const MARKER_VALUE = `${PKG_NAME}@${PKG_VERSION}`;
const MARKER_VALUE_DEV = `${MARKER_VALUE}-dev`;
const JSONC_FORMAT = { tabSize: 2, insertSpaces: true, eol: '\n' };

// Lazy-loaded: only config writing needs the parsers, and the plugin bundle
// (which imports this module through the registry) must not require them.
let _jsonc;
async function jsonc() {
  if (!_jsonc) _jsonc = await import('jsonc-parser');
  return _jsonc;
}
let _json5;
async function json5() {
  if (!_json5) _json5 = (await import('json5')).default;
  return _json5;
}

// --- Paths (lazy: tests override HOME and the OPENCLAW_* env) ---

function openclawHome() {
  return process.env.OPENCLAW_HOME || home();
}

/** OpenClaw state dir: OPENCLAW_STATE_DIR, else ~/.openclaw[-<profile>]. */
export function openclawStateDir() {
  if (process.env.OPENCLAW_STATE_DIR) return process.env.OPENCLAW_STATE_DIR;
  const profile = (process.env.OPENCLAW_PROFILE || '').trim();
  const name = profile && profile !== 'default' ? `.openclaw-${profile}` : '.openclaw';
  return path.join(openclawHome(), name);
}

/** Active openclaw.json path. */
export function openclawConfigPath() {
  return process.env.OPENCLAW_CONFIG_PATH || path.join(openclawStateDir(), 'openclaw.json');
}

function cfgDir() { return path.join(home(), '.config', CLIENT_ID); }
function keyFilePath() { return path.join(cfgDir(), KEY_FILENAME); }
export function openclawPluginDir() { return path.join(cfgDir(), 'midbrain-plugin'); }

function expandHome(p) {
  if (p === '~') return openclawHome();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(openclawHome(), p.slice(2));
  return p;
}

/**
 * Default agent workspace (where OpenClaw reads AGENTS.md):
 * OPENCLAW_WORKSPACE_DIR, else agents.defaults.workspace, else <state>/workspace.
 * An unreadable config falls back to the default location.
 */
export async function openclawWorkspaceDir() {
  if (process.env.OPENCLAW_WORKSPACE_DIR) return process.env.OPENCLAW_WORKSPACE_DIR;
  try {
    const { data } = await readConfig(openclawConfigPath());
    const configured = data.agents?.defaults?.workspace;
    if (typeof configured === 'string' && configured.trim()) return expandHome(configured.trim());
  } catch { /* fall back to the default workspace */ }
  return path.join(openclawStateDir(), 'workspace');
}

// --- Config read/write ---

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read openclaw.json. Returns { text, data, jsoncCompatible }; a missing file
 * is an empty object. Anything that is not a JSON5 object fails closed.
 */
async function readConfig(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { text: null, data: {}, jsoncCompatible: true };
    throw err;
  }
  const { parse } = await jsonc();
  const errors = [];
  const viaJsonc = parse(text, errors, { allowTrailingComma: true });
  if (errors.length === 0) {
    if (!isRecord(viaJsonc)) throw new Error(`Expected a JSON object in ${filePath}; not modifying it`);
    return { text, data: viaJsonc, jsoncCompatible: true };
  }
  let data;
  try {
    data = (await json5()).parse(text);
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`, { cause: err });
  }
  if (!isRecord(data)) throw new Error(`Expected a JSON5 object in ${filePath}; not modifying it`);
  return { text, data, jsoncCompatible: false };
}

function buildEntry({ isDev = false, extraEnv = {} } = {}) {
  const env = { ...extraEnv, MIDBRAIN_CLIENT: CLIENT_ID };
  if (isDev) {
    env.MIDBRAIN_DEV = '1';
    return { command: process.execPath, args: [path.join(REPO_ROOT, 'index.js')], env };
  }
  return { command: 'npx', args: ['-y', 'midbrain-memory-mcp@latest'], env };
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function samePath(a, b) {
  return typeof a === 'string' && path.resolve(expandHome(a)) === path.resolve(b);
}

/**
 * Compute the config changes as [jsonPath, value] pairs, only for values that
 * differ from what is on disk. Unexpected shapes are user data: fail closed.
 */
async function planConfigChanges(data, { isDev, source }) {
  for (const [key, value] of [['mcp', data.mcp], ['plugins', data.plugins]]) {
    if (value !== undefined && !isRecord(value)) {
      throw new Error(`Expected "${key}" to be an object in ${source}; not modifying it`);
    }
  }
  if (data.mcp?.servers !== undefined && !isRecord(data.mcp.servers)) {
    throw new Error(`Expected "mcp.servers" to be an object in ${source}; not modifying it`);
  }
  const loadPaths = data.plugins?.load?.paths;
  if (loadPaths !== undefined && !Array.isArray(loadPaths)) {
    throw new Error(`Expected "plugins.load.paths" to be an array in ${source}; not modifying it`);
  }
  const entries = data.plugins?.entries;
  if (entries !== undefined && !isRecord(entries)) {
    throw new Error(`Expected "plugins.entries" to be an object in ${source}; not modifying it`);
  }

  const changes = [];
  const existing = data.mcp?.servers?.[MCP_KEY];
  const { exists, pinned, extraEnv } = classifyEntry(existing, 'env');
  const hostLines = pinned
    ? [pinnedHostEnvLine(existing, 'env')].filter(Boolean)
    : await migrateReservedHostEnv(existing?.env, { clientId: CLIENT_ID, source });
  if (!pinned) {
    const entry = buildEntry({ isDev, extraEnv });
    if (!sameJson(existing, entry)) changes.push([['mcp', 'servers', MCP_KEY], entry]);
  }

  const pluginDir = openclawPluginDir();
  if (!(loadPaths || []).some((p) => samePath(p, pluginDir))) {
    changes.push([['plugins', 'load', 'paths'], [...(loadPaths || []), pluginDir]]);
  }
  const current = isRecord(entries?.[PLUGIN_ID]) ? entries[PLUGIN_ID] : {};
  const hooks = isRecord(current.hooks) ? current.hooks : {};
  const wanted = { ...current, enabled: true, hooks: { ...hooks, allowConversationAccess: true } };
  if (!sameJson(current, wanted)) changes.push([['plugins', 'entries', PLUGIN_ID], wanted]);

  return { changes, exists, pinned, hostLines };
}

/** Nested patch object for `openclaw config patch` from [path, value] pairs. */
function toPatchObject(changes) {
  const patch = {};
  for (const [jsonPath, value] of changes) {
    let node = patch;
    for (const key of jsonPath.slice(0, -1)) node = node[key] ??= {};
    node[jsonPath.at(-1)] = value;
  }
  return patch;
}

function setPath(obj, jsonPath, value) {
  let node = obj;
  for (const key of jsonPath.slice(0, -1)) {
    if (!isRecord(node[key])) node[key] = {};
    node = node[key];
  }
  node[jsonPath.at(-1)] = value;
}

/** Absolute path of the `openclaw` executable on PATH, or null. */
function findOpenclawCli() {
  const names = process.platform === 'win32' ? ['openclaw.cmd', 'openclaw.exe', 'openclaw'] : ['openclaw'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function defaultCliRunner(cli, args, input) {
  return spawnSync(cli, args, {
    input,
    encoding: 'utf8',
    timeout: 60_000,
    // .cmd shims need a shell on Windows; args are fixed literals and the
    // patch travels on stdin, so nothing user-controlled is shell-parsed.
    shell: process.platform === 'win32',
    windowsHide: true,
  });
}

let cliRunner = defaultCliRunner;
let cliFinder = findOpenclawCli;

/** Test seam: replace the CLI lookup and runner; call with no args to reset. */
export function _setOpenclawCli({ find, run } = {}) {
  cliFinder = find || findOpenclawCli;
  cliRunner = run || defaultCliRunner;
}

/**
 * Apply the planned changes. Returns the strategy used: 'unchanged',
 * 'created', 'jsonc', 'cli' or 'rewrite'.
 */
async function applyConfigChanges(filePath, { text, data, jsoncCompatible }, changes) {
  if (changes.length === 0) return 'unchanged';
  if (text === null) {
    const created = {};
    for (const [jsonPath, value] of changes) setPath(created, jsonPath, value);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(created, null, 2) + '\n', 'utf8');
    return 'created';
  }
  if (jsoncCompatible) {
    const { modify, applyEdits } = await jsonc();
    let next = text;
    for (const [jsonPath, value] of changes) {
      next = applyEdits(next, modify(next, jsonPath, value, { formattingOptions: JSONC_FORMAT }));
    }
    if (!next.endsWith('\n')) next += '\n';
    await backup(filePath);
    await fs.writeFile(filePath, next, 'utf8');
    return 'jsonc';
  }
  const cli = cliFinder();
  if (cli) {
    const result = cliRunner(cli, ['config', 'patch', '--stdin'], JSON.stringify(toPatchObject(changes)));
    if (result?.status === 0) return 'cli';
    const detail = String(result?.stderr || result?.stdout || result?.error?.message || '').trim().split('\n').pop();
    throw new Error(`openclaw config patch failed${detail ? `: ${detail}` : ''}`);
  }
  const merged = JSON.parse(JSON.stringify(data));
  for (const [jsonPath, value] of changes) setPath(merged, jsonPath, value);
  await backup(filePath);
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return 'rewrite';
}

// --- Plugin copy ---

function pluginSources() {
  return [
    ...PLUGIN_FILES.map((name) => [path.join(PLUGIN_SOURCE_DIR, name), name]),
    [path.join(REPO_ROOT, 'dist', BUNDLE_FILE), BUNDLE_FILE],
  ];
}

/** Copy plugin files + bundle (content-compared). Returns true if any changed. */
async function copyPlugin(markerValue) {
  const dir = openclawPluginDir();
  await fs.mkdir(dir, { recursive: true });
  let changed = false;
  for (const [src, name] of pluginSources()) {
    const content = await fs.readFile(src, 'utf8');
    if (await writeFileIfChanged(path.join(dir, name), content)) changed = true;
  }
  if (await writeFileIfChanged(path.join(dir, MARKER_FILE), markerValue + '\n')) changed = true;
  return changed;
}

function isDevMarkerValue(raw) {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  return value.startsWith(`${PKG_NAME}@`) && value.endsWith('-dev');
}

function isDevInstance() {
  return Boolean(process.env.MIDBRAIN_DEV);
}

const STRATEGY_NOTES = {
  cli: '(written by `openclaw config patch`; OpenClaw strips JSON5 comments)',
  rewrite: '(JSON5 rewritten as JSON; comments not preserved, backup at openclaw.json.bak)',
};

export class OpenClaw extends BaseClient {
  get id() { return CLIENT_ID; }
  get displayName() { return 'OpenClaw'; }

  isInstalled() {
    return existsSync(openclawConfigPath()) || existsSync(openclawStateDir());
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
    const { isDev = false } = opts;
    const summary = [];

    const pluginChanged = await copyPlugin(isDev ? MARKER_VALUE_DEV : MARKER_VALUE);
    summary.push(pluginChanged
      ? `  + Capture plugin installed: ~/.config/${CLIENT_ID}/midbrain-plugin/`
      : `  = Capture plugin unchanged: ~/.config/${CLIENT_ID}/midbrain-plugin/`);

    const configPath = openclawConfigPath();
    const config = await readConfig(configPath);
    const { changes, exists, pinned, hostLines } = await planConfigChanges(config.data, { isDev, source: configPath });
    const mcpChanged = changes.some(([p]) => p[0] === 'mcp');
    const strategy = await applyConfigChanges(configPath, config, changes);

    const label = path.basename(configPath);
    if (pinned) summary.push(`  ~ MCP server: pinned version preserved in ${label}`);
    else if (!mcpChanged) summary.push(`  = MCP server unchanged in ${label}`);
    else summary.push(exists ? `  ~ MCP server: updated in ${label}` : `  + MCP server added to ${label}`);
    summary.push(strategy === 'unchanged'
      ? `  = Plugin entry unchanged in ${label}`
      : `  + Plugin "${PLUGIN_ID}" linked and enabled in ${label} ${STRATEGY_NOTES[strategy] || ''}`.trimEnd());
    summary.push(...hostLines);
    if (pluginChanged || strategy !== 'unchanged') {
      summary.push('  -> Restart the OpenClaw gateway to load the capture plugin');
    }
    return summary;
  }

  async installProject(_projectDir, _opts) { return []; }
  projectConfigFiles(_projectDir) { return []; }

  /**
   * Fresh when the marker matches this version and every copied file matches
   * the package's bytes. Dev state is pinned in both directions (AC-14).
   */
  async isFresh() {
    try {
      if (isDevInstance()) return true;
      const dir = openclawPluginDir();
      if (!existsSync(dir)) return true; // never installed: nothing to repair
      const raw = await fs.readFile(path.join(dir, MARKER_FILE), 'utf8');
      if (isDevMarkerValue(raw)) return true;
      if (raw.trim() !== MARKER_VALUE) return false;
      for (const [src, name] of pluginSources()) {
        const [source, installed] = await Promise.all([
          fs.readFile(src, 'utf8'),
          fs.readFile(path.join(dir, name), 'utf8'),
        ]);
        if (source !== installed) return false;
      }
      return true;
    } catch { return false; }
  }

  /** Re-copy stale plugin files; never touches openclaw.json. */
  async repairPlugins() {
    if (isDevInstance()) return [];
    try {
      if (isDevMarkerValue(await fs.readFile(path.join(openclawPluginDir(), MARKER_FILE), 'utf8'))) return [];
    } catch { /* marker missing or unreadable -> proceed with canonical repair */ }
    if (!(await copyPlugin(MARKER_VALUE))) return [];
    return ['  ~ OpenClaw capture plugin repaired (re-copied); restart the gateway to load it'];
  }
}
