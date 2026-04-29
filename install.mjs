#!/usr/bin/env node
/**
 * install.mjs — MidBrain Memory MCP automated installer
 *
 * Interactive: node install.mjs
 * Project:     node install.mjs --project /absolute/path/to/project
 *
 * Detects OpenCode and/or Claude Code, asks for API key(s), writes per-client
 * key files (chmod 600), patches configs, copies plugin files. Idempotent.
 *
 * --project mode is non-interactive: resolves keys from existing files, creates
 * .midbrain/.midbrain-key, writes project-level MCP configs, outputs JSON to
 * stdout. All progress/debug goes to stderr only.
 *
 * Key strategy (Jesper-approved: files over env):
 * - Each client gets its own .midbrain-key file in its config dir
 * - Global fallback at ~/.config/midbrain/.midbrain-key
 * - MIDBRAIN_CONFIG_DIR env var in client configs points to the client's config dir
 * - No API key material in any env block or command string
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { parse as jsoncParse, modify as jsoncModify, applyEdits } from 'jsonc-parser';
import {
  buildMcpCommandSpec,
  toOpenCodeShape,
  toClaudeShape,
} from './shared/midbrain-common.mjs';

// Reserved env keys that are rewritten on every install/migration. Custom
// env vars on existing midbrain entries are carried over to the new entry
// so users don't silently lose configuration on a re-run.
const RESERVED_ENV_KEYS = new Set(['MIDBRAIN_CONFIG_DIR', 'MIDBRAIN_PROJECT_DIR']);

/**
 * Extracts non-reserved env keys from an existing MCP entry.
 * @param {object|undefined} entry
 * @param {"environment"|"env"} envKey  "environment" for OpenCode, "env" for Claude.
 */
