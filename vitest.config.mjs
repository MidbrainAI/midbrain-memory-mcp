import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PRD-034 S4: real-home hash tripwire. Runs in the vitest MAIN process
    // (real ambient env — watches the true real-home surfaces) and fails the
    // run if any enumerated surface drifted while the suite ran.
    globalSetup: ['./tests/helpers/global-tripwire.mjs'],
    // AC-15: inject poison client-path env into every WORKER; the scrub
    // setup below must delete it before any test module loads. A green suite
    // therefore proves ambient-env independence on every run, on every
    // machine — not only on shells that happen to export HERMES_HOME.
    env: {
      HERMES_HOME: '/nonexistent/midbrain-poison/hermes',
      NANOCLAW_HOME: '/nonexistent/midbrain-poison/nanoclaw',
    },
    setupFiles: ['./tests/helpers/scrub-env.mjs'],
  },
});
