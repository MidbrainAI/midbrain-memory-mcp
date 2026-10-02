/**
 * Project directory and project-root discovery, shared by the MCP server,
 * the capture hooks and the plugins (issue #92).
 *
 * A capture hook receives the directory the client is working in. Work for a
 * project often runs from a subfolder, a scratch directory or a git worktree,
 * so that directory is not where `.midbrain/.midbrain-key` lives, and a key
 * lookup limited to it silently fell through to the client or global key.
 * projectRootCandidates() lists every directory the project key may be in:
 * the reported directory and its parents up to, not including, the home
 * directory or the filesystem root, and, when one of them is a linked git
 * worktree, the main worktree's root and its parents.
 */

import { realpathSync } from 'fs';
import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';

export const TERMINAL_CWD_PLACEHOLDER = '${TERMINAL_CWD}';
export const STRICT_PROJECT_ENV = 'MIDBRAIN_STRICT_PROJECT';

/** MIDBRAIN_PROJECT_DIR when it names a real path; the unresolved placeholder counts as unset. */
export function configuredProjectDir(env = process.env) {
  return effectiveProjectDir(undefined, env).dir;
}

/**
 * The one rule for which project directory applies: an explicit directory
 * when given, else MIDBRAIN_PROJECT_DIR. `unresolved` reports an env value
 * that is still the TERMINAL_CWD placeholder, which callers warn about.
 *
 * @returns {{dir: string|undefined, unresolved: boolean}}
 */
export function effectiveProjectDir(explicit, env = process.env) {
  const given = typeof explicit === 'string' && explicit.trim() ? explicit : undefined;
  if (given) return { dir: given, unresolved: false };
  const raw = env.MIDBRAIN_PROJECT_DIR?.trim();
  if (raw === TERMINAL_CWD_PLACEHOLDER) return { dir: undefined, unresolved: true };
  return { dir: raw || undefined, unresolved: false };
}

/**
 * The directory a capture hook resolves its key from: the directory the
 * client reported, else MIDBRAIN_PROJECT_DIR. An explicit directory beats
 * the env everywhere (MCP server, installer, hooks), so a MIDBRAIN_PROJECT_DIR
 * exported in a shell can never route another project's captures.
 */
export function hookProjectDir(cwd) {
  // A client-reported cwd is trimmed: stray whitespace there is transport
  // noise, unlike an explicit directory whose bytes the installer preserves.
  return effectiveProjectDir(typeof cwd === 'string' ? cwd.trim() : cwd).dir;
}

/** Opt-in: withhold a capture rather than fall back to a non-project key. */
export function isStrictProject(env = process.env) {
  return env[STRICT_PROJECT_ENV] === '1';
}

/**
 * The main worktree's root when `dir` is a linked git worktree, else null. A
 * linked worktree has a `.git` file reading `gitdir: <main>/.git/worktrees/<name>`;
 * the main worktree has a `.git` directory, and a submodule points at
 * `.git/modules/`, so neither resolves.
 */
export async function mainWorktreeRoot(dir) {
  let text;
  try {
    text = await readFile(path.join(dir, '.git'), 'utf8');
  } catch {
    return null;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match) return null;
  const gitdir = path.resolve(dir, match[1]);
  const parts = gitdir.split(/[\\/]+/);
  // a UNC gitdir (\\server\share\...) keeps its double leading separator
  const unc = /^[\\/]{2}/.test(gitdir) ? path.sep : '';
  // the last `.git/worktrees/<name>` triple: the worktree itself may be named "worktrees"
  for (let i = parts.length - 3; i >= 1; i--) {
    if (parts[i] === '.git' && parts[i + 1] === 'worktrees') return unc + (parts.slice(0, i).join(path.sep) || path.sep);
  }
  return null;
}

/**
 * A normalized path without trailing separators (the root keeps its one). An
 * absolute path keeps its shape (on Windows no drive letter is added); a
 * relative one is made absolute against the working directory, so the walk
 * never heads for "." and the home guard holds.
 */
function trimmed(value) {
  const normalized = path.isAbsolute(value) ? path.normalize(value) : path.resolve(value);
  const root = path.parse(normalized).root;
  return normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized;
}

/** Every spelling of the home directory to stop at: as configured and as its real path. */
function homeKeys(homeDir) {
  const resolved = path.resolve(homeDir);
  const keys = new Set([pathKey(resolved)]);
  try { keys.add(pathKey(realpathSync(resolved))); } catch { /* keep the configured spelling only */ }
  return keys;
}

/**
 * Directories that may hold the project key for work started in `startDir`,
 * nearest first, produced lazily so a caller that finds the key in the first
 * directory never pays for the walk. The start directory is always offered,
 * even when it is the home directory (a home-as-project setup reads
 * `~/.midbrain/.midbrain-key`); the walk upward stops below the home
 * directory and the filesystem root. A linked git worktree adds the main
 * worktree's root and parents. The `.git` probe for a directory runs only
 * after the caller has looked at that directory.
 *
 * @param {string} startDir
 * @param {{homeDir?: string}} [opts]
 * @returns {AsyncGenerator<string>}
 */
export async function* walkProjectRoots(startDir, { homeDir = os.homedir() } = {}) {
  const homes = homeKeys(homeDir);
  const start = trimmed(startDir);
  // Real paths matter only when the start path goes through a symlink; then
  // every ancestor is compared by real path too. Otherwise the spelling is
  // enough and no realpath call is made per level.
  const startReal = realpathOrSelf(start);
  const needsReal = pathKey(startReal) !== pathKey(start);
  const isHome = (dir) => homes.has(pathKey(dir)) || (needsReal && homes.has(pathKey(realpathOrSelf(dir))));
  const seen = new Set();
  const queue = [start];
  let first = true;
  while (queue.length > 0) {
    let dir = queue.shift();
    const root = path.parse(dir).root;
    while (!seen.has(pathKey(dir)) && (first || (!isHome(dir) && dir !== root))) {
      // the start directory is offered even when it is home, but nothing above home ever is
      const last = first && isHome(dir);
      first = false;
      seen.add(pathKey(dir));
      yield dir;
      if (last) break;
      const main = await mainWorktreeRoot(dir);
      if (main) queue.push(trimmed(main));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
}

/** The candidates of walkProjectRoots() as an array. */
export async function projectRootCandidates(startDir, opts = {}) {
  const out = [];
  for await (const dir of walkProjectRoots(startDir, opts)) out.push(dir);
  return out;
}

function realpathOrSelf(value) {
  try { return realpathSync(value); } catch { return value; }
}

/** Comparison form of a path: Windows paths compare without regard to case. */
function pathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/** Log, through the hook's own logger, that a capture is using a non-project key. */
export function logProjectFallback(api, logger) {
  const note = api?.projectFallbackNote;
  if (!note) return;
  const where = api.requestedProjectDir ? ` (project directory: ${api.requestedProjectDir})` : '';
  try { logger?.warn?.(`SCOPE: ${note}${where}`); } catch { /* logging never breaks a hook */ }
}
