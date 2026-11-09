// Throwaway home: detection fixtures, the pre-seeded global key (as a logged-in
// user would have it), and the REAL installer run against the candidate.
import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnCapture } from './proc.mjs';
import { childEnv, HARNESS_DIR } from './context.mjs';
import { smokeEnv } from './dry-smoke-policy.mjs';

export function seedDetectionFixtures(ctx, manifests) {
  const written = [];
  for (const m of manifests) {
    for (const fx of m.detectionFixtures || []) {
      const abs = path.join(ctx.dirs.home, fx.path);
      mkdirSync(path.dirname(abs), { recursive: true });
      if (!existsSync(abs)) {
        writeFileSync(abs, fx.content ?? '');
        written.push(abs);
      }
    }
  }
  return written;
}

export function writeGlobalKey(ctx, key) {
  const dir = path.join(ctx.dirs.home, '.config', 'midbrain');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, '.midbrain-key');
  writeFileSync(file, `${key.trim()}\n`, { mode: 0o600 });
  return file;
}

export function writeGlobalHostConfig(ctx, apiUrl) {
  if (!apiUrl) return null;
  const dir = path.join(ctx.dirs.home, '.config', 'midbrain');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'config.json');
  writeFileSync(file, `${JSON.stringify({ apiUrl }, null, 2)}\n`);
  return file;
}

export function writeProjectKey(projectDir, key) {
  const dir = path.join(projectDir, '.midbrain');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, '.midbrain-key');
  writeFileSync(file, `${key.trim()}\n`, { mode: 0o600 });
  return file;
}

export async function initProject(ctx, name) {
  const dir = ctx.projectDir(name);
  if (!existsSync(path.join(dir, '.git'))) {
    await spawnCapture('git', ['init', '-q'], { cwd: dir, env: childEnv(ctx), timeoutMs: 20000 });
  }
  const readme = path.join(dir, 'README.md');
  if (!existsSync(readme)) writeFileSync(readme, `# ${name}\n\nHarness project for run ${ctx.runId}.\n`);
  return dir;
}

/**
 * Run the product's installer against the candidate.
 * dev mode:      node <checkout>/install.mjs --dev …   (clients point at the checkout)
 * registry mode: npx -y <pkg>@latest install …          (resolved from the loopback registry)
 */
export async function installCandidate(ctx, candidate, { cwd, extraArgs = [], label = 'install-global' } = {}) {
  let cmd;
  let args;
  if (candidate.mode === 'registry') {
    cmd = 'npx';
    args = ['-y', `${candidate.name}@latest`, 'install', '--non-interactive', '--no-login', ...extraArgs];
  } else {
    cmd = process.execPath;
    args = [path.join(candidate.repoRoot, 'install.mjs'), '--dev', '--non-interactive', '--no-login', ...extraArgs];
  }
  const r = await spawnCapture(cmd, args, { cwd, env: ctx.options.drySmoke ? smokeEnv(ctx) : childEnv(ctx), timeoutMs: 300000 });
  const logDir = path.join(ctx.dirs.evidence, '_install');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, `${label}.stdout.txt`), r.stdout);
  writeFileSync(path.join(logDir, `${label}.stderr.txt`), r.stderr);
  return r;
}

/** Ask the product's own adapters whether a client install is complete and fresh. */
export async function inspectInstall(ctx, candidate, clientId, { installed = false } = {}) {
  const script = path.join(HARNESS_DIR, 'lib', 'inspect-install.mjs');
  // Before an upgrade, freshness belongs to the installed release's adapter.
  const command = installed ? 'npx' : process.execPath;
  const args = installed
    ? ['-y', '--package', `${candidate.name}@latest`, '--', process.execPath, script, '--installed', clientId]
    : [script, candidate.repoRoot, clientId];
  const r = await spawnCapture(command, args, {
    cwd: ctx.dirs.run,
    env: ctx.options.drySmoke ? smokeEnv(ctx) : childEnv(ctx),
    timeoutMs: 30000,
  });
  try {
    return { ...JSON.parse(r.stdout.trim()), stderr: r.stderr.trim() };
  } catch {
    return { id: clientId, error: `inspect failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}` };
  }
}
