/**
 * Hermes Agent client adapter.
 *
 * Hermes Agent (Nous Research) stores its config as YAML at
 * ~/.hermes/config.yaml. This adapter handles:
 * - mcp_servers.midbrain-memory (MCP search entry)
 * - hooks.pre_llm_call / hooks.post_llm_call (episodic capture)
 * - ~/.config/hermes/.midbrain-key (per-client key)
 * - active config project scoping via Hermes' ${TERMINAL_CWD}
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
import { isDeepStrictEqual } from 'util';

const HOOK_TIMEOUT_SEC = 30;
const PROJECT_DIR_ENV = '${TERMINAL_CWD}';
const RESTART_WARNING =
  'If a Hermes gateway is already running, restart that gateway before memory capture takes effect.';
const WINDOWS_UNSUPPORTED_RE = /[&^()%!]/;
// Hermes lifecycle events -> midbrain capture roles.
const HOOK_EVENTS = {
  pre_llm_call: 'user',
  post_llm_call: 'assistant',
};
const LEGACY_HOOK_SCRIPTS = ['capture-user.mjs', 'capture-assistant.mjs'];

let yamlModule;

function hermesHome() {
  const explicitHome = process.env.HERMES_HOME?.trim();
  if (explicitHome) return path.resolve(explicitHome);
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return localAppData
      ? path.resolve(localAppData, 'hermes')
      : path.resolve(home(), 'AppData', 'Local', 'hermes');
  }
  return path.resolve(home(), '.hermes');
}
function configPath() { return path.join(hermesHome(), 'config.yaml'); }
function stableHookPath() {
  const filename = process.platform === 'win32' ? 'hermes-hook.cmd' : 'hermes-hook';
  return path.join(home(), '.midbrain', 'bin', filename);
}
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
  const isYamlNull = doc.contents === null ||
    (YAML.isScalar(doc.contents) && doc.contents.value === null);
  if (isYamlNull) doc.contents = doc.createNode({});
  if (!YAML.isMap(doc.contents)) {
    throw new Error(`Failed to parse ${filePath}: expected a mapping at document root`);
  }
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
  return `${shellQuote(stableHookPath())} ${role}`;
}

function windowsPathGuard(filePath, label) {
  if (process.platform === 'win32' && WINDOWS_UNSUPPORTED_RE.test(filePath)) {
    throw new Error(`${label} contains unsupported Windows command characters: ${filePath}`);
  }
}

function validateShimPaths({ isDev = false } = {}) {
  windowsPathGuard(stableHookPath(), 'Hermes hook shim path');
  if (!isDev) return;
  windowsPathGuard(process.execPath, 'Hermes development Node path');
  windowsPathGuard(path.join(REPO_ROOT, 'index.js'), 'Hermes development index path');
}

function shimBody({ isDev = false } = {}) {
  const indexPath = path.join(REPO_ROOT, 'index.js');
  if (process.platform === 'win32') {
    const command = isDev
      ? `"${process.execPath}" "${indexPath}" hook hermes "%~1"`
      : 'call npx.cmd -y midbrain-memory-mcp@latest hook hermes "%~1"';
    return `@echo off\r\n${command}\r\nexit /b 0\r\n`;
  }
  const command = isDev
    ? `${shellQuote(process.execPath)} ${shellQuote(indexPath)}`
    : 'npx -y midbrain-memory-mcp@latest';
  return `#!/bin/sh
set +e
${command} hook hermes "$@"
exit 0
`;
}

async function installStableHookShim(opts = {}) {
  validateShimPaths(opts);
  const shim = stableHookPath();
  await fs.mkdir(path.dirname(shim), { recursive: true });
  await fs.writeFile(shim, shimBody(opts), 'utf8');
  if (process.platform !== 'win32') await fs.chmod(shim, 0o755);
}

/** Build the mcp_servers.midbrain-memory entry (plain object). */
function buildMcpEntry({ isDev = false, extraEnv = {} } = {}) {
  const env = {
    ...extraEnv,
    MIDBRAIN_CLIENT: 'hermes',
    MIDBRAIN_PROJECT_DIR: PROJECT_DIR_ENV,
  };
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
  const extraEnv = extractCustomEnv(existingJs, 'env');
  const desiredEnv = buildMcpEntry({ ...opts, extraEnv }).env;
  const envChanged = !isDeepStrictEqual(existingJs?.env, desiredEnv);
  if (pinned) {
    if (envChanged) {
      doc.setIn(['mcp_servers', MCP_KEY, 'env'], doc.createNode(desiredEnv));
    }
  } else {
    doc.setIn(['mcp_servers', MCP_KEY], buildMcpEntry({ ...opts, extraEnv }));
  }
  return { exists, pinned, envChanged };
}

