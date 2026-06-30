#!/usr/bin/env node
/**
 * install.mjs — MidBrain Memory MCP automated installer
 *
 * Interactive: node install.mjs
 * Project:     node install.mjs --project /absolute/path/to/project
 *
 * Detects installed AI clients via the client registry, resolves API keys,
 * writes global key file, and delegates config setup to client adapters.
 * Idempotent.
 *
 * --project mode is non-interactive: copies global key into the project,
 * writes project-level MCP configs, outputs JSON to stdout.
 *
 * Architecture: All client-specific logic lives in shared/clients/*.mjs.
 * This file only orchestrates detection, key resolution, and delegation.
 * Adding a new client requires zero changes here.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { detectClients, allClients, getClient } from './shared/clients/registry.mjs';
import { writeProjectRules } from './shared/agent-rules.mjs';
import { deviceCodeLogin } from './shared/device-auth.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Package version ---

const _require = createRequire(import.meta.url);
let PKG_VERSION = 'unknown';
try {
  const pkg = _require('./package.json');
  if (pkg && typeof pkg.version === 'string' && pkg.version) PKG_VERSION = pkg.version;
} catch { /* swallow */ }

export { PKG_VERSION };

// --- Update check + hook freshness ---

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/midbrain-memory-mcp/latest';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CACHE_FILENAME = '.midbrain-update-check.json';
const UPDATE_FETCH_TIMEOUT_MS = 5000;
const NPX_CACHE_MARKER = '/_npx/';

export function isNewerVersion(current, latest) {
  if (!current || !latest) return false;
  const c = current.split('.').map((s) => parseInt(s, 10));
  const l = latest.split('.').map((s) => parseInt(s, 10));
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

async function isUpdateCacheFresh(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const cache = JSON.parse(raw);
    return (Date.now() - cache.lastCheck) < UPDATE_CHECK_INTERVAL_MS;
  } catch { return false; }
}

/**
 * Detect and repair stale hooks/plugins for all installed clients.
 * Fire-and-forget: never throws, logs repairs to stderr.
 */
async function ensureHooksFresh() {
  const { detectClients } = await import('./shared/clients/registry.mjs');
  const clients = detectClients();
  for (const client of clients) {
    try {
      if (typeof client.isFresh !== 'function') continue;
      if (await client.isFresh()) continue;

      // Client has stale hooks/plugins — repair
      let lines = [];
      if (typeof client.repairHooks === 'function') {
        lines = await client.repairHooks();
      } else if (typeof client.repairPlugins === 'function') {
        lines = await client.repairPlugins();
      } else if (typeof client.repairSkill === 'function') {
        lines = await client.repairSkill();
      }
      for (const line of lines) console.error(`[midbrain]${line}`);
    } catch { /* never crash — skip this client */ }
  }
}

/**
 * Combined startup check: repair stale hooks, then check for npm updates.
 * Fire-and-forget: called from index.js after server.connect(), never throws.
 */
