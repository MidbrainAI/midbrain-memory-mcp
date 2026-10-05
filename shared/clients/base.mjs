/**
 * Abstract base class for MCP client adapters.
 *
 * Each supported client (OpenCode, Claude Code, future clients) implements
 * this interface. The installer, server, and migration logic call only
 * these methods — never client-specific branching.
 *
 * ## Adding a new client
 *
 * 1. Create `shared/clients/<name>.mjs` extending BaseClient.
 * 2. Implement all abstract methods/getters (see JSDoc below).
 * 3. Import and instantiate in `shared/clients/registry.mjs`:
 *      import { MyClient } from './myclient.mjs';
 *      const CLIENTS = [new OpenCode(), new Claude(), new MyClient()];
 * 4. Done. The installer and server pick it up automatically.
 *    No changes to install.mjs, index.js, or existing tests.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { readKeystore, getUserKey } from '../keystore.mjs';
import { classifyScopeError, credentialShadowNote, sameCredential } from '../credential-scope.mjs';
import { globalConfigDir } from '../state-dir.mjs';
import {
  STRICT_PROJECT_ENV, effectiveProjectDir, isStrictProject, walkProjectRoots,
} from '../project-dir.mjs';

const KEY_FILENAME = ".midbrain-key";
const KEYSTORE_FILENAME = '.midbrain-keystore.json';
const MIDBRAIN_DIR = '.midbrain';
const ENV_VAR = 'MIDBRAIN_API_KEY';
const USER_ENV_VAR = 'MIDBRAIN_USER_API_KEY';

/** Opt-in strict mode refuses the fallback instead of warning about it. */
function projectKeyRequired(dir, issue) {
  const err = new Error(
    `No usable project key found under "${dir}" and ${STRICT_PROJECT_ENV}=1` +
    (issue ? ` (an unusable key file was skipped: ${issue})` : '') +
    ': not falling back to the client or global key. Run memory_setup_project ' +
    `in the project root, or unset ${STRICT_PROJECT_ENV}.`,
  );
  err.code = 'PROJECT_KEY_REQUIRED';
  return err;
}

async function inspectScope(scope, reader, configured = true) {
  if (!configured) return { scope, status: 'not configured' };
  try {
    const result = await reader();
    return result ? { scope, status: 'present', ...result } : { scope, status: 'absent' };
  } catch (err) {
    // Never surface raw fs-error text: it can embed a username-bearing absolute
    // path. Emit a fixed, path-free reason label instead (privacy contract).
    return { scope, status: 'error', reason: classifyScopeError(err) };
  }
}

/**
 * Read a key file. Returns trimmed content, or null on ENOENT.
 * Throws on EACCES (permission denied), empty file, or other read errors.
 */
export async function readKeyFile(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'EACCES') throw new Error(`Permission denied reading key file: ${filePath}`, { cause: err });
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const key = raw.trim();
  if (!key) throw new Error(`Key file is empty: ${filePath}`);
  return key;
}

/** The project key in one directory: `.midbrain/.midbrain-key`, then the flat file. */
export async function readProjectKeyIn(projDir) {
  const subPath = join(projDir, MIDBRAIN_DIR, KEY_FILENAME);
  const subKey = await readKeyFile(subPath);
  if (subKey) return { key: subKey, source: subPath };

  const flatPath = join(projDir, KEY_FILENAME);
  const flatKey = await readKeyFile(flatPath);
  if (flatKey) return { key: flatKey, source: flatPath };

  return null;
}

export class BaseClient {
  /** @returns {string} Machine-readable identifier ("opencode", "claude", "codex") */
  get id() { throw new Error("BaseClient.id not implemented"); }

  /** @returns {string} Human-readable name for user-facing output */
  get displayName() { throw new Error("BaseClient.displayName not implemented"); }

  /** @returns {boolean} Whether this client is installed on the system */
  isInstalled() { throw new Error("BaseClient.isInstalled not implemented"); }

  /**
   * Resolves the API key from this client's own storage.
   * Override in concrete clients (OpenCode, Claude) to check client-specific
   * key file locations. Default returns null (no client-specific key).
   * @returns {Promise<{key: string, source: string} | null>}
   */
  async resolveClientKey() { return null; }

  /**
   * Resolves the API key using the standard priority chain:
   *   1. Project key: <dir>/.midbrain/.midbrain-key, then <dir>/.midbrain-key,
   *      for the project directory and each parent up to the home directory
   *      or the filesystem root, plus a linked git worktree's main root
   *      (see projectRootCandidates in shared/project-dir.mjs)
   *   2. Client's own storage (resolveClientKey())
   *   3. Global (~/.config/midbrain/.midbrain-key)
   *   4. MIDBRAIN_API_KEY env var
   *
   * With MIDBRAIN_STRICT_PROJECT=1 a project directory without a key is an
   * error (code PROJECT_KEY_REQUIRED) instead of a fallthrough.
   *
   * @param {string} [projectDir] - Explicit project directory (overrides MIDBRAIN_PROJECT_DIR env).
   * @param {{includeScope?: boolean, skipProject?: boolean}} [opts] - `includeScope`
   * adds the selected resolution scope (and, for a project key, the directory
   * it was found in) for installer bookkeeping without bypassing this
   * resolver. `skipProject` resolves the client/global chain only, ignoring
   * both the argument and MIDBRAIN_PROJECT_DIR.
   * @returns {Promise<{key: string, source: string, scope?: string, projectRoot?: string} | null>}
   */
  async resolveKey(projectDir, { includeScope = false, skipProject = false } = {}) {
    const project = skipProject ? { dir: undefined, unresolved: false } : effectiveProjectDir(projectDir);
    if (project.unresolved) {
      console.error(
        'WARN: MIDBRAIN_PROJECT_DIR TERMINAL_CWD placeholder is unresolved (${TERMINAL_CWD}); falling through to global key.',
      );
    }
    // Bookkeeping for includeScope callers: the directory asked for, and the
    // first unusable key file the walk skipped, so diagnostics can show both.
    const context = { projectDir: project.dir };
    if (project.dir) {
      const { found, issue } = await this.#resolveProjectKey(project.dir);
      if (issue) context.projectKeyIssue = issue;
      if (found) {
        const { root, ...key } = found;
        return includeScope ? { ...key, scope: 'project', projectRoot: root, ...context } : key;
      }
      if (isStrictProject()) throw projectKeyRequired(project.dir, issue);
      console.error(
        `WARN: no project key found in "${project.dir}" or its parent directories, falling through to global key.`,
      );
    }

    const own = await this.resolveClientKey();
    if (own) return includeScope ? { ...own, scope: 'client', ...context } : own;

    const global_ = await this.#resolveGlobalKey();
    if (global_) return includeScope ? { ...global_, scope: 'global', ...context } : global_;

    if (process.env[ENV_VAR]) {
      const key = process.env[ENV_VAR].trim();
      if (key) {
        const result = { key, source: `env:${ENV_VAR}` };
        return includeScope ? { ...result, scope: 'environment', ...context } : result;
      }
    }

    return null;
  }

