/** One terminal at-most-once claim for the legacy NanoClaw opener fallback. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RECOVERY_DIR = ".midbrain-legacy-opener";
const RECEIPT_FILE = "recovered";

function claudeDir() {
  return path.join(os.homedir(), ".claude");
}

function recoveryDir() {
  return path.join(claudeDir(), RECOVERY_DIR);
}

export function legacyOpenerReceiptPath() {
  return path.join(recoveryDir(), RECEIPT_FILE);
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function validDirectory(target, expected, mode) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (expected && !sameIdentity(stat, expected)) return false;
    if (mode !== undefined && process.platform !== "win32" && (stat.mode & 0o777) !== mode) return false;
    return Boolean(fs.realpathSync(target));
  } catch {
    return false;
  }
}

function recoveryDirectoryIsContained() {
  try {
    return path.dirname(fs.realpathSync(recoveryDir())) === fs.realpathSync(claudeDir());
  } catch {
    return false;
  }
}

function ensureRecoveryDirectory() {
  const root = claudeDir();
  if (!validDirectory(root)) return null;
  const rootStat = fs.lstatSync(root);
  const dir = recoveryDir();
  let created = false;
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") return null;
  }
  if (created && process.platform !== "win32") {
    try { fs.chmodSync(dir, 0o700); } catch { return null; }
  }
  if (!validDirectory(root, rootStat) || !validDirectory(dir, undefined, 0o700) ||
      !recoveryDirectoryIsContained()) return null;
  const dirStat = fs.lstatSync(dir);
  return { root, rootStat, dir, dirStat };
}

function openDirectory(target) {
  if (process.platform === "win32") return null;
  const flags = fs.constants.O_RDONLY |
    (fs.constants.O_DIRECTORY ?? 0) |
    (fs.constants.O_NOFOLLOW ?? 0);
  return fs.openSync(target, flags);
}

function pathMatchesFile(target, expected) {
  try {
    const current = fs.lstatSync(target);
    return current.isFile() && !current.isSymbolicLink() && sameIdentity(current, expected);
  } catch {
    return false;
  }
}

function validateParents(state) {
  return validDirectory(state.root, state.rootStat) &&
    validDirectory(state.dir, state.dirStat, 0o700) && recoveryDirectoryIsContained();
}

/**
 * Claim the sole recovery attempt. The pathname checks bound the observable
 * pre/post identities; Node has no descriptor-relative openat primitive, so
 * same-user intermediate-directory ABA remains outside this fallback's model.
 */
export function claimLegacyOpenerRecovery() {
  const state = ensureRecoveryDirectory();
  if (!state) return false;
  let receiptFd;
  let dirFd;
  try {
    if (!validateParents(state)) return false;
    dirFd = openDirectory(state.dir);
    if (dirFd !== null) {
      const openedDir = fs.fstatSync(dirFd);
      if (!openedDir.isDirectory() || !sameIdentity(openedDir, state.dirStat)) return false;
    }
    const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW ?? 0);
    receiptFd = fs.openSync(legacyOpenerReceiptPath(), flags, 0o600);
    if (process.platform !== "win32") fs.fchmodSync(receiptFd, 0o600);
    const receiptStat = fs.fstatSync(receiptFd);
    if (!receiptStat.isFile() || receiptStat.size !== 0) return false;
    fs.fsyncSync(receiptFd);
    if (!pathMatchesFile(legacyOpenerReceiptPath(), receiptStat) || !validateParents(state)) return false;
    if (dirFd !== null) fs.fsyncSync(dirFd);
    return pathMatchesFile(legacyOpenerReceiptPath(), receiptStat) && validateParents(state);
  } catch {
    return false;
  } finally {
    if (receiptFd !== undefined) {
      try { fs.closeSync(receiptFd); } catch { /* terminal receipt remains */ }
    }
    if (dirFd !== undefined && dirFd !== null) {
      try { fs.closeSync(dirFd); } catch { /* no recovery retry */ }
    }
  }
}