export async function checkForUpdate() {
  try {
    // Phase 1: Hook/plugin freshness (always, local I/O only)
    await ensureHooksFresh();

    // Phase 2: npm version notification (throttled, skip for npx users)
    if (__dirname.includes(NPX_CACHE_MARKER)) return;
    const cachePath = path.join(os.tmpdir(), UPDATE_CACHE_FILENAME);
    if (await isUpdateCacheFresh(cachePath)) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
      if (!response.ok) return;
      const { version: latestVersion } = await response.json();
      await fs.writeFile(cachePath, JSON.stringify({ lastCheck: Date.now(), latestVersion }), 'utf8').catch(() => {});
      if (isNewerVersion(PKG_VERSION, latestVersion)) {
        console.error(`[midbrain] Update available: ${PKG_VERSION} -> ${latestVersion}. Run: npm update -g midbrain-memory-mcp`);
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch { /* never crash */ }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Step 1: Key resolution — ask each client, prompt if missing
// ---------------------------------------------------------------------------

/**
 * Resolves keys for all detected clients. When no key is found and running
 * interactively, offers device-code login (browser-based) or manual key paste.
 *
 * In non-interactive mode (explicit flag or no TTY), skips prompts — uses
 * existing key files or env var only.
 *
 * @param {object[]} clients - Detected client instances.
 * @param {object} [opts]
 * @param {boolean} [opts.nonInteractive] - Skip all prompts.
 * @param {boolean} [opts.forceLogin] - Force device-code flow even if a key exists.
 * @param {boolean} [opts.noLogin] - Skip browser/device auth and use manual key entry.
 * @returns {Promise<{keys: Map<string, string>, perClient: boolean}>}
 *   keys: Map<clientId, string>.
 *   perClient: true when the interactive user wants a distinct per-client key
 *   written (or distinct keys already exist on disk); false for a single shared
 *   key that only needs the global key file.
 */
async function resolveKeys(clients, { nonInteractive = false, forceLogin = false, noLogin = false } = {}) {
  const interactive = !nonInteractive && process.stdin.isTTY;
  const keys = new Map();

  // Check if any client already has a key
  let anyKeyFound = false;
  for (const client of clients) {
    const existing = await client.resolveKey();
    if (existing) {
      console.log(`Found ${client.displayName} key: ${existing.source}`);
      keys.set(client.id, existing.key);
      anyKeyFound = true;
    }
  }

  // If --login flag is set and running interactively, force device-code flow.
  // A single freshly-issued key is shared across clients; ask whether to keep
  // it shared (global key only) or split into per-client keys.
  if (forceLogin && !noLogin && interactive) {
    const result = await deviceCodeLogin();
    return await distributeSharedKey(clients, result.apiKey, { interactive });
  }

  // If all clients already have keys on disk, honor them. Distinct values mean
  // the interactive user deliberately set per-client keys; identical values can
  // stay global. Non-interactive installs never write per-client key files.
  if (keys.size === clients.length) {
    return { keys, perClient: interactive && hasDistinctKeys(keys) };
  }

  // Fresh interactive install (no key found anywhere). Obtain a single key —
  // via browser login or a manual paste — then ask whether to share it across
  // all detected clients. This keeps every auth entry point consistent: one
  // key, one share decision.
  if (interactive && !anyKeyFound) {
    // --no-login skips the browser option but still uses the single-key +
    // share flow rather than prompting separately for every client.
    if (noLogin) {
      const key = await promptForKey();
      return await distributeSharedKey(clients, key, { interactive });
    }

    console.log('');
    console.log('No API key found. How would you like to authenticate?');
    console.log('  [1] Log in via browser (recommended)');
    console.log('  [2] Paste an existing API key');
    console.log('');
    const choice = await prompt('Select (1-2): ');

    if (choice === '1') {
      try {
        const result = await deviceCodeLogin();
        return await distributeSharedKey(clients, result.apiKey, { interactive });
      } catch (err) {
        console.error(`Device login failed: ${err.message}`);
        console.error('Falling back to manual key entry.');
        console.error('');
      }
    }

    // Choice [2], a blank choice, or a failed login: paste a single key.
    const key = await promptForKey();
    return await distributeSharedKey(clients, key, { interactive });
  }

  // Partial fill: some clients already have keys on disk, others don't.
  // Prompt only for the missing ones (or warn in non-interactive mode).
  for (const client of clients) {
    if (keys.has(client.id)) continue;

    if (interactive) {
      const key = await promptForKey(`Enter MidBrain API key for ${client.displayName}: `);
      keys.set(client.id, key);
    } else {
      console.error(`WARN: no key found for ${client.displayName} (non-interactive mode, skipping)`);
    }
  }

  return { keys, perClient: hasDistinctKeys(keys) };
}

/** Prompt for a single API key, rejecting empty input. */
async function promptForKey(label = 'Enter MidBrain API key: ') {
  const key = await prompt(label);
  if (!key) throw new Error('MidBrain API key is required. Aborting.');
  return key;
}

/** True if the map holds more than one distinct key value. */
function hasDistinctKeys(keys) {
  return new Set(keys.values()).size > 1;
}

/**
 * Given a single shared key (from device login or a single paste), decide
 * whether to keep it shared across all clients (global key only) or to prompt
 * for a distinct key per detected client.
 *
 * @returns {Promise<{keys: Map<string, string>, perClient: boolean}>}
 */
async function distributeSharedKey(clients, sharedKey, { interactive }) {
  const keys = new Map();

  // Non-interactive or a single client: nothing to split — share the key.
  if (!interactive || clients.length < 2) {
    for (const client of clients) keys.set(client.id, sharedKey);
    return { keys, perClient: false };
  }

  const names = clients.map((c) => c.displayName).join(', ');
  const answer = await prompt(
    `Use the same key for all detected clients (${names})? [Y/n] `
  );

  // Default (empty) and anything other than an explicit "n" means: share it.
  if (answer.toLowerCase() !== 'n') {
    for (const client of clients) keys.set(client.id, sharedKey);
    return { keys, perClient: false };
  }

  // User opted out — prompt for a distinct key per client.
  for (const client of clients) {
    const key = await promptForKey(`Enter MidBrain API key for ${client.displayName}: `);
    keys.set(client.id, key);
  }
  return { keys, perClient: true };
}

// ---------------------------------------------------------------------------
// Rules helpers
// ---------------------------------------------------------------------------

/** Convert writeProjectRules() results to human-readable status lines. */
function formatRulesLines(results) {
  return results.map(({ action, path: filePath, error }) => {
    const name = path.basename(filePath);
    if (action === 'created') return `Rules written: ${name}`;
    if (action === 'updated') return `Rules updated: ${name}`;
    if (action === 'skipped') return `Rules already current: ${name}`;
    return `Rules error (${error?.code || error?.message || 'unknown'}): ${name}`;
  });
}

// ---------------------------------------------------------------------------
// Step 2: Print summary
// ---------------------------------------------------------------------------
function printSummary(keyLines, clientSummaries) {
  console.log('');
  console.log('MidBrain Memory MCP — Installation Complete');
  console.log('');
  keyLines.forEach((l) => console.log(l));
  console.log('');

  for (const [displayName, lines] of clientSummaries) {
    console.log(`${displayName}:`);
    lines.forEach((l) => console.log(l));
    console.log('');
  }

  if (clientSummaries.size === 0) {
    console.log('No supported AI tools detected.');
    console.log('  Install a supported client, then re-run this script.');
  }
}

// ---------------------------------------------------------------------------
// Rules prompt helper for global main() flow
// ---------------------------------------------------------------------------

const PROJECT_MARKERS = ['.git', 'package.json', 'opencode.json', 'opencode.jsonc'];

/**
 * Write or prompt for MidBrain rules in the user's CWD.
 * process.cwd() is the user's intended project root when running the global
 * interactive installer — it is not derived from user-controlled input.
 */
async function writeRulesForMainMode(nonInteractive) {
  // Justified use of process.cwd(): this is the global installer; the user
  // runs it from their project root. CWD is the natural target.
  const cwd = process.cwd();
  const isProject = PROJECT_MARKERS.some((m) => existsSync(path.join(cwd, m)));

  if (!isProject) {
    console.log('Note: to add MidBrain memory rules to a project\'s instruction files, run:');
    console.log('  npx midbrain-memory-mcp install --project <absolute-path>');
    return;
  }

  const interactive = !nonInteractive && process.stdin.isTTY;
  if (interactive) {
    const answer = await prompt(
      `MidBrain memory rules will be added to:\n  AGENTS.md\n  CLAUDE.md\nin ${cwd}. Proceed? [Y/n] `
    );
    if (answer.toLowerCase() === 'n') {
      console.log('Skipped. Add rules manually — see README §Memory-First Agent Rules.');
      return;
    }
  }

  const results = await writeProjectRules(cwd);
  const lines = formatRulesLines(results);
  if (interactive) {
    lines.forEach((l) => console.log(l));
  } else {
    lines.forEach((l) => console.error(`[midbrain] ${l}`));
  }
}

// ---------------------------------------------------------------------------
// Main (interactive mode)
// ---------------------------------------------------------------------------
async function main(opts = {}) {
  const { isDev = false, nonInteractive = false, skipRules = false, forceLogin = false, noLogin = false } = opts;
  const clients = detectClients();

  if (clients.length === 0) {
    console.log('No supported AI tools detected.');
    console.log('Install a supported client and re-run: node install.mjs');
    process.exit(0);
  }

  // Resolve and write keys
  const { keys, perClient } = await resolveKeys(clients, { nonInteractive, forceLogin, noLogin });
  if (keys.size === 0) {
    throw new Error("No API key found. Run the installer interactively first or set MIDBRAIN_API_KEY.");
  }
  const keyLines = [];

  // The global key is always written and is the single source of truth for the
  // shared-key case. Use the first detected client's key as the global value.
  const primaryKey = keys.values().next().value;
  keyLines.push(await getClient('generic').writeKey(primaryKey));

  // Per-client key files are only written when the user opted into distinct
  // keys (or distinct keys already existed). Otherwise the global key alone
  // serves every client via the resolution chain.
  if (perClient) {
    for (const client of clients) {
      const key = keys.get(client.id);
      if (key) keyLines.push(await client.writeKey(key));
    }
  }

  // Install each detected client
  const clientSummaries = new Map();
  for (const client of clients) {
    try {
      const lines = await client.installGlobal({ isDev });
      clientSummaries.set(client.displayName, lines);
    } catch (err) {
      clientSummaries.set(client.displayName, [`  ! Install error: ${err.message}`]);
    }
  }

  printSummary(keyLines, clientSummaries);

  if (!skipRules) {
    await writeRulesForMainMode(nonInteractive);
  }
}

// ---------------------------------------------------------------------------
// Project setup (shared core — used by both CLI and MCP tool)
// ---------------------------------------------------------------------------

/**
 * Core project setup logic. Validates the path, ensures the project has a
 * key file, and writes client-level MCP configs for all detected clients.
 *
 * Throws on fatal errors (caller decides how to surface them).
 *
 * @param {string} rawPath - Project path (will be resolved + validated).
 * @param {{apiKey?: string, isDev?: boolean}} [opts]
 * @returns {Promise<{lines: string[], keyCreated: boolean, configsWritten: string[], projectDir: string}>}
 */
async function setupProject(rawPath, opts = {}) {
  const { apiKey: apiKeyParam, isDev = false, skipRules = false } = opts;
  const lines = [];
  const configsWritten = [];

  // --- Validate and resolve path ---
  if (!path.isAbsolute(rawPath)) {
    throw new Error(`project_dir must be an absolute path. Got: "${rawPath}"`);
  }
  const resolved = path.resolve(rawPath);
  let projectDir;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`"${resolved}" is not a directory.`);
    }
    projectDir = await fs.realpath(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`Directory does not exist: "${resolved}"`, { cause: err });
    if (err.message.includes('is not a directory')) throw err;
    throw new Error(`Cannot access "${resolved}": ${err.message}`, { cause: err });
  }

  // --- Resolve key ---
  const generic = getClient('generic');
  let apiKey;
  if (apiKeyParam) {
    apiKey = apiKeyParam.trim();
  } else {
    const client = getClient(process.env.MIDBRAIN_CLIENT);
    const result = await client.resolveKey(projectDir);
    if (!result) {
      throw new Error("No API key found. Run the installer first (npx midbrain-memory-mcp install).");
    }
    apiKey = result.key;
    lines.push(`Key resolved from: ${result.source}`);
  }

  // --- Ensure project has its own key file ---
  let keyCreated = false;
  const existingProjectKey = await generic.getProjectKey(projectDir);
  if (existingProjectKey) {
    lines.push("Existing project key preserved.");
  } else {
    const keyPath = await generic.setProjectKey(projectDir, apiKey);
    keyCreated = true;
    lines.push(`Key file created: ${keyPath} (chmod 600)`);
  }

  // --- Write client configs ---
  const clients = detectClients();

  for (const client of clients) {
    try {
      const clientLines = await client.installProject(projectDir, { isDev });
      lines.push(...clientLines);
      configsWritten.push(...client.projectConfigFiles(projectDir));
    } catch (err) {
      lines.push(`Error (${client.displayName}): ${err.message}`);
    }
  }

  if (clients.length === 0) {
    lines.push("Warning: no supported AI clients detected. No configs written.");
  }

  let rulesWritten = [];
  if (!skipRules) {
    const rulesResults = await writeProjectRules(projectDir);
    lines.push(...formatRulesLines(rulesResults));
    rulesWritten = rulesResults
      .filter((r) => r.action === 'created' || r.action === 'updated')
      .map((r) => r.path);
  }

  return { lines, keyCreated, configsWritten, projectDir, rulesWritten };
}

