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

import { BaseClient, readKeyFile } from './base.mjs';
import {
  KEY_FILENAME, MCP_KEY, REPO_ROOT, PKG_NAME, PKG_VERSION,
  home, backup, classifyEntry, formatMigrationLine, writeFileIfChanged,
} from './utils.mjs';

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// Lazy-loaded: jsonc-parser is only needed for config writing, not key
// resolution. Keeping it lazy lets the plugin/hook runtime import this
// module without requiring jsonc-parser to be installed.
let _jsonc;
async function jsonc() {
  if (!_jsonc) _jsonc = await import('jsonc-parser');
  return _jsonc;
}

const JSONC_FORMAT = { tabSize: 2, insertSpaces: true, eol: '\n' };

// Lazy accessors — must resolve at call time, not module load time,
// because tests override process.env.HOME.
function configDir() { return path.join(home(), '.config', 'opencode'); }
function pluginsDir() { return path.join(configDir(), 'plugins'); }
function ownKeyPath() { return path.join(configDir(), KEY_FILENAME); }

// --- Plugin deploy constants (single source of truth for copy + cleanup) ---
const PLUGIN_FILE = 'midbrain-memory.ts';
const BUNDLE_FILE = 'midbrain-shared.mjs';
const MARKER_FILE = '.midbrain-repo-root';
// Version-only (PRD-034 S2/M6): the marker must never embed the running
// instance's location — freshness is version + content, not path identity.
// Old `name@version:/path` markers mismatch once and migrate on first repair.
const MARKER_VALUE = `${PKG_NAME}@${PKG_VERSION}`;
// Dev installs flag the marker (AC-14): automatic repair treats it as pinned
// regardless of version, mirroring dev shim bodies. Explicit non-dev install
// rewrites the canonical value, clearing the flag.
const MARKER_VALUE_DEV = `${MARKER_VALUE}-dev`;

/** True for any dev-flagged marker, any version — dev pins never expire. */
function isDevMarkerValue(raw) {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  return value.startsWith(`${PKG_NAME}@`) && value.endsWith('-dev');
}

/** True when the running server itself was launched by a dev MCP entry. */
function isDevInstance() {
  return Boolean(process.env.MIDBRAIN_DEV);
}

// Closed list of legacy artifacts (AC-13): exactly what prior releases copied
// into ~/.config/opencode/plugins/ (pre-bundle era: shared modules — incl.
// midbrain-common.mjs shipped v0.1.0–v0.3.2 — plus a clients/ tree) and
// nothing else. The plugins dir is user territory — never delete by prefix
// or dirname guesses.
const LEGACY_PLUGIN_FILES = ['logger.mjs', 'midbrain-api.mjs', 'midbrain-common.mjs'];
const LEGACY_CLIENTS_DIR = 'clients';
const LEGACY_CLIENTS_FILES = [
  'base.mjs', 'utils.mjs', 'generic.mjs', 'opencode.mjs', 'claude.mjs', 'codex.mjs', 'registry.mjs',
];

/**
 * Content-compared copy: write dest only when bytes differ. Falls back to a
 * plain copy when the source cannot be read for comparison — the copy must
 * never fail because the no-churn optimization could not run.
 */
async function copyFileIfChanged(src, dest) {
  let content;
  try {
    content = await fs.readFile(src, 'utf8');
  } catch {
    await fs.copyFile(src, dest);
    return true;
  }
  return writeFileIfChanged(dest, content);
}

/** Delete one file, fail-open (missing, mocked-out fs, or permissions). */
async function rmQuiet(target) {
  try {
    await fs.rm(target, { force: true });
  } catch { /* fail open: cleanup must never break install/repair */ }
}

/**
 * Remove confirmed legacy midbrain artifacts — closed list only (AC-13).
 * The legacy clients/ dir is removed only when emptied by that list: rmdir
 * refuses a non-empty dir, so user-owned files keep the dir alive.
 */
async function cleanStalePlugins(pd) {
  for (const name of LEGACY_PLUGIN_FILES) {
    await rmQuiet(path.join(pd, name));
  }
  const clientsDir = path.join(pd, LEGACY_CLIENTS_DIR);
  for (const name of LEGACY_CLIENTS_FILES) {
    await rmQuiet(path.join(clientsDir, name));
  }
  try {
    await fs.rmdir(clientsDir);
  } catch { /* absent, non-empty (user files), or mocked fs — keep it */ }
}

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

