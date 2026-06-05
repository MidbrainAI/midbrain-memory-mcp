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
  home, backup, classifyEntry, formatMigrationLine,
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
const MARKER_VALUE = `${PKG_NAME}@${PKG_VERSION}:${REPO_ROOT}`;
const EXPECTED_PLUGIN_FILES = new Set([PLUGIN_FILE, BUNDLE_FILE, MARKER_FILE]);

/** Remove stale midbrain plugin files that aren't part of the current release. */
async function cleanStalePlugins(pd) {
  try {
    const entries = await fs.readdir(pd);
    for (const entry of entries) {
      if (entry.startsWith('midbrain-') || entry.startsWith('.midbrain-') || entry === 'clients') {
        if (!EXPECTED_PLUGIN_FILES.has(entry)) {
          await fs.rm(path.join(pd, entry), { recursive: true, force: true });
        }
      }
    }
  } catch { /* ignore — dir may not exist yet */ }
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

    // Copy plugin + bundled shared code (2 files, no transformation needed)
    const pd = pluginsDir();
    await fs.mkdir(pd, { recursive: true });
    await cleanStalePlugins(pd);

    await fs.copyFile(
      path.join(REPO_ROOT, 'plugins', 'opencode', PLUGIN_FILE),
      path.join(pd, PLUGIN_FILE),
    );
    summary.push(`  + Plugin installed: ~/.config/opencode/plugins/${PLUGIN_FILE}`);

    await fs.copyFile(
      path.join(REPO_ROOT, 'dist', BUNDLE_FILE),
      path.join(pd, BUNDLE_FILE),
    );
    summary.push(`  + Bundle copied: ~/.config/opencode/plugins/${BUNDLE_FILE}`);

    // Write freshness marker for staleness detection
    await fs.writeFile(path.join(pd, MARKER_FILE), MARKER_VALUE + '\n', 'utf8');

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
   * Returns true if fresh (marker matches REPO_ROOT), false if stale.
   */
  async isFresh() {
    try {
      const markerPath = path.join(pluginsDir(), MARKER_FILE);
      const raw = await fs.readFile(markerPath, 'utf8');
      return raw.trim() === MARKER_VALUE;
    } catch { return false; }
  }

  /**
   * Repair stale plugin files by re-copying from current REPO_ROOT.
   * Also writes a freshness marker.
   */
  async repairPlugins() {
    const pd = pluginsDir();
    await fs.mkdir(pd, { recursive: true });
    await cleanStalePlugins(pd);

    await fs.copyFile(
      path.join(REPO_ROOT, 'plugins', 'opencode', PLUGIN_FILE),
      path.join(pd, PLUGIN_FILE),
    );
    await fs.copyFile(
      path.join(REPO_ROOT, 'dist', BUNDLE_FILE),
      path.join(pd, BUNDLE_FILE),
    );

    await fs.writeFile(path.join(pd, MARKER_FILE), MARKER_VALUE + '\n', 'utf8');
    return ['  ~ OpenCode plugin files repaired (re-copied)'];
  }
}

// Re-export for backward compat (used by install.mjs tests)
export { resolveConfig as resolveOpencodeConfig };
