/**
 * Suite-wide rule for issue #94: a spawned child must not inherit a MidBrain
 * credential or path override. In-process tests that write files stay on
 * makeTestEnv() or an explicit temp directory; those writes are the behavior
 * under test (permissions, atomic rename, JSONC). A filesystem mock in the
 * parent does not apply inside a spawned hook.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { makeTestEnv } from "./helpers/test-env.mjs";
import { sandboxedChildEnv } from "./helpers/sandboxed-child-env.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SPREAD = ["...", "process", ".env"].join("");

function testSources() {
  const files = [];
  for (const name of readdirSync(TESTS_DIR)) {
    if (!name.endsWith(".test.mjs") || name === "spawn-env-audit.test.mjs") continue;
    files.push(path.join(TESTS_DIR, name));
  }
  return files;
}

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

describe("makeTestEnv childEnv", () => {
  it("drops an inherited account key and restores it with the sandbox", async () => {
    process.env.MIDBRAIN_USER_API_KEY = "user-secret";
    const env = await makeTestEnv();
    try {
      expect(process.env.MIDBRAIN_USER_API_KEY).toBeUndefined();
      expect(env.childEnv()).not.toHaveProperty("MIDBRAIN_USER_API_KEY");
      expect(env.childEnv({ MIDBRAIN_USER_API_KEY: "explicit" }).MIDBRAIN_USER_API_KEY)
        .toBe("explicit");
    } finally {
      await env.restore();
    }
    expect(process.env.MIDBRAIN_USER_API_KEY).toBe("user-secret");
    delete process.env.MIDBRAIN_USER_API_KEY;
  });
});

describe("spawn sites", () => {
  it("does not copy process.env into a child", () => {
    const offenders = testSources()
      .filter((file) => readFileSync(file, "utf8").includes(SPREAD))
      .map((file) => path.basename(file));
    expect(offenders).toEqual([]);
  });

  it("sends Codex wrapper children through the sandbox helper", () => {
    const src = readFileSync(path.join(TESTS_DIR, "codex-hooks.test.mjs"), "utf8");
    const start = src.indexOf("function runSandboxedWrapper");
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start, start + 900)).toContain("sandboxedChildEnv");
    expect(src).toMatch(/runSandboxedWrapper\(\s*"capture-assistant\.mjs"/);
    expect(src).toMatch(/runSandboxedWrapper\(\s*"capture-tool\.mjs"/);
  });
});