/** Builds the MCP entry for this client. */
function buildEntry({ isDev = false, projectDir } = {}) {
  if (isDev) {
    const environment = { MIDBRAIN_CLIENT: 'opencode', MIDBRAIN_DEV: '1' };
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
    const source = ownKeyPath();
    const key = await readKeyFile(source);
    return key ? { key, source } : null;
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

    // Copy plugin + bundled shared code (2 files, no transformation needed).
    // Content-compared: identical files keep their mtimes (PRD-034 D4).
    const pd = pluginsDir();
    await fs.mkdir(pd, { recursive: true });
    await cleanStalePlugins(pd);

    await copyFileIfChanged(
      path.join(REPO_ROOT, 'plugins', 'opencode', PLUGIN_FILE),
      path.join(pd, PLUGIN_FILE),
    );
    summary.push(`  + Plugin installed: ~/.config/opencode/plugins/${PLUGIN_FILE}`);

    await copyFileIfChanged(
      path.join(REPO_ROOT, 'dist', BUNDLE_FILE),
      path.join(pd, BUNDLE_FILE),
    );
    summary.push(`  + Bundle copied: ~/.config/opencode/plugins/${BUNDLE_FILE}`);

    // Write freshness marker for staleness detection; --dev flags it so
    // automatic repair pins the checkout's plugin bytes (AC-14).
    await writeFileIfChanged(path.join(pd, MARKER_FILE), (isDev ? MARKER_VALUE_DEV : MARKER_VALUE) + '\n');

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
    const { exists, pinned, extraEnv: customEnv } = classifyEntry(existing, 'environment');
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
    const { exists, pinned, extraEnv } = classifyEntry(existingEntry, 'environment');

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

  /**
   * Check if plugin files are fresh by comparing a version marker.
   * Returns true only when marker and copied file contents match. The marker
   * alone can lie if a previous repair was interrupted or manually reverted.
   * Dev state is pinned in both directions (AC-14): a dev-flagged marker is
   * never judged stale, and a dev instance never judges canonical state stale
   * (it must not auto-propagate its checkout bytes).
   */
  async isFresh() {
    try {
      if (isDevInstance()) return true;
      const markerPath = path.join(pluginsDir(), MARKER_FILE);
      const raw = await fs.readFile(markerPath, 'utf8');
      if (isDevMarkerValue(raw)) return true;
      if (raw.trim() !== MARKER_VALUE) return false;

      const sourcePlugin = await fs.readFile(path.join(REPO_ROOT, 'plugins', 'opencode', PLUGIN_FILE), 'utf8');
      const installedPlugin = await fs.readFile(path.join(pluginsDir(), PLUGIN_FILE), 'utf8');
      if (sourcePlugin !== installedPlugin) return false;

      const sourceBundle = await fs.readFile(path.join(REPO_ROOT, 'dist', BUNDLE_FILE), 'utf8');
      const installedBundle = await fs.readFile(path.join(pluginsDir(), BUNDLE_FILE), 'utf8');
      return sourceBundle === installedBundle;
    } catch { return false; }
  }

  /**
   * Repair stale plugin files by re-copying the running package's content.
   * Copies are version content, not paths — safe from any canonical context.
   * Content-compared, so an interrupted-marker case rewrites only what
   * actually differs. Dev state is pinned (AC-14): a dev-flagged install is
   * preserved byte-identical, and a dev instance never propagates its bytes —
   * only an explicit `install` crosses the dev/canonical boundary.
   */
  async repairPlugins() {
    if (isDevInstance()) return [];
    const pd = pluginsDir();
    try {
      if (isDevMarkerValue(await fs.readFile(path.join(pd, MARKER_FILE), 'utf8'))) return [];
    } catch { /* marker missing or unreadable -> proceed with canonical repair */ }
    await fs.mkdir(pd, { recursive: true });
    await cleanStalePlugins(pd);

    const wrotePlugin = await copyFileIfChanged(
      path.join(REPO_ROOT, 'plugins', 'opencode', PLUGIN_FILE),
      path.join(pd, PLUGIN_FILE),
    );
    const wroteBundle = await copyFileIfChanged(
      path.join(REPO_ROOT, 'dist', BUNDLE_FILE),
      path.join(pd, BUNDLE_FILE),
    );

    const wroteMarker = await writeFileIfChanged(path.join(pd, MARKER_FILE), MARKER_VALUE + '\n');
    if (!wrotePlugin && !wroteBundle && !wroteMarker) return [];
    return ['  ~ OpenCode plugin files repaired (re-copied)'];
  }
}

// Re-export for backward compat (used by install.mjs tests)
export { resolveConfig as resolveOpencodeConfig };
