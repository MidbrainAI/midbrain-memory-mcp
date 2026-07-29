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

const TEST_SANDBOX_ENV = 'MIDBRAIN_TEST_SANDBOX';
const CLIENT_IDS = new Set(['opencode', 'claude', 'codex', 'nanoclaw', 'hermes']);
const CORRUPT_KEY_RE = /[\0\uFFFD]/;
const FILE_MODE = 0o600;
const REAL_HOME = os.userInfo().homedir;

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
  const unsafeRoot = isWithin(sandboxPath, realHome);
  const unsafeTarget = isWithin(target, realHome) || !isWithin(target, sandboxPath);
  if (unsafeRoot || unsafeTarget) {
    throw new CredentialWriteRefusedError(
      `Credential write refused outside a safe test sandbox: ${targetPath}`,
      { category: 'test-sandbox-escape', targetPath },
    );
  }
}

function expectedTarget(clientId, scope, projectDir) {
  if (scope === 'global' && clientId === 'generic') {
    return path.join(os.homedir(), '.config', 'midbrain', KEY_FILENAME);
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

async function atomicWrite(targetPath, key) {
  const tempPath = `${targetPath}.tmp`;
  let handle;
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    handle = await fs.open(tempPath, 'wx', FILE_MODE);
    await handle.writeFile(`${key}\n`, 'utf8');
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
