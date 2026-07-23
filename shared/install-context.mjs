/**
 * shared/install-context.mjs — launch-context classifier (PRD-034 S1).
 *
 * Self-repair must never write user-scope config from a location that will
 * not survive (temp dirs, worktrees, CI). classifyInstallContext() decides,
 * from the running instance's repo root, whether automatic repair may run.
 *
 * Kinds, first match wins (order is normative — see PRD-034 §3 S1):
 *   1. worktree   — <repoRoot>/.git exists and is a file (worktree/submodule)
 *   2. npx-cache  — the path contains an `_npx` segment (npm exec cache);
 *                   this IS the canonical launch mode, so it outranks tmp/ci
 *                   (npm caches relocated under a tmpdir, CI images)
 *   3. tmp        — under os.tmpdir() (raw or realpath) or the literal
 *                   POSIX roots /tmp and /private/tmp
 *   4. ci         — env CI truthy (non-empty, not "false"/"0", case-insensitive)
 *   5. durable    — everything else (real checkouts, global npm roots)
 *
 * The caller (install.mjs runSelfRepair) skips repair for tmp/worktree/ci.
 * Never throws; classification failures resolve to durable — the safe writes
 * are guaranteed by canonical-only targets (S2), not by this gate alone.
 */

import { statSync, realpathSync } from 'fs';
import os from 'os';

const SKIP_KINDS = new Set(['tmp', 'worktree', 'ci']);

/** Split on both separator styles so win32 fixture paths work anywhere. */
function segments(p) {
  return p.split(/[\\/]+/).filter((s) => s.length > 0);
}

/** True when child equals parent or sits beneath it (segment-wise). */
function isUnder(child, parent) {
  if (!parent) return false;
  const c = segments(child);
  const p = segments(parent);
  if (p.length === 0 || c.length < p.length) return false;
  return p.every((seg, i) => c[i] === seg);
}

function isGitFile(repoRoot) {
  try {
    return statSync(`${repoRoot}/.git`).isFile();
  } catch {
    return false;
  }
}

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function ciTruthy(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const lowered = value.toLowerCase();
  return lowered !== 'false' && lowered !== '0';
}

/**
 * Classify the launch context of the running instance.
 *
 * @param {string} repoRoot - The running package's root directory.
 * @param {object} [opts]
 * @param {object} [opts.env] - Env map (default process.env). Injected for tests.
 * @param {string} [opts.tmpdir] - Tmp root (default os.tmpdir()). Injected for tests.
 * @returns {{kind: 'worktree'|'npx-cache'|'tmp'|'ci'|'durable', path: string}}
 */
export function classifyInstallContext(repoRoot, opts = {}) {
  try {
    const env = opts.env ?? process.env;
    const tmpdir = opts.tmpdir ?? os.tmpdir();

    if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
      return { kind: 'durable', path: typeof repoRoot === 'string' ? repoRoot : '' };
    }

    if (isGitFile(repoRoot)) return { kind: 'worktree', path: repoRoot };

    if (segments(repoRoot).includes('_npx')) return { kind: 'npx-cache', path: repoRoot };

    const candidates = [repoRoot, safeRealpath(repoRoot)].filter(Boolean);
    const tmpRoots = [tmpdir, safeRealpath(tmpdir), '/tmp', '/private/tmp'].filter(Boolean);
    // POSIX literals must not swallow win32 paths (or vice versa): isUnder is
    // segment-based, so "C:\..." never matches "/tmp" and drive letters must
    // agree between child and parent.
    for (const candidate of candidates) {
      if (tmpRoots.some((root) => isUnder(candidate, root))) {
        return { kind: 'tmp', path: repoRoot };
      }
    }

    if (ciTruthy(env.CI)) return { kind: 'ci', path: repoRoot };

    return { kind: 'durable', path: repoRoot };
  } catch {
    return { kind: 'durable', path: typeof repoRoot === 'string' ? repoRoot : '' };
  }
}

/** True when automatic self-repair must be skipped for this context. */
export function shouldSkipSelfRepair(context) {
  return SKIP_KINDS.has(context?.kind);
}
