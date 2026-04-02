/**
 * install.mjs — MidBrain Memory MCP automated installer
 *
 * Run: node install.mjs
 *
 * Detects OpenCode and/or Claude Code, asks for API key(s), writes per-client
 * key files (chmod 600), patches configs, copies plugin files. Idempotent.
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REPO_ROOT = process.cwd();
const HOME = os.homedir();

const KEY_FILENAME = '.midbrain-key';
const MCP_KEY = 'midbrain-memory';
const PERM_KEY = 'mcp__midbrain-memory__memory_search';

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
  if (!data.permissions.allow.includes(PERM_KEY)) {
    data.permissions.allow.push(PERM_KEY);
    summary.push(`  + Permission added: ${PERM_KEY}`);
  } else {
    summary.push(`  - Permission: already present (skipped)`);
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

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