/**
 * Rewrite hooks.pre_llm_call / hooks.post_llm_call so midbrain has exactly one
 * entry per event, preserving any non-midbrain hooks the user configured.
 */
async function patchHooks(doc) {
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
}

function formatLine(label, exists, pinned, envChanged) {
  if (pinned && envChanged) {
    return `${label}: midbrain-memory pinned command preserved; environment updated`;
  }
  if (pinned) {
    return `${label}: midbrain-memory pinned command and environment unchanged (no-op)`;
  }
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

    validateShimPaths({ isDev });
    const doc = await readYamlDoc(cfp);
    const { exists, pinned, envChanged } = patchMcpEntry(doc, { isDev });
    await patchHooks(doc);

    await installStableHookShim({ isDev });
    await backup(cfp);
    await writeYamlDoc(cfp, doc);

    summary.push(formatLine(cfp, exists, pinned, envChanged));
    summary.push(`${cfp}: MidBrain capture hooks written (pre_llm_call, post_llm_call)`);
    summary.push(`${stableHookPath()}: stable Hermes hook shim written`);
    summary.push(RESTART_WARNING);
    summary.push('  -> On first run, approve the MidBrain hooks (or set hooks_auto_accept: true / HERMES_ACCEPT_HOOKS=1 for non-TTY use)');
    return summary;
  }

  async installProject(_projectDir, opts = {}) {
    const isDev = opts.isDev === true;
    const cfp = configPath();
    validateShimPaths({ isDev });
    const doc = await readYamlDoc(cfp);
    const { exists, pinned, envChanged } = patchMcpEntry(doc, { isDev });
    await backup(cfp);
    await writeYamlDoc(cfp, doc);
    return [formatLine(cfp, exists, pinned, envChanged), RESTART_WARNING];
  }

  projectConfigFiles(_projectDir) {
    return [path.resolve(configPath())];
  }

  /**
   * Fresh when midbrain hooks reference the current stable shim (and the shim
   * exists). Stale legacy package-cache commands trigger a repair.
   */
  async isFresh() {
    try {
      const doc = await readYamlDoc(configPath());
      const eventEntries = Object.fromEntries(Object.keys(HOOK_EVENTS).map((event) => {
        const node = doc.getIn(['hooks', event]);
        const value = node && typeof node.toJSON === 'function' ? node.toJSON() : node;
        return [event, Array.isArray(value) ? value : []];
      }));
      const hasMidbrainHook = Object.values(eventEntries).some((entries) =>
        entries.some((entry) => isMidbrainHookCommand(entry?.command)));
      if (!hasMidbrainHook) return true;
      try {
        validateShimPaths();
      } catch {
        return false;
      }

      for (const [event, role] of Object.entries(HOOK_EVENTS)) {
        const midbrain = eventEntries[event].filter((entry) =>
          isMidbrainHookCommand(entry?.command));
        if (midbrain.length !== 1) return false;
        if (midbrain[0].command !== buildHookCommand(role)) return false;
        if (midbrain[0].timeout !== HOOK_TIMEOUT_SEC) return false;
      }
      return existsSync(stableHookPath());
    } catch { return true; }
  }

  /** Repair stale hooks by rewriting them and reinstalling the shim. */
  async repairHooks() {
    const cfp = configPath();
    validateShimPaths();
    const doc = await readYamlDoc(cfp);
    await patchHooks(doc);
    await installStableHookShim();
    await writeYamlDoc(cfp, doc);
    return ['  ~ Hermes hooks repaired (stable Hermes hook shim installed)'];
  }
}
