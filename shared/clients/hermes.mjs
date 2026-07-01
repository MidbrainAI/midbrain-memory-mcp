/**
 * Hermes Agent client adapter.
 *
 * Hermes Agent (Nous Research) stores its config as YAML at
 * ~/.hermes/config.yaml. This adapter handles:
 * - mcp_servers.midbrain-memory (MCP search entry)
 * - hooks.pre_llm_call / hooks.post_llm_call (episodic capture)
 * - ~/.config/hermes/.midbrain-key (per-client key)
 * - <project>/.hermes/config.yaml MCP scoping via MIDBRAIN_PROJECT_DIR
 *
 * Capture uses Hermes' shell-hooks system (fires in CLI + gateway), driven by
 * the stable ~/.midbrain/bin/hermes-hook shim so the allowlisted command
 * string survives package/Node updates (mirrors the Codex shim).
 *
 * YAML is edited through the `yaml` document API so comments and key order on
 * untouched nodes survive. Parsing failures fail closed (no write), matching
 * the Codex TOML adapter.
 */

import { BaseClient, readKeyFile } from './base.mjs';
import {
  KEY_FILENAME, MCP_KEY, PKG_NAME, REPO_ROOT,
  home, backup, writeSecure, extractCustomEnv, PINNED_RE,
} from './utils.mjs';

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const HOOK_TIMEOUT_SEC = 10;
// Hermes lifecycle events -> midbrain capture roles.
const HOOK_EVENTS = {
  pre_llm_call: 'user',
  post_llm_call: 'assistant',
};
const LEGACY_HOOK_SCRIPTS = ['capture-user.mjs', 'capture-assistant.mjs'];

let yamlModule;

function hermesHome() { return process.env.HERMES_HOME || path.join(home(), '.hermes'); }
function configPath() { return path.join(hermesHome(), 'config.yaml'); }
function stableHookPath() { return path.join(home(), '.midbrain', 'bin', 'hermes-hook'); }
function cfgDir() { return path.join(home(), '.config', 'hermes'); }
function keyFilePath() { return path.join(cfgDir(), KEY_FILENAME); }

async function loadYaml() {
  yamlModule ||= await import('yaml');
  return yamlModule;
}

/**
 * Parse a YAML file into a `yaml` Document (comment/order preserving).
 * Missing file -> empty Document. Unparseable -> throw (fail closed).
 */
async function readYamlDoc(filePath) {
  const YAML = await loadYaml();
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return new YAML.Document({});
    throw err;
  }
  const doc = YAML.parseDocument(raw);
  if (doc.errors && doc.errors.length > 0) {
    throw new Error(`Failed to parse ${filePath}: ${doc.errors[0].message}`);
  }
  // Normalize a null/empty document to an empty map so .setIn works.
  if (doc.contents === null) doc.contents = new YAML.YAMLMap();
  return doc;
}

async function writeYamlDoc(filePath, doc) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // lineWidth: 0 disables line folding so long hook command strings stay on
  // one line (valid either way, but cleaner and easier to diff/audit).
  await fs.writeFile(filePath, doc.toString({ lineWidth: 0 }), 'utf8');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildHookCommand(role) {
  return `${shellQuote(stableHookPath())} hermes ${role}`;
}

function shimBody() {
  return `#!/bin/sh
set +e
npx -y midbrain-memory-mcp@latest hook hermes "$@"
exit 0
`;
}

async function installStableHookShim() {
  const shim = stableHookPath();
  await fs.mkdir(path.dirname(shim), { recursive: true });
  await fs.writeFile(shim, shimBody(), 'utf8');
  await fs.chmod(shim, 0o755);
}

/** Build the mcp_servers.midbrain-memory entry (plain object). */
function buildMcpEntry({ isDev = false, projectDir, extraEnv = {} } = {}) {
  const env = { ...extraEnv, MIDBRAIN_CLIENT: 'hermes' };
  if (projectDir) env.MIDBRAIN_PROJECT_DIR = projectDir;
  if (isDev) {
    return { command: process.execPath, args: [path.join(REPO_ROOT, 'index.js')], env };
  }
  return { command: 'npx', args: ['-y', 'midbrain-memory-mcp@latest'], env };
}

/** True when an existing MCP entry pins a specific package version. */
function mcpEntryPinned(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const cmd = Array.isArray(entry.command) ? entry.command : [entry.command];
  const args = Array.isArray(entry.args) ? entry.args : [];
  return [...cmd, ...args].some((v) => typeof v === 'string' && PINNED_RE.test(v));
}

