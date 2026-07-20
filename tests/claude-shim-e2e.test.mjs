/**
 * AC-9 (PRD-034): end-to-end capture through the real claude-hook shim file.
 *
 * Spawns /bin/sh on the actual installed shim in a sandbox home. The shim body
 * is the dev variant (pointing at this checkout) so the chain is fully
 * hermetic: sh shim -> node index.js hook claude <role> -> capture script ->
 * MidbrainApi -> fetch (stubbed via NODE_OPTIONS --import, logged to a file).
 *
 * Asserts: hook fires, capture script resolves, episodic POST observed,
 * exit 0, stdout EMPTY with PK off, stderr free of unexpected lines (a
 * project key is seeded so no key-fallthrough warning fires).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "node:url";

import { makeTestEnv } from "./helpers/test-env.mjs";
import { installShim, stableShimPath, isDevShimContent } from "../shared/clients/shim.mjs";

const IS_WIN = process.platform === "win32";

let env;
let projectDir;
let fetchLog;

beforeEach(async () => {
  env = await makeTestEnv();
  projectDir = path.join(env.home, "project");
  await fs.mkdir(path.join(projectDir, ".midbrain"), { recursive: true });
  await fs.writeFile(path.join(projectDir, ".midbrain", ".midbrain-key"), "test-key-claude-e2e\n", { mode: 0o600 });
  fetchLog = path.join(env.tmp, "fetch-log.ndjson");

  const preload = path.join(env.tmp, "fetch-preload.mjs");
  await fs.writeFile(preload, `
    import fs from "node:fs";
    globalThis.fetch = async (url, opts = {}) => {
      const headers = opts.headers || {};
      const record = {
        url: String(url),
        hasAuth: typeof headers.Authorization === "string" && headers.Authorization.length > 0,
        body: opts.body ? JSON.parse(opts.body) : undefined,
      };
      fs.appendFileSync(process.env.MIDBRAIN_TEST_FETCH_LOG, JSON.stringify(record) + "\\n");
      if (String(url).includes("/memories/episodic")) {
        return { ok: true, status: 201, text: async () => "", json: async () => ({}) };
      }
      return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
    };
  `);
  env.preloadUrl = pathToFileURL(preload).href;

  await installShim("claude", { mode: "install", isDev: true });
});

afterEach(async () => {
  await env.restore();
});

async function readFetchLog() {
  try {
    return (await fs.readFile(fetchLog, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

function runShim(role, input) {
  return spawnSync("/bin/sh", [stableShimPath("claude"), role], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 30_000,
    env: env.childEnv({
      NODE_OPTIONS: `--import ${env.preloadUrl}`,
      MIDBRAIN_TEST_FETCH_LOG: fetchLog,
    }),
  });
}

describe.skipIf(IS_WIN)("AC-9 — claude-hook shim end-to-end (sandboxed)", () => {
  it("user role: captures the prompt via episodic POST; stdout empty; exit 0", async () => {
    const shimBody = await fs.readFile(stableShimPath("claude"), "utf8");
    expect(isDevShimContent(shimBody)).toBe(true); // hermetic dev body

    const result = runShim("user", { prompt: "e2e marker prompt PRD-034", cwd: projectDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    const badLines = (result.stderr || "").split("\n").filter((l) =>
      /WARN|falling through|Error|EACCES/i.test(l));
    expect(badLines).toEqual([]);

    const episodic = (await readFetchLog()).filter((r) => r.url.includes("/memories/episodic"));
    expect(episodic).toHaveLength(1);
    expect(episodic[0].hasAuth).toBe(true);
    expect(JSON.stringify(episodic[0].body)).toContain("e2e marker prompt PRD-034");
    expect(JSON.stringify(episodic[0].body)).toContain("claude");
  });

  it("assistant role: captures the final message; stdout empty; exit 0", async () => {
    const result = runShim("assistant", {
      last_assistant_message: "e2e assistant marker PRD-034",
      cwd: projectDir,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");

    const episodic = (await readFetchLog()).filter((r) => r.url.includes("/memories/episodic"));
    expect(episodic).toHaveLength(1);
    expect(JSON.stringify(episodic[0].body)).toContain("e2e assistant marker PRD-034");
  });

  it("shim exits 0 even when the hook cannot resolve a key (fail-open)", async () => {
    await fs.rm(path.join(projectDir, ".midbrain", ".midbrain-key"));

    const result = runShim("user", { prompt: "no key present", cwd: projectDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(await readFetchLog()).toEqual([]); // no capture without a key
  });
});
