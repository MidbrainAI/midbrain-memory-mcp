/**
 * Real-home tripwire (PRD-034 S4, AC-8 / B10).
 *
 * Vitest globalSetup: records SHA-256 hashes of the real user's client config
 * surfaces before the suite and fails the run if any of them changed after.
 * Hash-only by design — real-config content is never logged, asserted on, or
 * echoed; a drift report prints paths only.
 *
 * Runs in the vitest main process, before any test worker overrides HOME.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';

export const ABSENT = 'ABSENT';

/** Every real-home surface the suite must never mutate. */
export function tripwireSurfaces(home = os.homedir()) {
  const hermesHome = process.env.HERMES_HOME?.trim()
    ? path.resolve(process.env.HERMES_HOME.trim())
    : path.join(home, '.hermes');
  const opencodeDir = path.join(home, '.config', 'opencode');
  return [
    path.join(home, '.claude.json'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.codex', 'config.toml'),
    path.join(home, '.codex', 'hooks.json'),
    path.join(hermesHome, 'config.yaml'),
    path.join(opencodeDir, 'opencode.json'),
    path.join(opencodeDir, 'opencode.jsonc'),
    path.join(opencodeDir, 'plugins', 'midbrain-memory.ts'),
    path.join(opencodeDir, 'plugins', 'midbrain-shared.mjs'),
    path.join(opencodeDir, 'plugins', '.midbrain-repo-root'),
    path.join(home, '.midbrain', 'bin', 'claude-hook'),
    path.join(home, '.midbrain', 'bin', 'claude-hook.cmd'),
    path.join(home, '.midbrain', 'bin', 'codex-hook'),
    path.join(home, '.midbrain', 'bin', 'hermes-hook'),
    path.join(home, '.midbrain', 'bin', 'hermes-hook.cmd'),
    path.join(home, '.config', 'midbrain', '.midbrain-key'),
    path.join(home, '.config', 'claude', '.midbrain-key'),
    path.join(home, '.config', 'codex', '.midbrain-key'),
    path.join(home, '.config', 'opencode', '.midbrain-key'),
    path.join(home, '.config', 'hermes', '.midbrain-key'),
    path.join(home, '.config', 'nanoclaw', '.midbrain-key'),
  ];
}

/**
 * Hash each path. Missing/unreadable file -> ABSENT sentinel, so creation and
 * deletion both register as drift.
 * @returns {Record<string, string>}
 */
export function collectHashes(paths) {
  const out = {};
  for (const p of paths) {
    try {
      out[p] = createHash('sha256').update(readFileSync(p)).digest('hex');
    } catch {
      out[p] = ABSENT;
    }
  }
  return out;
}

/** @returns {string[]} paths whose hash changed between the two records. */
export function diffHashes(before, after) {
  const drifted = [];
  for (const p of Object.keys(before)) {
    if (after[p] !== before[p]) drifted.push(p);
  }
  return drifted;
}

let baseline = null;
let surfaces = null;

export function setup() {
  surfaces = tripwireSurfaces();
  baseline = collectHashes(surfaces);
}

export function teardown() {
  const after = collectHashes(surfaces);
  const drifted = diffHashes(baseline, after);
  if (drifted.length > 0) {
    // process.exitCode (not just a throw): vitest 4 logs a teardown error but
    // still exits 0, which would let a config-mutating suite pass CI. The
    // explicit exit code makes drift fail the run (AC-8/B10).
    process.exitCode = 1;
    throw new Error(
      '[midbrain tripwire] REAL client config changed during the test run:\n' +
      drifted.map((p) => `  - ${p}`).join('\n') +
      '\nIf a live AI client session was active on this machine, re-run the suite in a quiet window.' +
      '\nIf this reproduces in isolation, a test is mutating real config — fix the test before anything else.',
    );
  }
}
