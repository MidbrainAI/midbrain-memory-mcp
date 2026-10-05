/**
 * Environment for a spawned test process.
 *
 * Copying process.env is not a sandbox: the worker scrub runs in the parent,
 * and a key or path override set later (or one the scrub list misses) is
 * inherited by the child. Drop that set again at the spawn, then apply the
 * caller's overrides, so the child cannot resolve a real credential or a real
 * MidBrain path unless the test passes that value on purpose.
 */

import { createRequire } from "node:module";
import path from "node:path";

import { SCRUBBED_ENV_KEYS } from "./scrub-env.mjs";

// The real builtin through CJS, so a Vitest ESM mock of "fs" in the calling
// test file cannot replace the helper's own writes.
const fs = createRequire(import.meta.url)("node:fs");

export const CHILD_ENV_DROPS = SCRUBBED_ENV_KEYS;

// install.mjs reads this throttle file from os.tmpdir(); a fresh one keeps a
// hook's self-update check off the npm registry.
const UPDATE_CACHE_FILENAME = ".midbrain-update-check.json";

export function sandboxedChildEnv(baseEnv, overrides = {}) {
  const env = { ...baseEnv };
  for (const key of CHILD_ENV_DROPS) delete env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/**
 * Seed a fresh update-check cache in `dir`, so a child whose os.tmpdir() is
 * `dir` finds the throttle fresh and never fetches the npm registry.
 */
export function seedUpdateCache(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, UPDATE_CACHE_FILENAME),
    JSON.stringify({ lastCheck: Date.now() }),
    "utf8",
  );
}

/**
 * Child env whose home, logs and temp all live under `home`; the key, cache
 * and shim directories follow HOME by default (MIDBRAIN_STATE_DIR stays unset
 * unless the caller passes it). The temp dir carries a fresh update-check
 * cache, so the child's throttled self-update neither fetches the registry nor
 * writes outside the sandbox. HOME and USERPROFILE are both set: os.homedir()
 * reads USERPROFILE on Windows.
 */
export function sandboxHomeEnv(home, overrides = {}) {
  const tmp = path.join(home, "tmp");
  seedUpdateCache(tmp);
  return sandboxedChildEnv(process.env, {
    HOME: home,
    USERPROFILE: home,
    MIDBRAIN_LOG_DIR: path.join(home, "logs"),
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    ...overrides,
  });
}
