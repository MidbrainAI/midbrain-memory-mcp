/**
 * Sandboxed environment fixture for installer/repair/adapter tests (PRD-034 S4).
 *
 * makeTestEnv() builds a throwaway HOME (plus XDG dirs, HERMES_HOME, npm cache,
 * TMPDIR and log dir) and points every path-resolving env var at it, so client
 * adapters and the installer physically cannot reach the real user profile.
 * Restores the exact prior environment on restore().
 *
 * CI is explicitly unset by default (settable via opts.env) so behavior-matrix
 * tests do not self-skip when the suite runs on a real CI runner.
 */

import fs from 'fs/promises';
import { createHash } from 'crypto';
import os from 'os';
import path from 'path';

/** Env vars that influence where midbrain code reads/writes. All managed. */
const MANAGED_ENV_KEYS = [
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'TMPDIR',
  'HERMES_HOME',
  'NANOCLAW_HOME',
  'npm_config_cache',
  'MIDBRAIN_LOG_DIR',
  'MIDBRAIN_PROJECT_DIR',
  'MIDBRAIN_CLIENT',
  'MIDBRAIN_CONFIG_DIR',
  'MIDBRAIN_API_KEY',
  'MIDBRAIN_ENABLE_PK_INJECTION',
  'CI',
];

const UPDATE_CACHE_FILENAME = '.midbrain-update-check.json';

/**
 * Create an isolated sandbox environment.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.clients] - Client fixtures to seed so detectClients()
 *   finds them: any of 'claude', 'codex', 'hermes', 'opencode', 'nanoclaw'.
 * @param {object} [opts.env] - Extra env overrides applied after the managed
 *   set (e.g. { CI: '1' }).
 * @param {boolean} [opts.freshUpdateCache=true] - Pre-seed a fresh update-check
 *   throttle cache in the sandbox TMPDIR so checkForUpdate() never fetches npm.
 * @returns {Promise<TestEnv>}
 */
export async function makeTestEnv(opts = {}) {
  const { clients = [], env: extraEnv = {}, freshUpdateCache = true } = opts;

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'midbrain-prd034-env-'));
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(tmp, { recursive: true });

  const saved = {};
  for (const key of MANAGED_ENV_KEYS) saved[key] = process.env[key];

  const managed = {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: undefined,
    XDG_CACHE_HOME: undefined,
    XDG_STATE_HOME: undefined,
    TMPDIR: tmp,
    HERMES_HOME: path.join(home, '.hermes'),
    NANOCLAW_HOME: undefined,
    npm_config_cache: path.join(home, '.npm'),
    MIDBRAIN_LOG_DIR: path.join(home, 'logs'),
    MIDBRAIN_PROJECT_DIR: undefined,
    MIDBRAIN_CLIENT: undefined,
    MIDBRAIN_CONFIG_DIR: undefined,
    MIDBRAIN_API_KEY: undefined,
    MIDBRAIN_ENABLE_PK_INJECTION: undefined,
    CI: undefined,
    ...extraEnv,
  };
  for (const [key, value] of Object.entries(managed)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const paths = sandboxPaths(home);

  if (freshUpdateCache) {
    await fs.writeFile(
      path.join(tmp, UPDATE_CACHE_FILENAME),
      JSON.stringify({ lastCheck: Date.now() }),
      'utf8',
    );
  }

  for (const client of clients) await seedClient(paths, client);

  let restored = false;
  return {
    root,
    home,
    tmp,
    paths,
    /** Spawn-ready env block: current process env view of the sandbox. */
    childEnv(extra = {}) {
      const out = { ...process.env, ...extra };
      for (const key of MANAGED_ENV_KEYS) {
        if (managed[key] === undefined && !(key in extra)) delete out[key];
      }
      return out;
    },
    snapshot: () => snapshotTree(root),
    async restore() {
      if (restored) return;
      restored = true;
      for (const key of MANAGED_ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** Well-known sandbox file locations, mirroring each adapter's resolution. */
export function sandboxPaths(home) {
  return {
    claudeJson: path.join(home, '.claude.json'),
    claudeSettings: path.join(home, '.claude', 'settings.json'),
    codexConfig: path.join(home, '.codex', 'config.toml'),
    codexHooks: path.join(home, '.codex', 'hooks.json'),
    hermesConfig: path.join(home, '.hermes', 'config.yaml'),
    opencodeConfig: path.join(home, '.config', 'opencode', 'opencode.json'),
    opencodeConfigJsonc: path.join(home, '.config', 'opencode', 'opencode.jsonc'),
    opencodePlugins: path.join(home, '.config', 'opencode', 'plugins'),
    nanoclawRoot: path.join(home, 'nanoclaw-v2'),
    nanoclawSkill: path.join(home, 'nanoclaw-v2', '.claude', 'skills', 'add-midbrain', 'SKILL.md'),
    midbrainBin: path.join(home, '.midbrain', 'bin'),
    claudeShim: path.join(home, '.midbrain', 'bin', 'claude-hook'),
    codexShim: path.join(home, '.midbrain', 'bin', 'codex-hook'),
    hermesShim: path.join(home, '.midbrain', 'bin', process.platform === 'win32' ? 'hermes-hook.cmd' : 'hermes-hook'),
    globalKey: path.join(home, '.config', 'midbrain', '.midbrain-key'),
  };
}

async function seedClient(paths, client) {
  switch (client) {
    case 'claude':
      await writeSeed(paths.claudeJson, '{}\n');
      await writeSeed(paths.claudeSettings, '{}\n');
      break;
    case 'codex':
      await writeSeed(paths.codexConfig, '');
      break;
    case 'hermes':
      await writeSeed(paths.hermesConfig, '');
      break;
    case 'opencode':
      await writeSeed(paths.opencodeConfig, '{}\n');
      break;
    case 'nanoclaw':
      await writeSeed(path.join(paths.nanoclawRoot, 'container', 'Dockerfile'), '# fixture\n');
      await fs.mkdir(path.join(paths.nanoclawRoot, '.claude', 'skills'), { recursive: true });
      break;
    default:
      throw new Error(`Unknown client fixture: ${client}`);
  }
}

async function writeSeed(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

/**
 * Recursive content+mtime snapshot of a directory tree.
 * @returns {Promise<Map<string, {sha256: string, mtimeMs: number}>>}
 */
export async function snapshotTree(root) {
  const out = new Map();
  await walk(root, out);
  return out;
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile()) {
      const [content, stat] = await Promise.all([fs.readFile(full), fs.stat(full)]);
      out.set(full, {
        sha256: createHash('sha256').update(content).digest('hex'),
        mtimeMs: stat.mtimeMs,
      });
    }
  }
}

/**
 * Diff two snapshots. Returns [] when nothing changed at all (content AND
 * mtime), which is the AC-5 zero-churn assertion.
 *
 * @returns {{path: string, change: 'added'|'removed'|'content'|'mtime'}[]}
 */
export function diffSnapshots(before, after) {
  const changes = [];
  for (const [p, b] of before) {
    const a = after.get(p);
    if (!a) changes.push({ path: p, change: 'removed' });
    else if (a.sha256 !== b.sha256) changes.push({ path: p, change: 'content' });
    else if (a.mtimeMs !== b.mtimeMs) changes.push({ path: p, change: 'mtime' });
  }
  for (const p of after.keys()) {
    if (!before.has(p)) changes.push({ path: p, change: 'added' });
  }
  return changes;
}
