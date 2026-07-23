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
  KEY_FILENAME, MCP_KEY, REPO_ROOT,
  home, backup, writeSecure, extractCustomEnv, PINNED_RE, writeFileIfChanged,
} from './utils.mjs';
import {
  shellQuote, stableShimPath, installShim, shimStatus, commandReferencesShim,
  commandHasLegacyScriptPath, commandHasMidbrainInvocation,
  validateShimPaths as validateClientShimPaths,
} from './shim.mjs';

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { isDeepStrictEqual } from 'util';

const HOOK_TIMEOUT_SEC = 30;
const PROJECT_DIR_ENV = '${TERMINAL_CWD}';
const RESTART_WARNING =
  'If a Hermes gateway is already running, restart that gateway before memory capture takes effect.';
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
function stableHookPath() { return stableShimPath('hermes'); }
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

/**
 * Content-compared YAML document write; backs up only when actually changing.
 * lineWidth: 0 disables line folding so long hook command strings stay on
 * one line (valid either way, but cleaner and easier to diff/audit).
 */
async function writeYamlDocIfChanged(filePath, doc, { backupFirst = false } = {}) {
  const content = doc.toString({ lineWidth: 0 });
  const changed = await (async () => {
    try {
      return (await fs.readFile(filePath, 'utf8')) !== content;
    } catch { return true; }
  })();
  if (!changed) return false;
  if (backupFirst) await backup(filePath);
  await writeFileIfChanged(filePath, content);
  return true;
}

function buildHookCommand(role) {
  return `${shellQuote(stableHookPath())} ${role}`;
}

function validateShimPaths(opts = {}) {
  validateClientShimPaths('hermes', opts);
}

/** Build the mcp_servers.midbrain-memory entry (plain object). */
function buildMcpEntry({ isDev = false, extraEnv = {} } = {}) {
  const env = {
    ...extraEnv,
    MIDBRAIN_CLIENT: 'hermes',
    MIDBRAIN_PROJECT_DIR: PROJECT_DIR_ENV,
  };
  if (isDev) {
    env.MIDBRAIN_DEV = '1';
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
// Historic legacy commands ended in plugins/hermes/<script> (any checkout or
// npx-cache location) or paired a package reference with the exact script
// filename. Boundary-anchored, never substring: a user's own `capture-*.mjs`
// or a `myplugins/hermes/` path is never ours. Transitional (pre-0.4.7).
const LEGACY_HOOK_DIR = 'hermes';

function isLegacyHookCommand(command) {
  return commandHasLegacyScriptPath(command, LEGACY_HOOK_DIR, LEGACY_HOOK_SCRIPTS);
}

function isMidbrainHookCommand(command) {
  if (typeof command !== 'string') return false;
  // Exact-equality fast path: entries this adapter wrote are recognized
  // directly, independent of the ownership heuristics below.
  if (Object.values(HOOK_EVENTS).some((role) => command === buildHookCommand(role))) return true;
  return commandReferencesShim(command, 'hermes') ||
    isLegacyHookCommand(command) ||
    commandHasMidbrainInvocation(command, 'hermes');
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

    await installShim('hermes', { mode: 'install', isDev });
    await writeYamlDocIfChanged(cfp, doc, { backupFirst: true });

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
    await writeYamlDocIfChanged(cfp, doc, { backupFirst: true });
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
      return (await shimStatus('hermes')).fresh;
    } catch { return true; }
  }

  /**
   * Repair stale hooks: rewrite midbrain hook entries and reinstall the shim
   * when missing or stale. Dev-marked shim bodies are preserved; content-
   * compared writes keep mtimes (and Hermes hook approvals) stable.
   */
  async repairHooks() {
    const cfp = configPath();
    validateShimPaths();
    let doc;
    try {
      doc = await readYamlDoc(cfp);
    } catch { return []; } // unreadable config: fail open, skip
    await patchHooks(doc);
    const shim = await installShim('hermes', { mode: 'repair' });
    const wrote = await writeYamlDocIfChanged(cfp, doc);
    if (!wrote && !shim.written) return [];
    return ['  ~ Hermes hooks repaired (stable Hermes hook shim installed)'];
  }
}
