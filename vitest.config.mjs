import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several e2e suites spawn real Node child processes (hooks, installer
    // dispatch) that also run the throttled self-update path. On loaded
    // Windows CI runners these legitimately exceed the 5s default and flake
    // with "Test timed out in 5000ms" (e.g. api-host-parity, opencode-plugins).
    // Raise the ceiling so runner slowness never masquerades as a failure;
    // fast tests are unaffected.
    testTimeout: 15000,
    hookTimeout: 15000,
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