// ---------------------------------------------------------------------------
// CLI wrapper for --project mode
// ---------------------------------------------------------------------------

async function projectSetup(rawPath, opts = {}) {
  try {
    const result = await setupProject(rawPath, opts);
    console.error('[project] Setup complete. Restart your AI client for the new project memory to take effect.');
    console.log(JSON.stringify({
      success: true,
      project_dir: result.projectDir,
      key_created: result.keyCreated,
      configs_written: result.configsWritten,
      rules_written: result.rulesWritten,
      restart_required: true,
    }, null, 2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI help
// ---------------------------------------------------------------------------

const HELP_TEXT = `\
MidBrain Memory MCP — installer

Usage:
  npx midbrain-memory-mcp install                            Interactive install
  npx midbrain-memory-mcp install --login                    Force browser-based login
  npx midbrain-memory-mcp install --project <absolute-path>  Per-project setup (non-interactive)
  npx midbrain-memory-mcp install --non-interactive           Non-interactive install (uses existing keys/env)
  npx midbrain-memory-mcp install --help                     Show this help

Development (clone-local):
  node install.mjs [--help | --project <path> | --dev | --non-interactive | --no-rules]

Flags:
  --login             Authenticate via browser (opens your default browser).
                      Creates an agent and API key automatically. This is the
                      default when no existing API key is found.
  --no-login          Skip browser-based auth. Only use existing key files,
                      env var, or manual paste.
  --project <path>    Absolute path to the project root directory.
  --dev               Write absolute-path configs pointing at this clone.
                      (For repository contributors. Default is npx @latest,
                      which is auto-updating and portable across machines.)
  --non-interactive   Skip all prompts. Uses existing key files or
                      MIDBRAIN_API_KEY env var. Useful for Docker entrypoints
                      and CI environments.
  --no-rules          Skip writing MidBrain memory rules to AGENTS.md and
                      CLAUDE.md. Use when managing instruction files manually.
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
 *   - index.js's `install` subcommand dispatch (PRD-011)
 *
 * Parses argv flags (--help, -h, --project <path>, --dev) and runs the
 * matching installer flow. Writes all progress/debug to stderr.
 *
 * @param {string[]} argv  Installer flags only (no node/script path).
 * @returns {Promise<void>}
 */
async function runInstallerCli(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  const isDev = argv.includes('--dev');
  const nonInteractive = argv.includes('--non-interactive');
  const skipRules = argv.includes('--no-rules');
  const forceLogin = argv.includes('--login');
  const noLogin = argv.includes('--no-login');
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
      await projectSetup(projectArg, { isDev, skipRules });
    } catch (err) {
      console.error(`Fatal error: ${err.message}`);
      process.exit(1);
    }
  } else {
    try {
      await main({ isDev, nonInteractive, skipRules, forceLogin, noLogin });
    } catch (err) {
      console.error('Fatal error:', err.message);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Exports (for testability)
// ---------------------------------------------------------------------------
export {
  main,
  setupProject,
  projectSetup,
  runInstallerCli,
  printHelp,
  // Re-exports from registry for test convenience
  detectClients,
  allClients,
  getClient,
};

// ---------------------------------------------------------------------------
// Dispatch: --project mode vs interactive (only when run directly)
// ---------------------------------------------------------------------------
import { realpathSync, existsSync } from 'fs';
const isMain = process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  await runInstallerCli(process.argv.slice(2));
}
