/**
 * AC-15 (PRD-034 rev 3): the suite is independent of ambient client-path env.
 *
 * vitest.config.mjs injects poison HERMES_HOME/NANOCLAW_HOME into every
 * worker; tests/helpers/scrub-env.mjs must capture then delete them before
 * any test module loads. These assertions fail if either half breaks — on
 * every run, on every machine (the 2026-07 regression: `npm run check`
 * failed 33 tests whenever the shell had HERMES_HOME set).
 */

import { describe, it, expect } from "vitest";
import { SCRUBBED_ENV_KEYS } from "./helpers/scrub-env.mjs";

describe("suite env isolation (AC-15)", () => {
  it("the config's poison env reached this worker and was scrubbed before tests", () => {
    const snapshot = globalThis.__MIDBRAIN_SCRUB_SNAPSHOT__;
    expect(snapshot).toBeDefined();
    expect(snapshot.HERMES_HOME).toBe("/nonexistent/midbrain-poison/hermes");
    expect(snapshot.NANOCLAW_HOME).toBe("/nonexistent/midbrain-poison/nanoclaw");
  });

  it("every scrubbed key is absent when tests run", () => {
    for (const key of SCRUBBED_ENV_KEYS) {
      expect(process.env[key], `ambient ${key} leaked into the test worker`).toBeUndefined();
    }
  });
});
