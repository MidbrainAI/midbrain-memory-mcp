/**
 * PRD-039: NanoClaw container-topology regression (issue #46).
 *
 * The container reality this file reproduces: only ~/.claude is mounted and
 * durable, hook child processes receive NO MIDBRAIN_* env (childEnv() strips
 * it), no key file exists on any resolution path, and the only credential in
 * the container lives in the MCP server process env. v0.4.7's shim migration
 * dropped the inline hook key, so capture died silently fleet-wide.
 *
 * F1 under test: runSelfRepair() persists the server-env MIDBRAIN_API_KEY to
 * the global key file (absence-only, 0600, central credential writer) so a
 * subsequently spawned hook child resolves it — the self-heal path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "node:url";

import { makeTestEnv, assertSandboxed } from "./helpers/test-env.mjs";
import { runSelfRepair } from "../install.mjs";
import { installShim, stableShimPath, shellQuote } from "../shared/clients/shim.mjs";

const IS_WIN = process.platform === "win32";

const DURABLE = { context: { kind: "durable", path: "/durable/install" } };
const NPX_CTX = {
  context: { kind: "npx-cache", path: "/Users/u/.npm/_npx/abc123/node_modules/midbrain-memory-mcp" },
};

const TEST_KEY = "test-key-nanoclaw-prd039";

/** Post-0.4.7 fleet state: hooks already migrated to the canonical shim form. */
function migratedClaudeSettings() {
  const cmd = (role) => `${shellQuote(stableShimPath("claude"))} ${role}`;
  return {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: cmd("user"), timeout: 30 }] },
      ],
      Stop: [
        { hooks: [{ type: "command", command: cmd("assistant"), timeout: 30, async: true }] },
      ],
    },
  };
}

let env;
let errSpy;

beforeEach(async () => {
  env = await makeTestEnv({ clients: ["claude"] });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  errSpy.mockRestore();
  delete process.env.MIDBRAIN_API_KEY;
  delete process.env.MIDBRAIN_USER_API_KEY;
  await env.restore();
});

