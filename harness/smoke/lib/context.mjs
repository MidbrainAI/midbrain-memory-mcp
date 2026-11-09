// Run identity, run directories, and the scrubbed environment every client
// child receives. Run homes live OUTSIDE os.tmpdir() on purpose: the product
// skips self-repair when it classifies its launch context as tmp/worktree/CI.
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const HARNESS_VERSION = '0.1.0';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const HARNESS_DIR = path.join(REPO_ROOT, 'harness', 'smoke');

export function defaultRoot() {
  const env = (process.env.MIDBRAIN_HARNESS_ROOT || '').trim();
  return env ? path.resolve(env) : path.join(os.homedir(), '.midbrain-harness');
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function newRunId() {
  return `${stamp()}-${randomBytes(2).toString('hex')}`;
}

export function newMarker() {
  return `MBH-${randomBytes(3).toString('hex').toUpperCase()}`;
}

// Host variables that are safe and useful to inherit. Everything else is dropped.
const HOST_KEEP = ['PATH', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME'];

export function createRunContext({ root = defaultRoot(), options = {} } = {}) {
  const runId = newRunId();
  const marker = newMarker();
  const runDir = path.join(root, 'runs', runId);
  const dirs = {
    run: runDir,
    home: path.join(runDir, 'home'),
    tmp: path.join(runDir, 'tmp'),
    // Inside the throwaway home so captured cwd metadata is home-relative (~/work/…), as for a real user.
    projects: path.join(runDir, 'home', 'work'),
    evidence: path.join(runDir, 'evidence'),
    logs: path.join(runDir, 'logs'),
    tools: path.join(runDir, 'tools'),
    toolsBin: path.join(runDir, 'tools', 'bin'),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
  return {
    runId,
    marker,
    root,
    dirs,
    options,
    startedAt: new Date().toISOString(),
    hostHome: os.homedir(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    node: process.version,
    secrets: {},
    meta: {},
    turns: [],
    subMarker(clientId, scenarioId, n) {
      return [marker, clientId, scenarioId, n]
        .filter((v) => v !== undefined && v !== null && v !== '')
        .join('-');
    },
    projectDir(name) {
      const p = path.join(dirs.projects, name);
      mkdirSync(p, { recursive: true });
      return p;
    },
    evidenceDir(clientId, scenarioId) {
      const p = path.join(dirs.evidence, clientId, scenarioId);
      mkdirSync(p, { recursive: true });
      return p;
    },
    writeJson(file, data) {
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    },
  };
}

/**
 * Build the environment for any child that runs inside the throwaway home.
 * Nothing from MIDBRAIN_*, ANTHROPIC_*, OPENAI_*, CLAUDE_*, CODEX_*, XDG_*, CI or
 * VITEST leaks through; a manifest adds only its own secret via `extra`.
 */
export function childEnv(ctx, extra = {}) {
  const env = {};
  for (const k of HOST_KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
  const home = ctx.dirs.home;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: ctx.dirs.tmp,
    TEMP: ctx.dirs.tmp,
    TMP: ctx.dirs.tmp,
    CODEX_HOME: path.join(home, '.codex'),
    HERMES_HOME: path.join(home, '.hermes'),
    PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'),
    PI_CODING_AGENT_SESSION_DIR: path.join(home, '.pi', 'agent', 'sessions'),
    npm_config_cache: path.join(home, '.npm'),
    MIDBRAIN_LOG_DIR: ctx.dirs.logs,
    MIDBRAIN_LOG_LEVEL: 'debug',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
    PATH: `${ctx.dirs.toolsBin}${path.delimiter}${process.env.PATH || ''}`,
  });
  if ((process.env.MIDBRAIN_HARNESS_PK || '') === '1') env.MIDBRAIN_ENABLE_PK_INJECTION = '1';
  if (ctx.registry && ctx.registry.url) env.npm_config_registry = ctx.registry.url;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null || v === '') delete env[k];
    else env[k] = String(v);
  }
  return env;
}
