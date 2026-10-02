/**
 * Real-home tripwire (PRD-034 S4, AC-8 / B10).
 *
 * Vitest globalSetup: records SHA-256 hashes of the real user's client config
 * surfaces, and a count of every entry in the real offline cache, before the
 * suite and fails the run if either changed after. Hash-only by design —
 * real-config and cache content is never logged, asserted on, or echoed; a
 * drift report prints paths and counts only.
 *
 * Runs in the vitest main process, before any test worker overrides HOME.
 */

import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import os from 'os';
import path from 'path';

export const ABSENT = 'ABSENT';
export const DIR = 'DIR';

// Every candidate NanoClaw root nanoclaw.mjs scans (keep in sync).
const NANOCLAW_DIRS = ['nanoclaw-v2', 'nanoclaw', 'NanoClaw'];
const NANOCLAW_SKILL_REL = path.join('.claude', 'skills', 'add-midbrain', 'SKILL.md');

/** Every real-home surface the suite must never mutate. */
export function tripwireSurfaces(home = os.homedir()) {
  const hermesHome = process.env.HERMES_HOME?.trim()
    ? path.resolve(process.env.HERMES_HOME.trim())
    : path.join(home, '.hermes');
  const opencodeDir = path.join(home, '.config', 'opencode');
  const nanoclawRoots = NANOCLAW_DIRS.map((dir) => path.join(home, dir));
  if (process.env.NANOCLAW_HOME?.trim()) {
    nanoclawRoots.unshift(path.resolve(process.env.NANOCLAW_HOME.trim()));
  }
  return [
    path.join(home, '.claude.json'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.codex', 'config.toml'),
    path.join(home, '.codex', 'hooks.json'),
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.cursor', 'hooks.json'),
    path.join(hermesHome, 'config.yaml'),
    path.join(opencodeDir, 'opencode.json'),
    path.join(opencodeDir, 'opencode.jsonc'),
    path.join(opencodeDir, 'plugins', 'midbrain-memory.ts'),
    path.join(opencodeDir, 'plugins', 'midbrain-shared.mjs'),
    path.join(opencodeDir, 'plugins', '.midbrain-repo-root'),
    // OpenCode cleanup targets (AC-13/AC-15): the legacy tree cleanup may
    // delete — the dir registers via the DIR sentinel so deletion is drift.
    path.join(opencodeDir, 'plugins', 'clients'),
    path.join(opencodeDir, 'plugins', 'logger.mjs'),
    path.join(opencodeDir, 'plugins', 'midbrain-api.mjs'),
    path.join(opencodeDir, 'plugins', 'midbrain-common.mjs'),
    path.join(home, '.midbrain', 'bin', 'claude-hook'),
    path.join(home, '.midbrain', 'bin', 'claude-hook.cmd'),
    path.join(home, '.midbrain', 'bin', 'codex-hook'),
    path.join(home, '.midbrain', 'bin', 'hermes-hook'),
    path.join(home, '.midbrain', 'bin', 'hermes-hook.cmd'),
    path.join(home, '.midbrain', 'bin', 'cursor-hook'),
    path.join(home, '.midbrain', 'bin', 'cursor-hook.cmd'),
    // NanoClaw installed-skill destinations (AC-15): every root the adapter
    // could resolve.
    ...nanoclawRoots.map((root) => path.join(root, NANOCLAW_SKILL_REL)),
    path.join(home, '.config', 'midbrain', '.midbrain-key'),
    path.join(home, '.config', 'claude', '.midbrain-key'),
    path.join(home, '.config', 'codex', '.midbrain-key'),
    path.join(home, '.config', 'opencode', '.midbrain-key'),
    path.join(home, '.config', 'hermes', '.midbrain-key'),
    path.join(home, '.config', 'nanoclaw', '.midbrain-key'),
    path.join(home, '.config', 'cursor', '.midbrain-key'),
  ];
}

/**
 * Real MidBrain state directories whose CONTENTS are watched, not just a fixed
 * file list: the offline episodic cache names files by a hashed key scope, so
 * a leaking test creates a file no static surface list can name (#88).
 * Workers scrub MIDBRAIN_STATE_DIR, so a leak lands in the default location.
 * The log dir is deliberately not watched: live client sessions append to it
 * during a run, so it would fail the tripwire on every dogfooding machine.
 */
export function tripwireStateDirs(home = os.homedir()) {
  return [path.join(home, '.cache', 'midbrain')];
}

const CACHE_FILE = /\.ndjson(\.processing)?$/;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Hash of what identifies a cache entry: its role and text. Content stays private. */
function cacheEntryKey(line) {
  try {
    const entry = JSON.parse(line);
    return sha256(JSON.stringify([entry.role ?? null, entry.text ?? null]));
  } catch {
    return sha256(line);
  }
}

/**
 * Count the entries in each cache directory, keyed by entry hash. Live and
 * in-flight (.processing) files both count, so a boot-time drain that renames
 * the file, re-caches a failed entry or deletes the batch never raises a
 * count; only an entry the run added does (a leaking test, or a live
 * client's failed capture).
 *
 * @returns {Record<string, Record<string, number>>} dir -> entry hash -> count
 */
export function snapshotCacheEntries(dirs) {
  const out = {};
  for (const dir of dirs) {
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    const counts = {};
    for (const name of names) {
      if (!CACHE_FILE.test(name)) continue;
      let text;
      try { text = readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const key = cacheEntryKey(line);
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    out[dir] = counts;
  }
  return out;
}

/** @returns {string[]} one line per directory that holds entries it did not hold before. */
export function diffCacheEntries(before, after) {
  const drifted = [];
  for (const [dir, counts] of Object.entries(after)) {
    const prior = before[dir] ?? {};
    let added = 0;
    for (const [key, count] of Object.entries(counts)) added += Math.max(0, count - (prior[key] ?? 0));
    if (added > 0) drifted.push(`${dir}: ${added} new cache ${added === 1 ? 'entry' : 'entries'}`);
  }
  return drifted;
}

/**
 * Hash each path. Missing/unreadable -> ABSENT sentinel; a directory -> DIR
 * sentinel — so creation and deletion of files AND directories all register
 * as drift (e.g. the OpenCode legacy `clients/` tree cleanup).
 */
export function collectHashes(paths) {
  const out = {};
  for (const p of paths) {
    try {
      if (statSync(p).isDirectory()) {
        out[p] = DIR;
      } else {
        out[p] = sha256(readFileSync(p));
      }
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

/**
 * Everything the tripwire watches for one home, in one record: config surface
 * hashes plus cache entry counts. The globalSetup below and
 * scripts/check-test-isolation.sh both snapshot and diff through these two
 * functions, so a leak one can see, the other can too.
 */
export function snapshotWatched(home = os.homedir()) {
  return {
    surfaces: collectHashes(tripwireSurfaces(home)),
    cache: snapshotCacheEntries(tripwireStateDirs(home)),
  };
}

/** @returns {string[]} drift lines: changed surface paths, then cache dirs with new entries. */
export function diffWatched(before, after) {
  return [
    ...diffHashes(before.surfaces, after.surfaces),
    ...diffCacheEntries(before.cache ?? {}, after.cache ?? {}),
  ];
}

let baseline = null;

export function setup() {
  baseline = snapshotWatched();
}

export function teardown() {
  const drifted = diffWatched(baseline, snapshotWatched());
  if (drifted.length > 0) {
    // process.exitCode (not just a throw): vitest 4 logs a teardown error but
    // may still exit 0 when all tests passed (observed in CI); setting the
    // explicit exit code makes drift fail the run (AC-8/B10).
    process.exitCode = 1;
    throw new Error(
      '[midbrain tripwire] REAL client config or MidBrain cache changed during the test run:\n' +
      drifted.map((p) => `  - ${p}`).join('\n') +
      '\nIf a live AI client session was active on this machine (a failed capture adds a cache entry), re-run the suite in a quiet window.' +
      '\nIf this reproduces in isolation, a test is writing real state — fix the test before anything else.',
    );
  }
}