function stderrText() {
  return errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

async function readGlobalKey() {
  return fs.readFile(env.paths.globalKey, "utf8");
}

// ===================================================================
// F1 behavior matrix — startup hook-credential persistence
// ===================================================================

describe("PRD-039 F1 — ensureHookCredential matrix (runSelfRepair)", () => {
  it("persists the server-env key to the global file when absent (0600), sandboxed, scope-label-only log", async () => {
    process.env.MIDBRAIN_API_KEY = TEST_KEY;

    await runSelfRepair(NPX_CTX);

    await assertSandboxed(env, env.paths.globalKey);
    expect(await readGlobalKey()).toBe(`${TEST_KEY}\n`);
    if (!IS_WIN) {
      const { mode } = await fs.stat(env.paths.globalKey);
      expect(mode & 0o777).toBe(0o600);
    }
    expect(stderrText()).toContain("hook credential persisted (global scope)");
    expect(stderrText()).not.toContain(TEST_KEY);
  });

  it("no env key → no write, no credential log line", async () => {
    await runSelfRepair(NPX_CTX);

    await expect(fs.stat(env.paths.globalKey)).rejects.toMatchObject({ code: "ENOENT" });
    expect(stderrText()).not.toContain("hook credential");
  });

  it("whitespace-only env key → treated as absent", async () => {
    process.env.MIDBRAIN_API_KEY = "   ";

    await runSelfRepair(NPX_CTX);

    await expect(fs.stat(env.paths.globalKey)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("MIDBRAIN_USER_API_KEY alone is never persisted", async () => {
    process.env.MIDBRAIN_USER_API_KEY = "user-account-key-never-a-hook-key";

    await runSelfRepair(NPX_CTX);

    await expect(fs.stat(env.paths.globalKey)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("identical existing key → mtime-preserving no-op, silent", async () => {
    await fs.mkdir(path.dirname(env.paths.globalKey), { recursive: true });
    await fs.writeFile(env.paths.globalKey, `${TEST_KEY}\n`, { mode: 0o600 });
    const before = await fs.stat(env.paths.globalKey);
    process.env.MIDBRAIN_API_KEY = TEST_KEY;

    await runSelfRepair(DURABLE);

    const after = await fs.stat(env.paths.globalKey);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(stderrText()).not.toContain("hook credential persisted");
  });

  it("different existing key → refused no-op: content intact, no backup, no throw", async () => {
    await fs.mkdir(path.dirname(env.paths.globalKey), { recursive: true });
    await fs.writeFile(env.paths.globalKey, "pre-existing-other-key\n", { mode: 0o600 });
    process.env.MIDBRAIN_API_KEY = TEST_KEY;

    await runSelfRepair(DURABLE);

    expect(await readGlobalKey()).toBe("pre-existing-other-key\n");
    const siblings = await fs.readdir(path.dirname(env.paths.globalKey));
    expect(siblings.filter((f) => f.includes(".bak"))).toEqual([]);
    expect(stderrText()).not.toContain("hook credential persisted");
  });

  it("empty (corrupt) existing key file → no-op, no throw, hook repair still runs", async () => {
    await fs.mkdir(path.dirname(env.paths.globalKey), { recursive: true });
    await fs.writeFile(env.paths.globalKey, "", { mode: 0o600 });
    // Seed a stale legacy hook so we can observe that repair still happened
    // after the credential path hit its CredentialReadError.
    await fs.writeFile(env.paths.claudeSettings, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /old/plugins/claude-code/capture-user.mjs", timeout: 10 }] }],
      },
    }, null, 2) + "\n");
    process.env.MIDBRAIN_API_KEY = TEST_KEY;

    await runSelfRepair(DURABLE);

    expect(await readGlobalKey()).toBe(""); // untouched
    const settings = JSON.parse(await fs.readFile(env.paths.claudeSettings, "utf8"));
    const commands = settings.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands.join("\n")).not.toContain("capture-user.mjs"); // repair ran
  });

  it.skipIf(IS_WIN || process.getuid?.() === 0)(
    "unreadable existing key file (EACCES) → no-op, no throw, hook repair still runs",
    async () => {
      await fs.mkdir(path.dirname(env.paths.globalKey), { recursive: true });
      await fs.writeFile(env.paths.globalKey, "pre-existing-unreadable-key\n", { mode: 0o600 });
      await fs.chmod(env.paths.globalKey, 0o000);
      await fs.writeFile(env.paths.claudeSettings, JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /old/plugins/claude-code/capture-user.mjs", timeout: 10 }] }],
        },
      }, null, 2) + "\n");
      process.env.MIDBRAIN_API_KEY = TEST_KEY;

      await runSelfRepair(DURABLE);

      await fs.chmod(env.paths.globalKey, 0o600);
      expect(await readGlobalKey()).toBe("pre-existing-unreadable-key\n"); // untouched
      const settings = JSON.parse(await fs.readFile(env.paths.claudeSettings, "utf8"));
      const commands = settings.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
      expect(commands.join("\n")).not.toContain("capture-user.mjs"); // repair ran
    },
  );

  it.each([
    ["tmp", "/private/tmp/some-checkout"],
    ["worktree", "/Users/u/dev/some-worktree"],
    ["ci", "/home/runner/work/checkout"],
  ])("%s launch context → self-repair skipped, no credential write", async (kind, ctxPath) => {
    process.env.MIDBRAIN_API_KEY = TEST_KEY;

    await runSelfRepair({ context: { kind, path: ctxPath } });

    await expect(fs.stat(env.paths.globalKey)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ===================================================================
// AC-1 e2e — server start persists key; env-less hook child captures
// ===================================================================

describe.skipIf(IS_WIN)("PRD-039 AC-1 — NanoClaw topology end-to-end", () => {
  let fetchLog;
  let workspace;

  beforeEach(async () => {
    // The mounted surface: ~/.claude with post-migration (shim-form) hooks.
    await fs.writeFile(
      env.paths.claudeSettings,
      JSON.stringify(migratedClaudeSettings(), null, 2) + "\n",
    );
    // Hook cwd in a container is a workspace with no project key.
    workspace = path.join(env.home, "workspace");
    await fs.mkdir(workspace, { recursive: true });

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

    // Hermetic dev shim (points at this checkout); repair preserves dev bodies.
    await installShim("claude", { mode: "install", isDev: true });
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
      // childEnv() strips MIDBRAIN_API_KEY — exactly what NanoClaw containers
      // do to hook children. The key exists only for the in-process "server".
      env: env.childEnv({
        NODE_OPTIONS: `--import ${env.preloadUrl}`,
        MIDBRAIN_TEST_FETCH_LOG: fetchLog,
      }),
    });
  }

  it("server start persists the env key; a hook child with no MIDBRAIN env captures with auth", async () => {
    process.env.MIDBRAIN_API_KEY = TEST_KEY;
    await runSelfRepair(NPX_CTX);
    delete process.env.MIDBRAIN_API_KEY;

    expect(await readGlobalKey()).toBe(`${TEST_KEY}\n`);

    // The container reality this file exists to prove: the hook child spawn
    // env must carry no credential — the file written above is its only path.
    expect(env.childEnv()).not.toHaveProperty("MIDBRAIN_API_KEY");
    expect(env.childEnv()).not.toHaveProperty("MIDBRAIN_USER_API_KEY");

    const result = runShim("user", { prompt: "nanoclaw topology marker PRD-039", cwd: workspace });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");

    const episodic = (await readFetchLog()).filter((r) => r.url.includes("/memories/episodic"));
    expect(episodic).toHaveLength(1);
    expect(episodic[0].hasAuth).toBe(true);
    expect(JSON.stringify(episodic[0].body)).toContain("nanoclaw topology marker PRD-039");
  });

  it("negative control — no env key at server start: hook child stays keyless, captures nothing, still exit 0", async () => {
    await runSelfRepair(NPX_CTX);

    const result = runShim("user", { prompt: "should not be captured PRD-039", cwd: workspace });

    expect(result.status).toBe(0); // fail-open contract
    const episodic = (await readFetchLog()).filter((r) => r.url.includes("/memories/episodic"));
    expect(episodic).toHaveLength(0);
  });
});
