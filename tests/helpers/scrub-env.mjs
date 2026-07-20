/**
 * Worker-level ambient-environment scrub (PRD-034 rev 3, AC-15).
 *
 * The suite must behave identically on every machine, whatever client-path
 * env the developer's shell carries (HERMES_HOME, NANOCLAW_HOME, XDG dirs,
 * npm cache, MIDBRAIN_*). vitest.config.mjs deliberately injects poison
 * values for the highest-risk keys into every worker; this setup file runs
 * before each test file and deletes the whole set — so a green suite proves
 * ambient independence on every run, not only on machines that happen to
 * have the vars set.
 *
 * The tripwire globalSetup runs in the vitest MAIN process, which this file
 * never touches — it keeps seeing the true ambient env and watches the real
 * home surfaces.
 */

export const SCRUBBED_ENV_KEYS = [
  'HERMES_HOME',
  'NANOCLAW_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'npm_config_cache',
  'MIDBRAIN_LOG_DIR',
  'MIDBRAIN_PROJECT_DIR',
  'MIDBRAIN_CLIENT',
  'MIDBRAIN_CONFIG_DIR',
  'MIDBRAIN_API_KEY',
  'MIDBRAIN_ENABLE_PK_INJECTION',
  'MIDBRAIN_DEV',
  'CI',
];

// First-evaluation snapshot per worker, before scrubbing: proves both that
// the config's poison injection reached the worker AND that the scrub ran
// (asserted by tests/env-isolation.test.mjs, order-independent).
if (!globalThis.__MIDBRAIN_SCRUB_SNAPSHOT__) {
  globalThis.__MIDBRAIN_SCRUB_SNAPSHOT__ = Object.fromEntries(
    SCRUBBED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
}

for (const key of SCRUBBED_ENV_KEYS) {
  delete process.env[key];
}
