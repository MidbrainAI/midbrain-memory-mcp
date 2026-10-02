/**
 * Unit tests for the spawned-child env helpers (#88): a child built with them
 * inherits no MidBrain credential or path override, and its home, logs and
 * temp dir all live inside one sandbox directory.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { sandboxHomeEnv, sandboxedChildEnv } from "./helpers/sandboxed-child-env.mjs";

describe("sandboxedChildEnv", () => {
  it("drops inherited credentials and path overrides, then applies the sandbox", () => {
    const home = "/tmp/midbrain-child-home";
    const env = sandboxedChildEnv({
      PATH: "/usr/bin",
      HOME: "/real/home",
      USERPROFILE: "/real/home",
      MIDBRAIN_API_KEY: "secret-agent",
      MIDBRAIN_USER_API_KEY: "secret-user",
      MIDBRAIN_PROJECT_DIR: "/real/project",
      MIDBRAIN_CONFIG_DIR: "/real/midbrain-config",
      MIDBRAIN_STATE_DIR: "/real/state",
      MIDBRAIN_LOG_DIR: "/real/logs",
      XDG_CONFIG_HOME: "/real/config",
      XDG_STATE_HOME: "/real/xdg-state",
    }, {
      HOME: home,
      USERPROFILE: home,
      MIDBRAIN_LOG_DIR: `${home}/logs`,
      MIDBRAIN_STATE_DIR: `${home}/state`,
      MIDBRAIN_API_KEY: undefined,
    });

    expect(env.HOME).toBe(home);
    expect(env.USERPROFILE).toBe(home);
    expect(env.MIDBRAIN_LOG_DIR).toBe(`${home}/logs`);
    expect(env.MIDBRAIN_STATE_DIR).toBe(`${home}/state`);
    expect(env.PATH).toBe("/usr/bin");
    for (const key of [
      "MIDBRAIN_API_KEY",
      "MIDBRAIN_USER_API_KEY",
      "MIDBRAIN_PROJECT_DIR",
      "MIDBRAIN_CONFIG_DIR",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it("keeps an override the test passed on purpose", () => {
    const env = sandboxedChildEnv(
      { MIDBRAIN_API_KEY: "inherited", PATH: "/usr/bin" },
      { MIDBRAIN_API_KEY: "fixture-key" },
    );
    expect(env.MIDBRAIN_API_KEY).toBe("fixture-key");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("sandboxHomeEnv", () => {
  it("puts home, logs and temp under the sandbox home and seeds a fresh update cache", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "midbrain-sandbox-home-"));
    try {
      const env = sandboxHomeEnv(home, { MIDBRAIN_TEST_FETCH_MODE: "ok" });
      const tmp = path.join(home, "tmp");

      expect(env.HOME).toBe(home);
      expect(env.USERPROFILE).toBe(home);
      expect(env.MIDBRAIN_LOG_DIR).toBe(path.join(home, "logs"));
      // the key, cache and shim dirs resolve under HOME unless a test opts in
      expect(env).not.toHaveProperty("MIDBRAIN_STATE_DIR");
      expect([env.TMPDIR, env.TEMP, env.TMP]).toEqual([tmp, tmp, tmp]);
      expect(env.MIDBRAIN_TEST_FETCH_MODE).toBe("ok");
      expect(env).not.toHaveProperty("MIDBRAIN_API_KEY");

      const cache = JSON.parse(readFileSync(path.join(tmp, ".midbrain-update-check.json"), "utf8"));
      expect(Date.now() - cache.lastCheck).toBeLessThan(60_000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("lets an override win over the sandbox defaults", () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "midbrain-sandbox-home-"));
    try {
      const env = sandboxHomeEnv(home, { MIDBRAIN_STATE_DIR: "/elsewhere/state", TMPDIR: undefined });
      expect(env.MIDBRAIN_STATE_DIR).toBe("/elsewhere/state");
      expect(env).not.toHaveProperty("TMPDIR");
      expect(existsSync(path.join(home, "tmp"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
