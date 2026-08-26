/**
 * Guarded credential-file writer.
 *
 * This module is the only production path allowed to persist API keys.
 */

import fs from 'fs/promises';
import { constants as FS_CONSTANTS } from 'fs';
import os from 'os';
import path from 'path';
import { readKeyFile } from './base.mjs';
import { KEY_FILENAME, MIDBRAIN_DIR } from './utils.mjs';
import { globalConfigDir } from '../state-dir.mjs';

const TEST_SANDBOX_ENV = 'MIDBRAIN_TEST_SANDBOX';
const CLIENT_IDS = new Set(['opencode', 'claude', 'codex', 'nanoclaw', 'hermes']);
const CORRUPT_KEY_RE = /[\0\uFFFD]/;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const KEYSTORE_FILENAME = '.midbrain-keystore.json';

// The real user home is resolved independently of HOME/USERPROFILE overrides so
// the test guard can reject a sandbox that would encompass the developer's
// actual credential locations. os.userInfo() can throw on passwd-less
// containers/CI, so fall back to os.homedir() rather than crashing at import.
function realHomeDir() {
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}
const REAL_HOME = realHomeDir();

export class CredentialWriteError extends Error {
  constructor(message, { category, targetPath, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.category = category;
    this.targetPath = targetPath;
  }
}

export class CredentialWriteRefusedError extends CredentialWriteError {}
export class CredentialTargetError extends CredentialWriteError {}
export class CredentialReadError extends CredentialWriteError {}
export class CredentialReplaceNotApprovedError extends CredentialWriteError {}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function prospectiveRealpath(filePath) {
  const missing = [];
  let cursor = path.resolve(filePath);
  while (true) {
    try {
      const resolved = await fs.realpath(cursor);
      return path.join(resolved, ...missing.reverse());
    } catch (err) {
      if (err.code !== 'ENOENT') {
        const category = err.code === 'EACCES' ? 'permission-denied' : 'path-resolution-failed';
        throw new CredentialWriteError(
          `Cannot resolve credential path (${category}): ${filePath}`,
          { category, targetPath: filePath, cause: err },
        );
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw err;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function enforceTestGuard(targetPath) {
  const sandbox = process.env[TEST_SANDBOX_ENV]?.trim();
  if (process.env.VITEST && !sandbox) {
    throw new CredentialWriteRefusedError(
      `Credential write refused in Vitest without ${TEST_SANDBOX_ENV}: ${targetPath}`,
      { category: 'test-sandbox-missing', targetPath },
    );
  }
  if (!sandbox) return;

  const [sandboxPath, target, realHome] = await Promise.all([
    prospectiveRealpath(sandbox),
    prospectiveRealpath(targetPath),
    prospectiveRealpath(REAL_HOME),
  ]);
  // A sandbox is unsafe only when it is broad enough to encompass the real
  // user home (sandbox === home, or home nested under it) — that is what would
  // let a test reach real credentials. We must NOT reject a sandbox merely for
  // living under the home tree: on Windows/macOS os.tmpdir() is itself nested
  // in the user profile, so a legitimate temp sandbox is routinely under home.
  const unsafeSandbox = isWithin(realHome, sandboxPath);
  // The target must resolve inside the declared sandbox.
  const unsafeTarget = !isWithin(target, sandboxPath);
  if (unsafeSandbox || unsafeTarget) {
    throw new CredentialWriteRefusedError(
      `Credential write refused outside a safe test sandbox: ${targetPath}`,
      { category: 'test-sandbox-escape', targetPath },
    );
  }
}

function expectedTarget(clientId, scope, projectDir) {
  if (scope === 'global' && clientId === 'generic') {
    // Honors MIDBRAIN_STATE_DIR in lockstep with the writers (Generic.writeKey,
    // ensureHookCredential) so a relocated global key write is not refused.
    return path.join(globalConfigDir(), KEY_FILENAME);
  }
  if (scope === 'client' && CLIENT_IDS.has(clientId)) {
    return path.join(os.homedir(), '.config', clientId, KEY_FILENAME);
  }
  if (scope === 'project' && clientId === 'generic' && path.isAbsolute(projectDir || '')) {
    return path.join(path.resolve(projectDir), MIDBRAIN_DIR, KEY_FILENAME);
  }
  return null;
}

async function validateTarget(clientId, scope, targetPath, projectDir) {
  const expected = expectedTarget(clientId, scope, projectDir);
  if (!expected || await prospectiveRealpath(expected) !== await prospectiveRealpath(targetPath)) {
    throw new CredentialTargetError(
      `Credential target does not match ${clientId}/${scope}: ${targetPath}`,
      { category: 'invalid-target', targetPath },
    );
  }
}

async function readExisting(targetPath) {
  try {
    const existing = await readKeyFile(targetPath);
    if (existing && CORRUPT_KEY_RE.test(existing)) {
      throw new CredentialReadError(`Credential file is corrupt: ${targetPath}`, {
        category: 'corrupt',
        targetPath,
      });
    }
    return existing;
  } catch (err) {
    if (err instanceof CredentialReadError) throw err;
    const permissionDenied = err.code === 'EACCES' || err.cause?.code === 'EACCES';
    const category = permissionDenied
      ? 'permission-denied'
      : err.message.startsWith('Key file is empty:')
        ? 'empty'
        : 'unreadable';
    throw new CredentialReadError(`Cannot read credential file (${category}): ${targetPath}`, {
      category,
      targetPath,
      cause: err,
    });
  }
}

/**
 * Atomically write exact bytes to `targetPath` with mode 0600 from the first
 * byte, creating the parent directory (0700), via a temp file + rename.
 * @param {string} targetPath
 * @param {string} contents
 */
async function atomicWriteBytes(targetPath, contents) {
  const tempPath = `${targetPath}.tmp`;
  let handle;
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: DIR_MODE });
    handle = await fs.open(tempPath, 'wx', FILE_MODE);
    await handle.writeFile(contents, 'utf8');
    await handle.chmod(FILE_MODE);
    await handle.close();
    handle = null;
    await fs.rename(tempPath, targetPath);
  } catch (err) {
    await handle?.close().catch(() => {});
    if (handle !== undefined) await fs.rm(tempPath, { force: true }).catch(() => {});
    const category = err.code === 'EACCES' ? 'permission-denied' : 'write-failed';
    throw new CredentialWriteError(`Failed to write credential file: ${targetPath}`, {
      category,
      targetPath,
      cause: err,
    });
  }
}

async function atomicWrite(targetPath, key) {
  await atomicWriteBytes(targetPath, `${key}\n`);
}

function backupTimestamp(now) {
  return new Date(now).toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Copy a credential to a collision-safe timestamped mode-0600 backup.
 *
 * @param {string} targetPath
 * @param {{now?: Date|number|string}} [opts]
 * @returns {Promise<string>}
 */
export async function backupCredential(targetPath, { now = Date.now() } = {}) {
  const basePath = `${targetPath}.bak-${backupTimestamp(now)}`;
  for (let suffix = 1; ; suffix += 1) {
    const backupPath = suffix === 1 ? basePath : `${basePath}-${suffix}`;
    try {
      await fs.copyFile(targetPath, backupPath, FS_CONSTANTS.COPYFILE_EXCL);
      await fs.chmod(backupPath, FILE_MODE);
      return backupPath;
    } catch (err) {
      if (err.code === 'EEXIST') continue;
      await fs.rm(backupPath, { force: true }).catch(() => {});
      throw new CredentialWriteError(`Failed to back up credential file: ${targetPath}`, {
        category: 'backup-failed',
        targetPath,
        cause: err,
      });
    }
  }
}

/**
 * Persist one API key through scope validation, replacement approval, and an
 * atomic mode-0600 rename.
 *
 * @param {object} input
 * @param {string} input.clientId
 * @param {'client'|'global'|'project'} input.scope
 * @param {string} input.targetPath
 * @param {string} [input.projectDir]
 * @param {string} input.key
 * @param {boolean} [input.replaceApproved]
 * @returns {Promise<{action: 'written'|'unchanged', backupPath: string|null}>}
 */
export async function writeCredential({
  clientId,
  scope,
  targetPath,
  projectDir,
  key,
  replaceApproved = false,
}) {
  await enforceTestGuard(targetPath);
  await validateTarget(clientId, scope, targetPath, projectDir);
  const normalizedKey = typeof key === 'string' ? key.trim() : '';
  if (!normalizedKey || CORRUPT_KEY_RE.test(normalizedKey)) {
    throw new CredentialWriteError(`Credential value is invalid for: ${targetPath}`, {
      category: 'invalid-key',
      targetPath,
    });
  }

  const existing = await readExisting(targetPath);
  if (existing === normalizedKey) return { action: 'unchanged', backupPath: null };
  if (existing !== null && !replaceApproved) {
    throw new CredentialReplaceNotApprovedError(
      `Credential replacement requires explicit approval: ${targetPath}`,
      { category: 'replacement-not-approved', targetPath },
    );
  }

  const backupPath = existing === null ? null : await backupCredential(targetPath);
  await atomicWrite(targetPath, normalizedKey);
  return { action: 'written', backupPath };
}

/** The only permitted keystore target: the global keystore path. */
function expectedKeystorePath() {
  return path.join(globalConfigDir(), KEYSTORE_FILENAME);
}

/**
 * Reject a target that is itself a symlink (an attacker-planted
 * `.midbrain-keystore.json` symlink must not redirect a 0600 write onto an
 * unrelated file). Missing target is fine (first write).
 */
async function rejectSymlinkTarget(targetPath) {
  let stat;
  try {
    stat = await fs.lstat(targetPath);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw new CredentialWriteError(`Cannot stat keystore target: ${targetPath}`, {
      category: 'path-resolution-failed', targetPath, cause: err,
    });
  }
  if (stat.isSymbolicLink()) {
    throw new CredentialTargetError(`Keystore target is a symlink (refused): ${targetPath}`, {
      category: 'symlink-target', targetPath,
    });
  }
}

/**
 * Persist a structured keystore object through the same guarded path as key
 * files: test-sandbox guard, canonical-target validation, symlink rejection,
 * 0700 parent dir, atomic mode-0600 write, and a backup before replacement.
 *
 * Unlike writeCredential (single-line key files), this always overwrites in
 * place — a keystore is a mutable structured document — but still backs up the
 * previous file first. Callers should read-modify-write to avoid clobbering.
 *
 * @param {string} targetPath  Must equal the global keystore path.
 * @param {object} data        Keystore object (serialized as pretty JSON).
 * @returns {Promise<{action: 'written', backupPath: string|null}>}
 */
export async function writeKeystoreFile(targetPath, data) {
  await enforceTestGuard(targetPath);

  const expected = expectedKeystorePath();
  if (await prospectiveRealpath(expected) !== await prospectiveRealpath(targetPath)) {
    throw new CredentialTargetError(
      `Keystore target does not match the global keystore path: ${targetPath}`,
      { category: 'invalid-target', targetPath },
    );
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new CredentialWriteError(`Keystore payload must be a JSON object: ${targetPath}`, {
      category: 'invalid-keystore', targetPath,
    });
  }

  await rejectSymlinkTarget(targetPath);

  let existed = true;
  try {
    await fs.access(targetPath);
  } catch {
    existed = false;
  }
  const backupPath = existed ? await backupCredential(targetPath) : null;
  await atomicWriteBytes(targetPath, `${JSON.stringify(data, null, 2)}\n`);
  return { action: 'written', backupPath };
}
