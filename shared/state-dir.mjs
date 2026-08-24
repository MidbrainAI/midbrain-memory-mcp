/**
 * shared/state-dir.mjs
 *
 * Single resolver for the base directory of MidBrain's durable local state:
 * the hook shim, the global API key + keystore, the host config.json, and the
 * offline episodic cache.
 *
 * By default these live in their historical, distinct locations
 * (~/.midbrain/bin, ~/.config/midbrain, ~/.cache/midbrain). Setting
 * MIDBRAIN_STATE_DIR relocates ALL of them under one base directory, so they
 * can be placed on a durable mount.
 *
 * The motivating case is NanoClaw: only ~/.claude (the .claude-shared mount)
 * survives a cold --rm container spawn. Pointing MIDBRAIN_STATE_DIR at
 * /home/node/.claude/.midbrain makes the shim and key persist across spawns —
 * closing both the shim-missing and key-missing races that lose the
 * conversation opener (issue #52) — with NO NanoClaw change.
 *
 * OPT-IN contract: when MIDBRAIN_STATE_DIR is unset (or blank), every accessor
 * returns exactly the historical path, so non-NanoClaw host installs are
 * byte-identical. Modeled on logger.mjs logDir()/MIDBRAIN_LOG_DIR.
 *
 * The base is chosen so the shim path keeps the ".midbrain/bin/<client>-hook"
 * tail that commandReferencesShim() (shared/clients/shim.mjs) matches on, so
 * hook-ownership recognition and self-repair rewrite need no changes.
 */

import os from "os";
import path from "path";

const STATE_DIR_ENV = "MIDBRAIN_STATE_DIR";

/** The override base directory, or null when unset/blank. */
export function stateBaseDir() {
  const raw = process.env[STATE_DIR_ENV];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

export function isStateDirOverridden() {
  return stateBaseDir() !== null;
}

/** Durable state root available inside NanoClaw's mounted Claude directory. */
export function nanoClawStateDir() {
  return path.join(os.homedir(), ".claude", ".midbrain");
}

/**
 * Activate NanoClaw's durable state root for this process only. An explicit
 * nonblank operator value always wins.
 */
export function activateNanoClawStateDir() {
  const existing = stateBaseDir();
  if (existing) return existing;
  const inferred = nanoClawStateDir();
  process.env[STATE_DIR_ENV] = inferred;
  return inferred;
}

/**
 * Directory holding the global key, keystore, and host config.json.
 * Default: ~/.config/midbrain. Override: <MIDBRAIN_STATE_DIR>.
 */
export function globalConfigDir() {
  return stateBaseDir() ?? path.join(os.homedir(), ".config", "midbrain");
}

/**
 * Directory holding the stable hook shims.
 * Default: ~/.midbrain/bin. Override: <MIDBRAIN_STATE_DIR>/bin.
 *
 * The override keeps a `bin` leaf so that, with a `.midbrain`-suffixed base
 * (the documented /home/node/.claude/.midbrain), the full path retains the
 * `.midbrain/bin/<client>-hook` tail matched by commandReferencesShim().
 */
export function shimBinDir() {
  const base = stateBaseDir();
  return base ? path.join(base, "bin") : path.join(os.homedir(), ".midbrain", "bin");
}

/**
 * Directory holding the offline episodic cache.
 * Default: ~/.cache/midbrain. Override: <MIDBRAIN_STATE_DIR>/cache.
 */
export function cacheDir() {
  const base = stateBaseDir();
  return base ? path.join(base, "cache") : path.join(os.homedir(), ".cache", "midbrain");
}
