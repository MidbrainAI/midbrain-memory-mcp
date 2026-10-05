/**
 * Suite-wide rule for issue #94: a spawned child must not inherit a MidBrain
 * credential or path override. The ESLint rule
 * scripts/eslint-rules/sandboxed-child-env.mjs, applied to tests/ by
 * eslint.config.js and run by `npm run check`, requires every child_process
 * call to pass an env built by a sandbox helper. This file proves that rule
 * is wired in and still catches the leak shapes, and that no test source
 * copies process.env at all. In-process tests that write files stay on
 * makeTestEnv() or an explicit temp directory; those writes are the behavior
 * under test (permissions, atomic rename, JSONC). A filesystem mock in the
 * parent does not apply inside a spawned hook.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { makeTestEnv } from "./helpers/test-env.mjs";

const SELF = fileURLToPath(import.meta.url);
const TESTS_DIR = path.dirname(SELF);
const REPO_ROOT = path.resolve(TESTS_DIR, "..");
const RULE = "midbrain/sandboxed-child-env";

/** Every .mjs under tests/, helpers included, except this file. */
function testSources(dir = TESTS_DIR, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) testSources(file, out);
    else if (entry.name.endsWith(".mjs") && file !== SELF) out.push(file);
  }
  return out.sort();
}

const eslint = new ESLint({ cwd: REPO_ROOT });

/** Lines the sandbox rule reports for a snippet linted as a test file. */
async function offendingLines(snippet) {
  const [result] = await eslint.lintText(
    `import { spawn, spawnSync, execFileSync } from "node:child_process";\n${snippet}\n`,
    { filePath: path.join(TESTS_DIR, "zz-rule-probe.test.mjs") },
  );
  return result.messages.filter((m) => m.ruleId === RULE).map((m) => m.line - 1);
}

describe("sandboxed-child-env ESLint rule", () => {
  it("is applied to test files and reports a spawn with no env or an inherited one", async () => {
    expect(await offendingLines([
      'spawnSync("bash", [script], { cwd, encoding: "utf8" });',
      'spawn("node", [script], { env: process.env });',
      'spawnSync("node", [script], { env: { ...process.env, HOME: home } });',
      'execFileSync("mkfifo", [fifo]);',
      'childProcess.spawnSync("node", [script], { encoding: "utf8" });',
      "const opts = { env: sandboxHomeEnv(home) }; spawnSync(cmd, [], opts);",
    ].join("\n"))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("accepts an env built by a sandbox helper, directly, through a variable, a wrapper or a parameter", async () => {
    expect(await offendingLines([
      'spawnSync("node", [script], { env: sandboxHomeEnv(home) });',
      'spawnSync("node", [script], { env: sandboxedChildEnv(process.env, { A: "1" }) });',
      'spawn("node", [script], { env: env.childEnv({ A: "1" }) });',
      "const built = sandboxHomeEnv(home); spawnSync(cmd, [], { env: built });",
      "function wrapped(extra) { return sandboxHomeEnv(home, extra); } spawnSync(cmd, [], { env: wrapped({}) });",
      "function run(script, env) { return spawn(cmd, [script], { env }); } run(s, env.childEnv());",
      // the same variable at two call sites, and a parameter fed from another parameter
      "const shared = env.childEnv(); run(a, shared); run(b, shared);",
      "function outer(script, env) { return run(script, env); } outer(s, sandboxHomeEnv(home));",
      "PATTERN.exec(text); api.exec(); fakeSpawn(); deps.spawn || nodeSpawn;",
    ].join("\n"))).toEqual([]);
  });

  it("rejects a parameter when any caller passes an inherited env", async () => {
    expect(await offendingLines([
      "function run(script, env) { return spawn(cmd, [script], { env }); }",
      "run(s, env.childEnv()); run(s, process.env);",
    ].join("\n"))).toEqual([1]);
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

describe("test sources", () => {
  it("never copy process.env", () => {
    const offenders = testSources()
      .filter((file) => readFileSync(file, "utf8").includes("...process.env"))
      .map((file) => path.relative(TESTS_DIR, file));
    expect(offenders).toEqual([]);
  });
});
