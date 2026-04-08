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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_DIR = __dirname; // install.mjs lives at repo root

const REPO_ROOT = process.cwd();
const HOME = os.homedir();

const KEY_FILENAME = '.midbrain-key';
const MCP_KEY = 'midbrain-memory';
const PERM_KEYS = [
  'mcp__midbrain-memory__memory_search',
  'mcp__midbrain-memory__memory_setup_project',
];

const PATHS = {
  globalKey:        path.join(HOME, '.config', 'midbrain', KEY_FILENAME),
  opencodeKey:      path.join(HOME, '.config', 'opencode', KEY_FILENAME),
  opencodeConfig:   path.join(HOME, '.config', 'opencode', 'opencode.json'),
  opencodePlugins:  path.join(HOME, '.config', 'opencode', 'plugins'),
  claudeKey:        path.join(HOME, '.config', 'claude', KEY_FILENAME),
  claudeJson:       path.join(HOME, '.claude.json'),
  claudeSettings:   path.join(HOME, '.claude', 'settings.json'),
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Read and JSON-parse a file. Returns null if file does not exist. */
async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }
}

/** Write object as formatted JSON (creates dirs if needed). */
async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
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
  return {
    opencode: existsSync(PATHS.opencodeConfig),
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
async function installOpenCode(summary) {
  // Copy plugin files
  await fs.mkdir(PATHS.opencodePlugins, { recursive: true });

  const pluginDst = path.join(PATHS.opencodePlugins, 'midbrain-memory.ts');
  const sharedDst = path.join(PATHS.opencodePlugins, 'midbrain-common.mjs');
  await fs.copyFile(path.join(REPO_ROOT, 'plugin', 'midbrain-memory.ts'), pluginDst);
  summary.push(`  + Plugin copied: ~/.config/opencode/plugins/midbrain-memory.ts`);
  await fs.copyFile(path.join(REPO_ROOT, 'shared', 'midbrain-common.mjs'), sharedDst);
  summary.push(`  + Shared lib copied: ~/.config/opencode/plugins/midbrain-common.mjs`);

  // Patch opencode.json
  const config = await readJson(PATHS.opencodeConfig);
  if (!config) throw new Error(`Cannot read ${PATHS.opencodeConfig}`);
  await backup(PATHS.opencodeConfig);

  if (config.mcp && config.mcp[MCP_KEY]) {
    console.log('[OpenCode] MCP entry already present — updating');
    summary.push(`  ~ MCP server: updated in opencode.json`);
  } else {
    summary.push(`  + MCP server added to opencode.json`);
  }

  // Remove invalid key that older OpenCode versions or other tools may have written
  if (config.mcpServers) {
    delete config.mcpServers;
    summary.push(`  ~ Removed invalid "mcpServers" key from opencode.json (OpenCode requires "mcp")`);
  }

  config.mcp = config.mcp || {};
  config.mcp[MCP_KEY] = {
    type: 'local',
    command: [process.execPath, path.join(REPO_ROOT, 'server.js')],
    environment: {
      MIDBRAIN_CONFIG_DIR: path.join(HOME, '.config', 'opencode'),
    },
    enabled: true,
  };
  await writeJson(PATHS.opencodeConfig, config);

  summary.push(`  -> Restart OpenCode to apply changes`);
}

// ---------------------------------------------------------------------------
// Step 5a: Claude Code — ~/.claude.json
// ---------------------------------------------------------------------------
async function installClaudeJson(summary) {
  const data = (await readJson(PATHS.claudeJson)) || {};
  await backup(PATHS.claudeJson);

  const existed = data.mcpServers && data.mcpServers[MCP_KEY];
  data.mcpServers = data.mcpServers || {};
  data.mcpServers[MCP_KEY] = {
    type: 'stdio',
    command: process.execPath,
    args: [path.join(REPO_ROOT, 'server.js')],
    env: {
      MIDBRAIN_CONFIG_DIR: path.join(HOME, '.config', 'claude'),
    },
  };
  await writeJson(PATHS.claudeJson, data);

  if (existed) {
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
  const userCmd  = `${configPrefix} ${process.execPath} ${path.join(REPO_ROOT, 'claude-code', 'capture-user.mjs')}`;
  const assistCmd = `${configPrefix} ${process.execPath} ${path.join(REPO_ROOT, 'claude-code', 'capture-assistant.mjs')}`;
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

async function installClaudeCode(summary) {
  if (existsSync(PATHS.claudeJson)) {
    await installClaudeJson(summary);
  }
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
async function main() {
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
      await installOpenCode(opencodeLines);
    } catch (err) {
      opencodeLines.push(`  ! OpenCode install error: ${err.message}`);
    }
  }

  if (tools.claudeCode) {
    try {
      await installClaudeCode(claudeLines);
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
async function projectSetup(rawPath) {
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
  const serverPath = path.join(SCRIPT_DIR, 'server.js'); // C-7: import.meta.url
  const nodePath = process.execPath; // C-3: absolute node path

  if (tools.opencode) {
    const configPath = path.join(projectDir, 'opencode.json');
    const config = (await readJson(configPath)) || {};

    // Ensure $schema is present
    if (!config['$schema']) {
      config['$schema'] = 'https://opencode.ai/config.json';
    }

    // Remove invalid mcpServers key (OpenCode uses "mcp")
    if (config.mcpServers) {
      delete config.mcpServers;
      warnings.push('Removed invalid "mcpServers" key from opencode.json (OpenCode requires "mcp")');
    }

    config.mcp = config.mcp || {};
    config.mcp[MCP_KEY] = {
      type: 'local',
      command: [nodePath, serverPath],
      environment: {
        MIDBRAIN_CONFIG_DIR: path.join(HOME, '.config', 'opencode'),
        MIDBRAIN_PROJECT_DIR: projectDir,
      },
      enabled: true,
    };
    await writeJson(configPath, config);
    configsWritten.push('opencode.json');
    console.error(`[project] wrote: ${configPath}`);
  }

  if (tools.claudeCode) {
    const configPath = path.join(projectDir, '.mcp.json');
    const config = (await readJson(configPath)) || {};

    config.mcpServers = config.mcpServers || {};
    config.mcpServers[MCP_KEY] = {
      command: nodePath,
      args: [serverPath],
      env: {
        MIDBRAIN_CONFIG_DIR: path.join(HOME, '.config', 'claude'),
        MIDBRAIN_PROJECT_DIR: projectDir,
      },
    };
    await writeJson(configPath, config);
    configsWritten.push('.mcp.json');
    console.error(`[project] wrote: ${configPath}`);
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
  // eslint-disable-next-line no-console -- intentional: only JSON goes to stdout in --project mode
  console.log(JSON.stringify(result, null, 2));
}

// ---------------------------------------------------------------------------
// Dispatch: --project mode vs interactive
// ---------------------------------------------------------------------------
const projectFlagIdx = process.argv.indexOf('--project');
if (projectFlagIdx !== -1) {
  // C-12: validate arg
  const projectArg = process.argv[projectFlagIdx + 1];
  if (!projectArg || projectArg.startsWith('-')) {
    console.error('Error: --project requires a path argument.');
    console.error('Usage: node install.mjs --project /absolute/path/to/project');
    process.exit(1);
  }
  if (projectArg.trim() === '') {
    console.error('Error: --project path cannot be empty.');
    process.exit(1);
  }
  projectSetup(projectArg).catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}