/** Detect whether a hooks command string belongs to midbrain. */
function isMidbrainHookCommand(command) {
  if (typeof command !== 'string') return false;
  const normalized = command.replace(/['"]/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized.includes(stableHookPath()) ||
    normalized.includes('/.midbrain/bin/hermes-hook') ||
    LEGACY_HOOK_SCRIPTS.some((script) => command.includes(script)) ||
    (normalized.includes(PKG_NAME) && /\bhook\s+hermes\b/.test(normalized));
}

/**
 * Rewrite the mcp_servers.midbrain-memory node in-place on a Document.
 * Preserves a pinned entry and any custom env keys. Returns status.
 */
function patchMcpEntry(doc, opts) {
  const existing = doc.getIn(['mcp_servers', MCP_KEY]);
  const existingJs = existing && typeof existing.toJSON === 'function' ? existing.toJSON() : existing;
  const exists = existingJs != null;
  const pinned = mcpEntryPinned(existingJs);
  if (!pinned) {
    const extraEnv = extractCustomEnv(existingJs, 'env');
    doc.setIn(['mcp_servers', MCP_KEY], buildMcpEntry({ ...opts, extraEnv }));
  }
  return { exists, pinned };
}

/**
 * Rewrite hooks.pre_llm_call / hooks.post_llm_call so midbrain has exactly one
 * entry per event, preserving any non-midbrain hooks the user configured.
 */
async function patchHooks(doc) {
  const YAML = await loadYaml();
  for (const [event, role] of Object.entries(HOOK_EVENTS)) {
    const currentNode = doc.getIn(['hooks', event]);
    const current = currentNode && typeof currentNode.toJSON === 'function'
      ? currentNode.toJSON()
      : currentNode;
    const kept = Array.isArray(current)
      ? current.filter((entry) => !isMidbrainHookCommand(entry && entry.command))
      : [];
    const next = [...kept, { command: buildHookCommand(role), timeout: HOOK_TIMEOUT_SEC }];
    doc.setIn(['hooks', event], doc.createNode(next));
  }
  // Silence the interactive first-use consent prompt is NOT auto-set here;
  // hooks_auto_accept is a security-sensitive global toggle the user owns.
  return YAML;
}

function formatLine(label, exists, pinned) {
  if (pinned) return `${label}: midbrain-memory pinned version preserved (no change)`;
  return exists ? `${label}: midbrain-memory updated` : `${label}: midbrain-memory entry added`;
}

export class Hermes extends BaseClient {
  get id() { return 'hermes'; }
  get displayName() { return 'Hermes Agent'; }

  isInstalled() {
    return existsSync(configPath()) || existsSync(hermesHome());
  }

  async resolveClientKey() {
    const source = keyFilePath();
    const key = await readKeyFile(source);
    return key ? { key, source } : null;
  }

  async writeKey(key) {
    const kfp = keyFilePath();
    await writeSecure(kfp, key);
    return `Key: ~/.config/hermes/${KEY_FILENAME} (chmod 600)`;
  }

  async installGlobal(opts = {}) {
    const isDev = opts.isDev === true;
    const summary = [];
    const cfp = configPath();

    const doc = await readYamlDoc(cfp);
    const { exists, pinned } = patchMcpEntry(doc, { isDev });
    await patchHooks(doc);

    await installStableHookShim();
    await backup(cfp);
    await writeYamlDoc(cfp, doc);

    summary.push(formatLine('~/.hermes/config.yaml', exists, pinned));
    summary.push('~/.hermes/config.yaml: MidBrain capture hooks written (pre_llm_call, post_llm_call)');
    summary.push('~/.midbrain/bin/hermes-hook: stable Hermes hook shim written');
    summary.push('  -> Restart Hermes (new session / gateway restart) to load the MCP server');
    summary.push('  -> On first run, approve the MidBrain hooks (or set hooks_auto_accept: true / HERMES_ACCEPT_HOOKS=1 for non-TTY use)');
    return summary;
  }

  async installProject(projectDir, opts = {}) {
    const isDev = opts.isDev === true;
    const configFile = path.join(projectDir, '.hermes', 'config.yaml');
    const doc = await readYamlDoc(configFile);
    const { exists, pinned } = patchMcpEntry(doc, { isDev, projectDir });
    await backup(configFile);
    await writeYamlDoc(configFile, doc);
    return [formatLine(configFile, exists, pinned)];
  }

  projectConfigFiles(_projectDir) {
    return ['.hermes/config.yaml'];
  }

  /**
   * Fresh when midbrain hooks reference the current stable shim (and the shim
   * exists). Stale legacy package-cache commands trigger a repair.
   */
  async isFresh() {
    try {
      const doc = await readYamlDoc(configPath());
      let hasMidbrainHook = false;
      for (const [event, role] of Object.entries(HOOK_EVENTS)) {
        const node = doc.getIn(['hooks', event]);
        const entries = node && typeof node.toJSON === 'function' ? node.toJSON() : node;
        if (!Array.isArray(entries)) continue;
        const commands = entries.map((e) => (e && typeof e.command === 'string' ? e.command : ''));
        if (!commands.some((c) => isMidbrainHookCommand(c))) continue;
        hasMidbrainHook = true;
        if (commands.some((c) => LEGACY_HOOK_SCRIPTS.some((s) => c.includes(s)))) return false;
        if (!commands.some((c) => c === buildHookCommand(role))) return false;
      }
      if (!hasMidbrainHook) return true;
      return existsSync(stableHookPath());
    } catch { return true; }
  }

  /** Repair stale hooks by rewriting them and reinstalling the shim. */
  async repairHooks() {
    const cfp = configPath();
    const doc = await readYamlDoc(cfp);
    await patchHooks(doc);
    await installStableHookShim();
    await writeYamlDoc(cfp, doc);
    return ['  ~ Hermes hooks repaired (stable Hermes hook shim installed)'];
  }
}