  /**
   * Inspect credential presence after normal resolution without exposing key
   * material. Lower-priority inspection errors never change the winner.
   * @param {string} [projectDir]
   * @param {{key: string, source: string, scope: string}} resolved
   */
  async inspectCredentialScopes(projectDir, resolved) {
    const project = effectiveProjectDir(projectDir);
    // resolveKey already walked the project directory tree for `resolved`:
    // a project winner is the project entry, an unusable file it skipped is
    // the error entry, and any other winner means the walk found nothing.
    const projectEntry = resolved.projectKeyIssue
      ? { scope: 'project', status: 'error', reason: resolved.projectKeyIssue }
      : await inspectScope('project', async () => (
        resolved.scope === 'project' ? { key: resolved.key, source: resolved.source } : null
      ), Boolean(project.dir));
    const candidates = [
      projectEntry,
      await inspectScope('client', () => this.resolveClientKey()),
      await inspectScope('global', () => this.#resolveGlobalKey()),
      await inspectScope('environment', async () => {
        const key = process.env[ENV_VAR]?.trim();
        return key ? { key, source: `env:${ENV_VAR}` } : null;
      }),
    ];
    const globalKey = candidates.find((entry) => entry.scope === 'global')?.key;
    const shadowNote = credentialShadowNote(resolved.scope, resolved.key, globalKey);
    const entries = candidates.map(({ key, ...entry }) => ({
      ...entry,
      winner: entry.scope === resolved.scope && entry.source === resolved.source,
      // A client or environment key equal to the global key means a fallback
      // capture lands in the main agent; diagnostics says so without seeing
      // either key.
      ...(['client', 'environment'].includes(entry.scope) && key && globalKey
        ? { sameAsGlobal: sameCredential(key, globalKey) }
        : {}),
    }));
    return { entries, shadowNote };
  }

  /**
   * The nearest project key for work started in `startDir`, with the
   * directory it sits in. A broken key file (empty, unreadable) in the
   * directory the client named is a hard error, as before; one higher up the
   * tree may not even be this user's, so it is skipped with a warning.
   */
  async #resolveProjectKey(startDir) {
    let first = true;
    let issue;
    for await (const dir of walkProjectRoots(startDir)) {
      try {
        const key = await readProjectKeyIn(dir);
        if (key) return { found: { ...key, root: dir }, issue };
      } catch (err) {
        if (first) throw err;
        const reason = classifyScopeError(err);
        issue ??= reason;
        console.error(`WARN: ignoring an unusable project key file in "${dir}" (${reason}); continuing the search.`);
      }
      first = false;
    }
    return { found: null, issue };
  }

  async #resolveGlobalKey() {
    const globalPath = join(globalConfigDir(), KEY_FILENAME);
    const key = await readKeyFile(globalPath);
    return key ? { key, source: globalPath } : null;
  }

  /**
   * Resolve the account-level user API key. This is a global credential (used
   * to mint agents and agent keys) and is intentionally NOT project-scoped.
   *
   * Priority:
   *   1. MIDBRAIN_USER_API_KEY env var
   *   2. ~/.config/midbrain/.midbrain-keystore.json user_key
   *
   * @returns {Promise<{key: string, source: string} | null>}
   */
  async resolveUserKey() {
    if (process.env[USER_ENV_VAR]) {
      const key = process.env[USER_ENV_VAR].trim();
      if (key) return { key, source: `env:${USER_ENV_VAR}` };
    }
    const globalDir = globalConfigDir();
    const ks = await readKeystore(join(globalDir, KEYSTORE_FILENAME));
    if (ks) {
      const key = getUserKey(ks);
      if (key) return { key, source: join(globalDir, KEYSTORE_FILENAME) };
    }
    return null;
  }

  /** @deprecated Credential fragments must not be included in output. */
  static maskKey(key) {
    if (!key || key.length < 4) return '****';
    return `...${key.slice(-4)}`;
  }

  async writeKey(_key) { throw new Error("BaseClient.writeKey not implemented"); }
  async installGlobal(_opts) { throw new Error("BaseClient.installGlobal not implemented"); }
  async installProject(_projectDir, _opts) { throw new Error("BaseClient.installProject not implemented"); }
  projectConfigFiles(_projectDir) { throw new Error("BaseClient.projectConfigFiles not implemented"); }
}