function extractCustomEnv(entry, envKey) {
  const source = entry && typeof entry === 'object' && entry[envKey];
  if (!source || typeof source !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(source)) {
    if (!RESERVED_ENV_KEYS.has(k)) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_DIR = __dirname; // install.mjs lives at repo root

const HOME = os.homedir();

const KEY_FILENAME = '.midbrain-key';
const MCP_KEY = 'midbrain-memory';
const PERM_KEYS = [
  'mcp__midbrain-memory__memory_search',
  'mcp__midbrain-memory__grep',
  'mcp__midbrain-memory__get_episodic_memories_by_date',
  'mcp__midbrain-memory__list_files',
  'mcp__midbrain-memory__read_file',
  'mcp__midbrain-memory__memory_setup_project',
];

const PATHS = {
  globalKey:        path.join(HOME, '.config', 'midbrain', KEY_FILENAME),
  opencodeKey:      path.join(HOME, '.config', 'opencode', KEY_FILENAME),
  opencodeDir:      path.join(HOME, '.config', 'opencode'),
  opencodePlugins:  path.join(HOME, '.config', 'opencode', 'plugins'),
  claudeKey:        path.join(HOME, '.config', 'claude', KEY_FILENAME),
  claudeJson:       path.join(HOME, '.claude.json'),
  claudeSettings:   path.join(HOME, '.claude', 'settings.json'),
};

const JSONC_FORMAT = { tabSize: 2, insertSpaces: true, eol: '\n' };

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Resolves which OpenCode config file exists in a directory.
 * Prefers .jsonc over .json (matches OpenCode's own resolution order).
 * Falls back to opencode.json for new installs.
 */
function resolveOpencodeConfig(dir) {
  const jsoncPath = path.join(dir, 'opencode.jsonc');
  if (existsSync(jsoncPath)) return jsoncPath;
  const jsonPath = path.join(dir, 'opencode.json');
  if (existsSync(jsonPath)) return jsonPath;
  return jsonPath; // default for new installs
}

/** Read and parse a JSON/JSONC file. Returns null if file does not exist. */
async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const errors = [];
    const result = jsoncParse(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      throw new SyntaxError(`Invalid JSON/JSONC content (${errors.length} error(s))`);
    }
    return result;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to parse ${filePath}: ${err.message}`, { cause: err });
  }
}

/** Write object as formatted JSON (creates dirs if needed). */
async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Surgically patch a JSON/JSONC file, preserving comments and formatting.
 * Each modification is { path: JSONPath, value: any } (value=undefined removes).
 * Creates the file with '{}' content if it does not exist.
 */
async function patchJsonFile(filePath, modifications) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') text = '{}';
    else throw err;
  }
  for (const { path: jsonPath, value } of modifications) {
    const edits = jsoncModify(text, jsonPath, value, { formattingOptions: JSONC_FORMAT });
    text = applyEdits(text, edits);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (!text.endsWith('\n')) text += '\n';
  await fs.writeFile(filePath, text, 'utf8');
}

/** Back up a file to <path>.bak (only if source exists). */
async function backup(filePath) {
  if (existsSync(filePath)) {
    await fs.copyFile(filePath, filePath + '.bak');
  }
}

/** Write a key to a file with chmod 600 (creates dirs if needed). */
async function writeKeyFile(filePath, key) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, key + '\n', 'utf8');
  await fs.chmod(filePath, 0o600);
}

/** Read an existing key file, return trimmed content or null. */
async function readKeyFile(filePath) {
  try {
    const key = (await fs.readFile(filePath, 'utf8')).trim();
    return key || null;
  } catch {
    return null;
  }
}

/** Prompt the user for input via readline. */
async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Prompt yes/no, returns boolean. */
async function promptYesNo(question) {
  const answer = await prompt(`${question} (y/n): `);
  return answer.toLowerCase().startsWith('y');
}

// ---------------------------------------------------------------------------
// Step 1: Detect installed tools
// ---------------------------------------------------------------------------
function detectTools() {
  const opencodeConfig = resolveOpencodeConfig(PATHS.opencodeDir);
  return {
    // PRD-010 fresh-install: detect OpenCode via config dir existence
    // too, so the starter-config path in installOpenCode is reachable
    // when ~/.config/opencode/ exists but opencode.json has not been
    // created yet.
    opencode: existsSync(opencodeConfig) || existsSync(PATHS.opencodeDir),
    claudeCode: existsSync(PATHS.claudeJson) || existsSync(PATHS.claudeSettings),
  };
}

// ---------------------------------------------------------------------------
// Step 2: Resolve API keys per client
// ---------------------------------------------------------------------------

/**
 * Finds existing key for a client, or returns null.
 * Checks: client config dir key file → global key file → env var.
 */
async function findExistingKey(clientKeyPath) {
  const clientKey = await readKeyFile(clientKeyPath);
  if (clientKey) return { key: clientKey, source: clientKeyPath };

  const globalKey = await readKeyFile(PATHS.globalKey);
  if (globalKey) return { key: globalKey, source: PATHS.globalKey };

  if (process.env.MIDBRAIN_API_KEY) {
    return { key: process.env.MIDBRAIN_API_KEY.trim(), source: 'env' };
  }

  return null;
}

/**
 * Resolves keys for all detected clients. Prompts when needed.
 * Returns { opencode?: string, claudeCode?: string, global: string }.
 */
async function resolveKeys(tools) {
  const keys = {};

  if (tools.opencode && tools.claudeCode) {
    // Both clients detected — check for existing keys first
    const existingOC = await findExistingKey(PATHS.opencodeKey);
    const existingCC = await findExistingKey(PATHS.claudeKey);

    if (existingOC && existingCC) {
      keys.opencode = existingOC.key;
      keys.claudeCode = existingCC.key;
      console.log(`Found OpenCode key: ${existingOC.source}`);
      console.log(`Found Claude Code key: ${existingCC.source}`);
    } else {
      const sameKey = await promptYesNo('Same API key for OpenCode and Claude Code?');
      if (sameKey) {
        const existing = existingOC || existingCC;
        const key = existing
          ? existing.key
          : await prompt('Enter your MidBrain API key: ');
        if (!key) throw new Error('API key is required. Aborting.');
        keys.opencode = key;
        keys.claudeCode = key;
      } else {
        keys.opencode = existingOC
          ? existingOC.key
          : await prompt('Enter OpenCode API key: ');
        keys.claudeCode = existingCC
          ? existingCC.key
          : await prompt('Enter Claude Code API key: ');
        if (!keys.opencode || !keys.claudeCode) {
          throw new Error('Both API keys are required. Aborting.');
        }
      }
    }
  } else if (tools.opencode) {
    const existing = await findExistingKey(PATHS.opencodeKey);
    keys.opencode = existing
      ? existing.key
      : await prompt('Enter your MidBrain API key: ');
    if (!keys.opencode) throw new Error('API key is required. Aborting.');
    if (existing) console.log(`Found key: ${existing.source}`);
  } else if (tools.claudeCode) {
    const existing = await findExistingKey(PATHS.claudeKey);
    keys.claudeCode = existing
      ? existing.key
      : await prompt('Enter your MidBrain API key: ');
    if (!keys.claudeCode) throw new Error('API key is required. Aborting.');
    if (existing) console.log(`Found key: ${existing.source}`);
  }

  // Global fallback uses the first available key
  keys.global = keys.opencode || keys.claudeCode;
  return keys;
}

// ---------------------------------------------------------------------------
// Step 3: Write key files
// ---------------------------------------------------------------------------
async function writeKeys(keys, summary) {
  // Global fallback
  await writeKeyFile(PATHS.globalKey, keys.global);
  summary.push(`Key: ~/.config/midbrain/${KEY_FILENAME} (chmod 600)`);

  if (keys.opencode) {
    await writeKeyFile(PATHS.opencodeKey, keys.opencode);
    summary.push(`Key: ~/.config/opencode/${KEY_FILENAME} (chmod 600)`);
  }

  if (keys.claudeCode) {
    await writeKeyFile(PATHS.claudeKey, keys.claudeCode);
    summary.push(`Key: ~/.config/claude/${KEY_FILENAME} (chmod 600)`);
  }
}

// ---------------------------------------------------------------------------
// Step 4: OpenCode installation
// ---------------------------------------------------------------------------

/**
 * Builds the OpenCode MCP entry for install.mjs.
 * Default: npx -y midbrain-memory-mcp@latest (auto-updating).
 * When isDev is true: absolute paths to local clone (for contributors).
 * @param {{isDev?: boolean, projectDir?: string}} [opts]
 */
function buildOpenCodeMcpEntry({ isDev = false, projectDir } = {}) {
  const configDir = path.join(HOME, '.config', 'opencode');
  if (isDev) {
    const environment = { MIDBRAIN_CONFIG_DIR: configDir };
    if (projectDir) environment.MIDBRAIN_PROJECT_DIR = projectDir;
    return {
      type: 'local',
      command: [process.execPath, path.join(SCRIPT_DIR, 'server.js')],
      environment,
      enabled: true,
    };
  }
  return toOpenCodeShape(buildMcpCommandSpec({ configDir, projectDir }));
}

/**
 * Builds the Claude Code MCP entry for install.mjs.
 * Default: npx -y midbrain-memory-mcp@latest. isDev: absolute paths.
 * @param {{isDev?: boolean, projectDir?: string}} [opts]
 */
function buildClaudeMcpEntry({ isDev = false, projectDir } = {}) {
  const configDir = path.join(HOME, '.config', 'claude');
  if (isDev) {
    const env = { MIDBRAIN_CONFIG_DIR: configDir };
    if (projectDir) env.MIDBRAIN_PROJECT_DIR = projectDir;
    return {
      type: 'stdio',
      command: process.execPath,
      args: [path.join(SCRIPT_DIR, 'server.js')],
      env,
    };
  }
  return toClaudeShape(buildMcpCommandSpec({ configDir, projectDir }));
}

async function installOpenCode(summary, opts = {}) {
  const { isDev = false } = opts;

  // Copy plugin files (dev contributors reference the clone; @latest users
  // get the plugin bundled inside npx's cached package on first run — but
  // the Bun plugin still needs to live in the user's OpenCode plugins dir
  // to be loaded. We always copy so the plugin is available for both modes.)
  await fs.mkdir(PATHS.opencodePlugins, { recursive: true });

  const pluginDst = path.join(PATHS.opencodePlugins, 'midbrain-memory.ts');
  const sharedDst = path.join(PATHS.opencodePlugins, 'midbrain-common.mjs');
  await fs.copyFile(path.join(SCRIPT_DIR, 'plugin', 'midbrain-memory.ts'), pluginDst);
  summary.push(`  + Plugin copied: ~/.config/opencode/plugins/midbrain-memory.ts`);
  await fs.copyFile(path.join(SCRIPT_DIR, 'shared', 'midbrain-common.mjs'), sharedDst);
  summary.push(`  + Shared lib copied: ~/.config/opencode/plugins/midbrain-common.mjs`);

  // Patch opencode config (.json or .jsonc) — preserves comments
  const opencodeConfigPath = resolveOpencodeConfig(PATHS.opencodeDir);
  const configBasename = path.basename(opencodeConfigPath);
  // readJson returns null when the file does not exist; treat that as a
  // fresh install and start from an empty object with $schema.
  const config = (await readJson(opencodeConfigPath)) || {};
  if (existsSync(opencodeConfigPath)) {
    await backup(opencodeConfigPath);
  }

  if (config.mcp && config.mcp[MCP_KEY]) {
    console.log(`[OpenCode] MCP entry already present — updating`);
    summary.push(`  ~ MCP server: updated in ${configBasename}`);
  } else {
    summary.push(`  + MCP server added to ${configBasename}`);
  }

  const modifications = [];

  // Ensure $schema on fresh configs (AC-8: I-11)
  if (!config['$schema']) {
    modifications.push({ path: ['$schema'], value: 'https://opencode.ai/config.json' });
  }

  // Remove invalid key that older OpenCode versions or other tools may have written
  if (config.mcpServers) {
    modifications.push({ path: ['mcpServers'], value: undefined });
    summary.push(`  ~ Removed invalid "mcpServers" key from ${configBasename} (OpenCode requires "mcp")`);
  }

  modifications.push({
    path: ['mcp', MCP_KEY],
    value: (function () {
      const entry = buildOpenCodeMcpEntry({ isDev });
      const existing = config.mcp && config.mcp[MCP_KEY];
      const customEnv = extractCustomEnv(existing, 'environment');
      entry.environment = { ...customEnv, ...entry.environment };
      return entry;
    })(),
  });

  await patchJsonFile(opencodeConfigPath, modifications);

  summary.push(`  -> Restart OpenCode to apply changes`);
}

// ---------------------------------------------------------------------------
// Step 5a: Claude Code — ~/.claude.json
// ---------------------------------------------------------------------------
async function installClaudeJson(summary, opts = {}) {
  const { isDev = false } = opts;
  const data = (await readJson(PATHS.claudeJson)) || {};
  await backup(PATHS.claudeJson);

  const existing = data.mcpServers && data.mcpServers[MCP_KEY];
  const customEnv = extractCustomEnv(existing, 'env');
  const entry = buildClaudeMcpEntry({ isDev });
  entry.env = { ...customEnv, ...entry.env };

  data.mcpServers = data.mcpServers || {};
  data.mcpServers[MCP_KEY] = entry;
  await writeJson(PATHS.claudeJson, data);

  if (existing) {
    summary.push(`  ~ MCP server: updated in ~/.claude.json`);
  } else {
    summary.push(`  + MCP server added to ~/.claude.json`);
  }
}

// ---------------------------------------------------------------------------
// Step 5b: Claude Code — ~/.claude/settings.json (hooks + permissions)
// ---------------------------------------------------------------------------
function buildHooks() {
  const configPrefix = `MIDBRAIN_CONFIG_DIR=${path.join(HOME, '.config', 'claude')}`;
  const userCmd  = `${configPrefix} ${process.execPath} ${path.join(SCRIPT_DIR, 'claude-code', 'capture-user.mjs')}`;
  const assistCmd = `${configPrefix} ${process.execPath} ${path.join(SCRIPT_DIR, 'claude-code', 'capture-assistant.mjs')}`;
  return {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: userCmd, timeout: 10, async: true }] }],
    Stop:             [{ hooks: [{ type: 'command', command: assistCmd, timeout: 10, async: true }] }],
  };
}

function hooksAlreadyPresent(settings) {
  const hooks = settings.hooks || {};
  const ups = hooks.UserPromptSubmit || [];
  return ups.some((entry) =>
    (entry.hooks || []).some((h) =>
      typeof h.command === 'string' && h.command.includes('capture-user.mjs')
    )
  );
}

async function installClaudeSettings(summary) {
  const settingsDir = path.dirname(PATHS.claudeSettings);
  await fs.mkdir(settingsDir, { recursive: true });

  const data = (await readJson(PATHS.claudeSettings)) || {};
  await backup(PATHS.claudeSettings);

  if (hooksAlreadyPresent(data)) {
    // Update existing hooks to use new command format
    data.hooks = buildHooks();
    summary.push(`  ~ Hooks: updated in ~/.claude/settings.json`);
  } else {
    data.hooks = buildHooks();
    summary.push(`  + Hooks added to ~/.claude/settings.json`);
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

  await writeJson(PATHS.claudeSettings, data);
}

async function installClaudeCode(summary, opts = {}) {
  // PRD-010 fresh-install: do NOT gate installClaudeJson on
  // existsSync(~/.claude.json). detectTools detects Claude via EITHER
  // ~/.claude.json OR ~/.claude/settings.json; a settings-only
  // detection previously wrote hooks + permissions but silently
  // skipped the MCP server entry. installClaudeJson handles the
  // missing-file case via `readJson() || {}` and backup() is a no-op
  // on missing source files.
  await installClaudeJson(summary, opts);
  await installClaudeSettings(summary);
  summary.push(`  -> Restart Claude Code to apply changes`);
}

// ---------------------------------------------------------------------------
// Step 6: Print summary
// ---------------------------------------------------------------------------
function printSummary(tools, keyLines, opencodeLines, claudeLines) {
  console.log('');
  console.log('MidBrain Memory MCP — Installation Complete');
  console.log('');
  keyLines.forEach((l) => console.log(l));
  console.log('');

  if (tools.opencode) {
    console.log('OpenCode:');
    opencodeLines.forEach((l) => console.log(l));
    console.log('');
  }

  if (tools.claudeCode) {
    console.log('Claude Code:');
    claudeLines.forEach((l) => console.log(l));
    console.log('');
  }

  if (!tools.opencode && !tools.claudeCode) {
    console.log('No supported AI tools detected.');
    console.log('  Install OpenCode or Claude Code, then re-run this script.');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(opts = {}) {
  const { isDev = false } = opts;
  const tools = detectTools();

  if (!tools.opencode && !tools.claudeCode) {
    console.log('No supported AI tools detected (OpenCode or Claude Code).');
    console.log('Install one of them and re-run: node install.mjs');
    process.exit(0);
  }

  // Resolve and write keys
  const keys = await resolveKeys(tools);
  const keyLines = [];
  await writeKeys(keys, keyLines);

  const opencodeLines = [];
  const claudeLines = [];

  if (tools.opencode) {
    try {
      await installOpenCode(opencodeLines, { isDev });
    } catch (err) {
      opencodeLines.push(`  ! OpenCode install error: ${err.message}`);
    }
  }

  if (tools.claudeCode) {
    try {
      await installClaudeCode(claudeLines, { isDev });
    } catch (err) {
      claudeLines.push(`  ! Claude Code install error: ${err.message}`);
    }
  }

  printSummary(tools, keyLines, opencodeLines, claudeLines);
}

// ---------------------------------------------------------------------------
// --project mode: non-interactive project setup
// ---------------------------------------------------------------------------

/** Returns last 4 chars of a key for safe logging. Never logs the full key. */
function keyFingerprint(key) {
  if (!key || key.length < 4) return '****';
  return `...${key.slice(-4)}`;
}

/**
 * Resolves an API key from existing files (no prompts).
 * Checks: project .midbrain/.midbrain-key → OpenCode key → Claude key → global → env.
 * Returns { key, source } or null.
 */
async function resolveProjectKey(projectDir) {
  // Check project-level key (subdirectory convention)
  const projectKeyPath = path.join(projectDir, '.midbrain', KEY_FILENAME);
  const projKey = await readKeyFile(projectKeyPath);
  if (projKey) return { key: projKey, source: projectKeyPath };

  // Check project-level key (flat convention)
  const flatKeyPath = path.join(projectDir, KEY_FILENAME);
  const flatKey = await readKeyFile(flatKeyPath);
  if (flatKey) return { key: flatKey, source: flatKeyPath };

  // Check client key files
  const ocKey = await readKeyFile(PATHS.opencodeKey);
  if (ocKey) return { key: ocKey, source: PATHS.opencodeKey };

  const ccKey = await readKeyFile(PATHS.claudeKey);
  if (ccKey) return { key: ccKey, source: PATHS.claudeKey };

  // Global fallback
  const globalKey = await readKeyFile(PATHS.globalKey);
  if (globalKey) return { key: globalKey, source: PATHS.globalKey };

  // Env var fallback
  if (process.env.MIDBRAIN_API_KEY) {
    const key = process.env.MIDBRAIN_API_KEY.trim();
    if (key) return { key, source: 'env:MIDBRAIN_API_KEY' };
  }

  return null;
}

/**
 * Non-interactive project setup. Creates .midbrain/.midbrain-key and
 * project-level MCP configs for each detected client.
 * Outputs JSON result to stdout; all other output to stderr.
 */
async function projectSetup(rawPath, opts = {}) {
  const { isDev = false } = opts;
  const warnings = [];
  const configsWritten = [];

  // --- Validate and resolve project path (C-12, C-13) ---
  const resolved = path.resolve(rawPath);
  let projectDir;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      console.error(`Error: "${resolved}" is not a directory.`);
      process.exit(1);
    }
    // Resolve symlinks (C-11)
    projectDir = await fs.realpath(resolved);
    if (projectDir !== resolved) {
      warnings.push(`Symlink resolved: "${resolved}" -> "${projectDir}"`);
      console.error(`[project] WARN: symlink resolved: ${resolved} -> ${projectDir}`);
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`Error: directory does not exist: "${resolved}"`);
      process.exit(1);
    }
    console.error(`Error: cannot access "${resolved}": ${err.message}`);
    process.exit(1);
  }

  console.error(`[project] dir=${projectDir}`);

  // --- Resolve API key (no prompts) ---
  const keyResult = await resolveProjectKey(projectDir);
  if (!keyResult) {
    console.error('Error: no API key found. Set up a key file first (run: node install.mjs)');
    process.exit(1);
  }
  const { key: apiKey, source: keySource } = keyResult;
  console.error(`[project] key_source=${keySource} fingerprint=${keyFingerprint(apiKey)}`);

  // --- Create .midbrain/.midbrain-key (C-9: guard existing) ---
  const keyFilePath = path.join(projectDir, '.midbrain', KEY_FILENAME);
  let keyCreated = false;
  const existingKey = await readKeyFile(keyFilePath);
  if (existingKey) {
    console.error(`[project] existing key preserved: ${keyFilePath}`);
    warnings.push(`Existing key file preserved at ${keyFilePath}`);
  } else {
    await writeKeyFile(keyFilePath, apiKey);
    keyCreated = true;
    console.error(`[project] key written: ${keyFilePath} (chmod 600)`);
  }

  // --- Detect clients and write project-level configs ---
  const tools = detectTools();

  if (tools.opencode) {
    const configPath = resolveOpencodeConfig(projectDir);
    const configBasename = path.basename(configPath);
    const config = (await readJson(configPath)) || {};

    const modifications = [];

    // Ensure $schema is present
    if (!config['$schema']) {
      modifications.push({ path: ['$schema'], value: 'https://opencode.ai/config.json' });
    }

    // Remove invalid mcpServers key (OpenCode uses "mcp")
    if (config.mcpServers) {
      modifications.push({ path: ['mcpServers'], value: undefined });
      warnings.push(`Removed invalid "mcpServers" key from ${configBasename} (OpenCode requires "mcp")`);
    }

    modifications.push({
      path: ['mcp', MCP_KEY],
      value: (function () {
        const entry = buildOpenCodeMcpEntry({ isDev, projectDir });
        const existing = config.mcp && config.mcp[MCP_KEY];
        const customEnv = extractCustomEnv(existing, 'environment');
        entry.environment = { ...customEnv, ...entry.environment };
        return entry;
      })(),
    });

    await patchJsonFile(configPath, modifications);
    configsWritten.push(configBasename);
    console.error(`[project] wrote: ${configPath}`);
  }

  if (tools.claudeCode) {
    const configPath = path.join(projectDir, '.mcp.json');
    const config = (await readJson(configPath)) || {};

    config.mcpServers = config.mcpServers || {};
    const existingMcp = config.mcpServers[MCP_KEY];
    const customMcpEnv = extractCustomEnv(existingMcp, 'env');
    const mcpEntry = buildClaudeMcpEntry({ isDev, projectDir });
    mcpEntry.env = { ...customMcpEnv, ...mcpEntry.env };
    config.mcpServers[MCP_KEY] = mcpEntry;
    await writeJson(configPath, config);
    configsWritten.push('.mcp.json');
    console.error(`[project] wrote: ${configPath}`);

    // Also patch ~/.claude.json project-local scope (PRD-009: bypass trust gate)
    const patched = await installClaudeProjectLocal(projectDir, { isDev });
    if (patched) {
      console.error(`[project] patched: ${PATHS.claudeJson} (project-local mcpServers)`);
    }
  }

  if (!tools.opencode && !tools.claudeCode) {
    warnings.push('No supported AI clients detected (OpenCode or Claude Code). No configs written.');
    console.error('[project] WARN: no clients detected');
  }

  // --- Output JSON result to stdout (C-10: stdout isolation) ---
  const result = {
    success: true,
    project_dir: projectDir,
    key_file: keyFilePath,
    key_created: keyCreated,
    key_source: keySource,
    configs_written: configsWritten,
    restart_required: true,
    warnings,
  };
  console.error('[project] Setup complete. Restart OpenCode / Claude Code for the new project memory to take effect.');
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// installClaudeProjectLocal — PRD-009: bypass Claude Code .mcp.json trust gate
// Patches ~/.claude.json project-local scope so MCP server loads immediately.
//
// Entry shape comes from buildClaudeMcpEntry (PRD-010): defaults to
// `npx -y midbrain-memory-mcp@latest`; pass `{ isDev: true }` for
// absolute-path form.
// ---------------------------------------------------------------------------
async function installClaudeProjectLocal(projectDir, opts = {}) {
  const { isDev = false } = opts;
  try {
    // Read existing ~/.claude.json (if any) to preserve custom env vars on
    // the existing midbrain project-local entry across re-runs / migrations.
    // Read is best-effort: if the file is unreadable (EACCES, corrupt JSON),
    // fall through to an empty merge. The subsequent patchJsonFile call is
    // where a real EACCES will surface and be handled below.
    let existingRoot = {};
    try {
      existingRoot = (await readJson(PATHS.claudeJson)) || {};
    } catch {
      existingRoot = {};
    }
    const existingEntry =
      existingRoot.projects &&
      existingRoot.projects[projectDir] &&
      existingRoot.projects[projectDir].mcpServers &&
      existingRoot.projects[projectDir].mcpServers[MCP_KEY];
    const customEnv = extractCustomEnv(existingEntry, 'env');
    const entry = buildClaudeMcpEntry({ isDev, projectDir });
    entry.env = { ...customEnv, ...entry.env };

    await patchJsonFile(PATHS.claudeJson, [{
      path: ['projects', projectDir, 'mcpServers', MCP_KEY],
      value: entry,
    }]);
    return true;
  } catch (err) {
    // patchJsonFile handles ENOENT internally (starts from {}), so only EACCES reaches here
    if (err.code === 'EACCES') {
      console.error(`[project] WARN: could not patch ${PATHS.claudeJson}: ${err.code}`);
      return false;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// CLI help
// ---------------------------------------------------------------------------

const HELP_TEXT = `\
MidBrain Memory MCP — installer

Usage:
  npx midbrain-memory-mcp install                            Interactive install (OpenCode/Claude Code)
  npx midbrain-memory-mcp install --project <absolute-path>  Per-project setup (non-interactive)
  npx midbrain-memory-mcp install --help                     Show this help

Development (clone-local):
  node install.mjs [--help | --project <path> | --dev]

Flags:
  --project <path>    Absolute path to the project root directory.
  --dev               Write absolute-path configs pointing at this clone.
                      (For repository contributors. Default is npx @latest,
                      which is auto-updating and portable across machines.)
  --help, -h          Show this help text.

By default, the installer writes 'npx -y midbrain-memory-mcp@latest' as the
MCP command, so every MCP client cold-start re-resolves @latest against the
npm registry. This gives non-technical users a self-updating install with
zero maintenance.
`;

function printHelp() {
  console.log(HELP_TEXT);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI entry point for the installer. Used by:
 *   - install.mjs's own isMain block (direct `node install.mjs`)
 *   - server.js's `install` subcommand dispatch (PRD-011)
 *
 * Parses argv flags (--help, -h, --project <path>, --dev) and runs the
 * matching installer flow. Writes all progress/debug to stderr.
 *
 * Exit-ownership contract: runInstallerCli OWNS all exits. On fatal
 * error, it logs to stderr and calls process.exit(1) internally. On
 * success (--help, project-mode completion, interactive completion),
 * it calls process.exit(0|1) via the underlying call paths. The
 * returned Promise therefore never rejects in practice. Callers may
 * `await runInstallerCli(...)` without a .catch block.
 *
 * @param {string[]} argv  Installer flags only (no node/script path).
 *   Equivalent to process.argv.slice(2) when called directly, or
 *   process.argv.slice(3) when dispatched from `server.js install`.
 * @returns {Promise<void>}  Resolves only after process.exit in
 *   practice the process terminates inside this function.
 */
async function runInstallerCli(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  const isDev = argv.includes('--dev');
  const projectFlagIdx = argv.indexOf('--project');
  if (projectFlagIdx !== -1) {
    const projectArg = argv[projectFlagIdx + 1];
    if (!projectArg || projectArg.startsWith('-')) {
      console.error('Error: --project requires a path argument.');
      console.error('Usage: node install.mjs --project /absolute/path/to/project');
      process.exit(1);
    }
    if (projectArg.trim() === '') {
      console.error('Error: --project path cannot be empty.');
      process.exit(1);
    }
    try {
      await projectSetup(projectArg, { isDev });
    } catch (err) {
      console.error(`Fatal error: ${err.message}`);
      process.exit(1);
    }
  } else {
    try {
      await main({ isDev });
    } catch (err) {
      console.error('Fatal error:', err.message);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Exports (for testability — no behaviour change when run as CLI)
// ---------------------------------------------------------------------------
export {
  readJson,
  writeJson,
  patchJsonFile,
  resolveOpencodeConfig,
  detectTools,
  projectSetup,
  installOpenCode,
  installClaudeJson,
  installClaudeSettings,
  installClaudeCode,
  installClaudeProjectLocal,
  buildOpenCodeMcpEntry,
  buildClaudeMcpEntry,
  main,
  printHelp,
  runInstallerCli,
  PATHS,
  MCP_KEY,
};

// ---------------------------------------------------------------------------
// Dispatch: --project mode vs interactive (only when run directly)
// ---------------------------------------------------------------------------
import { realpathSync } from 'fs';
const isMain = process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  await runInstallerCli(process.argv.slice(2));
}
