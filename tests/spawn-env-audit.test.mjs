/**
 * Suite-wide rule for issue #94: a spawned child must not inherit a MidBrain
 * credential or path override. Every child-process call in the tests passes an
 * env built by the sandbox helpers, and no test source copies process.env into
 * a child. In-process tests that write files stay on makeTestEnv() or an
 * explicit temp directory; those writes are the behavior under test
 * (permissions, atomic rename, JSONC). A filesystem mock in the parent does not
 * apply inside a spawned hook.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { makeTestEnv } from "./helpers/test-env.mjs";
import { sandboxHomeEnv, sandboxedChildEnv } from "./helpers/sandboxed-child-env.mjs";

const SELF = fileURLToPath(import.meta.url);
const TESTS_DIR = path.dirname(SELF);
const CHILD_PROCESS_CALL = /(?<![\w.$])(spawnSync|spawn|execFileSync|execSync|execFile|exec|fork)\s*\(/g;
const ENV_OPTION = /(^|[\s,{])env\s*[:,}]/;

/** Every .mjs under tests/, helpers included, except this file. */
function testSources(dir = TESTS_DIR, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) testSources(file, out);
    else if (entry.name.endsWith(".mjs") && file !== SELF) out.push(file);
  }
  return out.sort();
}

/** The call's argument text, from the opening paren to its balanced close. */
function callArguments(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

/** Each child_process call in `src`: its 1-based line and argument text. */
function spawnSites(src) {
  const sites = [];
  for (const match of src.matchAll(CHILD_PROCESS_CALL)) {
    const open = match.index + match[0].length - 1;
    sites.push({ line: src.slice(0, match.index).split("\n").length, args: callArguments(src, open) });
  }
  return sites;
}

function withoutEnv(src) {
  return spawnSites(src).filter(({ args }) => !ENV_OPTION.test(args));
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

describe("makeTestEnv childEnv", () => {
  it("drops an inherited account key and restores it with the sandbox", async () => {
    const before = process.env.MIDBRAIN_USER_API_KEY;
    process.env.MIDBRAIN_USER_API_KEY = "user-secret";
    try {
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
    } finally {
      if (before === undefined) delete process.env.MIDBRAIN_USER_API_KEY;
      else process.env.MIDBRAIN_USER_API_KEY = before;
    }
  });
});

describe("spawn sites", () => {
  it("the scanner sees a child_process call without an env option", () => {
    const src = [
      'const a = spawnSync("bash", [script], { cwd, encoding: "utf8" });',
      "const b = spawn(cmd, [], { env: childEnv({ A: fn(1) }), stdio: \"pipe\" });",
      'execFileSync("mkfifo", [fifo]);',
      "const c = fakeSpawn(); deps.spawn || nodeSpawn;",
    ].join("\n");
    expect(spawnSites(src).map(({ line }) => line)).toEqual([1, 2, 3]);
    expect(withoutEnv(src).map(({ line }) => line)).toEqual([1, 3]);
  });

  it("every child_process call in a test passes an env", () => {
    const offenders = testSources().flatMap((file) =>
      withoutEnv(readFileSync(file, "utf8"))
        .map(({ line }) => `${path.relative(TESTS_DIR, file)}:${line}`));
    expect(offenders).toEqual([]);
  });

  it("no test source copies process.env into a child", () => {
    const offenders = testSources()
      .filter((file) => readFileSync(file, "utf8").includes("...process.env"))
      .map((file) => path.relative(TESTS_DIR, file));
    expect(offenders).toEqual([]);
  });
});
