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

import { makeTestEnv, assertSandboxed, snapshotTree, diffSnapshots } from "./helpers/test-env.mjs";
import { runSelfRepair } from "../install.mjs";
import { startMcpServer } from "../index.js";
import { captureClientLabel } from "../plugins/claude-code/common.mjs";
import { installShim, stableShimPath, shellQuote } from "../shared/clients/shim.mjs";
import { MidbrainApi } from "../shared/midbrain-api.mjs";
import { establishSpoolBinding } from "../shared/claude-spool.mjs";

const IS_WIN = process.platform === "win32";

const DURABLE = { context: { kind: "durable", path: "/durable/install" } };
const NPX_CTX = {
  context: { kind: "npx-cache", path: "/Users/u/.npm/_npx/abc123/node_modules/midbrain-memory-mcp" },
  isDev: true,
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
  delete process.env.MIDBRAIN_API_URL;
  delete process.env.MIDBRAIN_CLIENT;
  delete process.env.MIDBRAIN_CAPTURE_CLIENT;
  delete process.env.MIDBRAIN_STATE_DIR;
  await env.restore();
});

function stderrText() {
  return errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

async function readGlobalKey() {
  return fs.readFile(env.paths.globalKey, "utf8");
}

/**
 * The capture-client marker lives on the only durable in-container surface:
 * ~/.claude (host .claude-shared, mounted RW). Everything else under /home/node
 * is ephemeral on a NanoClaw --rm spawn, so this is where a label migration
 * must land. Mirrors captureClientLabel() in plugins/claude-code/common.mjs.
 */
function markerPath() {
  return path.join(env.home, ".claude", ".midbrain-capture-client");
}

async function readMarker() {
  return fs.readFile(markerPath(), "utf8");
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

  it("MIDBRAIN_API_URL set (env-bound self-host key) → no write — never strand the key on the default origin", async () => {
    process.env.MIDBRAIN_API_KEY = TEST_KEY;
    process.env.MIDBRAIN_API_URL = "https://selfhost.example";

    await runSelfRepair(NPX_CTX);

    await expect(fs.stat(env.paths.globalKey)).rejects.toMatchObject({ code: "ENOENT" });
    expect(stderrText()).not.toContain("hook credential");
  });

  it("an active client-scope file credential blocks persistence (no scope promotion)", async () => {
    const clientKeyPath = path.join(env.home, ".config", "claude", ".midbrain-key");
    await fs.mkdir(path.dirname(clientKeyPath), { recursive: true });
    await fs.writeFile(clientKeyPath, "client-key-active\n", { mode: 0o600 });
    process.env.MIDBRAIN_CLIENT = "claude";
    process.env.MIDBRAIN_API_KEY = TEST_KEY;

    await runSelfRepair(DURABLE);

    await expect(fs.stat(env.paths.globalKey)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(clientKeyPath, "utf8")).toBe("client-key-active\n");
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

// ===================================================================
// Issue #51 — self-repair migrates existing NanoClaw groups to the
// `nanoclaw` capture label by seeding the .midbrain-capture-client marker.
//
// The gate is a positive, MCP-server-visible NanoClaw signal:
// MIDBRAIN_CAPTURE_CLIENT=nanoclaw, which NanoClaw supplies via the group's
// container.json mcpServers.<name>.env (that env reaches the MCP server
// process; hook children are env-stripped, so the durable marker is the
// only way the label reaches the hook). A plain host Claude install never
// sets this, so it is never relabeled.
// ===================================================================

describe("Issue #51 — capture-client marker migration (runSelfRepair)", () => {
  function containerConfigPath() {
    return path.join(env.root, "workspace", "agent", "container.json");
  }

  /**
   * Actual pre-v0.4.8 group state: shim-form hooks, old MCP env, no marker and
   * no MIDBRAIN_CAPTURE_CLIENT gate. NanoClaw mounts this config read-only at
   * /workspace/agent/container.json and the MCP process receives its env.
   */
  async function seedPre048Group() {
    await fs.writeFile(
      env.paths.claudeSettings,
      JSON.stringify(migratedClaudeSettings(), null, 2) + "\n",
    );
    await fs.mkdir(path.dirname(containerConfigPath()), { recursive: true });
    await fs.writeFile(containerConfigPath(), JSON.stringify({
      mcpServers: {
        "midbrain-memory": {
          command: "npx",
          args: ["-y", "midbrain-memory-mcp@latest"],
          env: {
            MIDBRAIN_CLIENT: "claude",
            MIDBRAIN_API_KEY: TEST_KEY,
          },
        },
      },
    }, null, 2) + "\n");
    process.env.MIDBRAIN_CLIENT = "claude";
    process.env.MIDBRAIN_API_KEY = TEST_KEY;
  }

  async function seedHostClaude() {
    await fs.writeFile(
      env.paths.claudeSettings,
      JSON.stringify(migratedClaudeSettings(), null, 2) + "\n",
    );
    process.env.MIDBRAIN_CLIENT = "claude";
    process.env.MIDBRAIN_API_KEY = TEST_KEY;
  }

  function repairPre048Group() {
    return runSelfRepair({ ...NPX_CTX, nanoclawConfigPath: containerConfigPath() });
  }

  function failMarkerWriteAfterPartialCreate() {
    const realOpen = fs.open.bind(fs);
    let injected = false;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, ...rest) => {
      const handle = await realOpen(file, flags, ...rest);
      const isMarkerCreate = file === markerPath()
        || String(file).startsWith(`${markerPath()}.stage-`);
      if (injected || !isMarkerCreate || flags !== "wx") return handle;
      injected = true;
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === "writeFile") {
            return async () => {
              await target.writeFile("nano", "utf8");
              throw new Error("injected marker write failure");
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    return { spy, wasInjected: () => injected };
  }

  it("cold upgrade: actual pre-v0.4.8 group with no new gate and no marker → seeds nanoclaw marker (0600, sandboxed)", async () => {
    await seedPre048Group();
    expect(process.env.MIDBRAIN_CAPTURE_CLIENT).toBeUndefined();

    await repairPre048Group();

    await assertSandboxed(env, markerPath());
    expect(await readMarker()).toBe("nanoclaw\n");
    if (!IS_WIN) {
      const { mode } = await fs.stat(markerPath());
      expect(mode & 0o777).toBe(0o600);
    }
  });

  it("actual index.js startup completes legacy marker migration before MCP readiness while unrelated repair stays pending", async () => {
    await seedPre048Group();
    const events = [];
    let releaseRepair;
    const pendingRepair = new Promise((resolve) => { releaseRepair = resolve; });

    await startMcpServer({
      serverFactory: () => ({
        async connect() {
          events.push("connect");
          expect(await captureClientLabel()).toBe("nanoclaw");
        },
      }),
      transportFactory: () => ({}),
      prepareOptions: { ...NPX_CTX, nanoclawConfigPath: containerConfigPath() },
      checkForUpdateFn: () => {
        events.push("repair");
        return pendingRepair;
      },
      log: () => events.push("ready"),
    });

    expect(await readMarker()).toBe("nanoclaw\n");
    expect(events).toEqual(["connect", "ready", "repair"]);
    releaseRepair();
  });

  it("first legacy wake prepares durable and cached hook paths before readiness without a warm-up", async () => {
    await seedPre048Group();
    const durableRoot = path.join(env.home, ".claude", ".midbrain");
    const durableShim = path.join(durableRoot, "bin", process.platform === "win32" ? "claude-hook.cmd" : "claude-hook");
    const cachedShim = path.join(env.home, ".midbrain", "bin", process.platform === "win32" ? "claude-hook.cmd" : "claude-hook");

    await startMcpServer({
      serverFactory: () => ({
        async connect() {
          expect(process.env.MIDBRAIN_STATE_DIR).toBe(durableRoot);
          expect(await readMarker()).toBe("nanoclaw\n");
          expect((await fs.readFile(path.join(durableRoot, ".midbrain-key"), "utf8")).trim()).toBe(TEST_KEY);
          for (const shim of [durableShim, cachedShim]) {
            const body = await fs.readFile(shim, "utf8");
            expect(body).toContain("MIDBRAIN_STATE_DIR");
            expect(body).not.toContain(TEST_KEY);
          }
          const settings = JSON.parse(await fs.readFile(env.paths.claudeSettings, "utf8"));
          const commands = Object.values(settings.hooks)
            .flatMap((groups) => groups.flatMap((group) => group.hooks.map((hook) => hook.command)));
          expect(commands.every((command) => command.includes(durableShim))).toBe(true);
        },
      }),
      transportFactory: () => ({}),
      prepareOptions: { ...NPX_CTX, nanoclawConfigPath: containerConfigPath() },
      checkForUpdateFn: () => undefined,
      log: () => {},
    });
  });

  it("removes only its partial marker after an injected post-create write failure so the next repair succeeds", async () => {
    await seedPre048Group();
    const failure = failMarkerWriteAfterPartialCreate();
    try {
      await repairPre048Group();
    } finally {
      failure.spy.mockRestore();
    }

    expect(failure.wasInjected()).toBe(true);
    await expect(fs.lstat(markerPath())).rejects.toMatchObject({ code: "ENOENT" });

    await repairPre048Group();
    expect(await readMarker()).toBe("nanoclaw\n");
    if (!IS_WIN) expect((await fs.stat(markerPath())).mode & 0o777).toBe(0o600);
  });

  it("never unlinks the published marker path while recovering from a failed initialization", async () => {
    await seedPre048Group();
    const failure = failMarkerWriteAfterPartialCreate();
    const realUnlink = fs.unlink.bind(fs);
    let markerUnlinkAttempted = false;
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (file, ...rest) => {
      if (file === markerPath()) {
        markerUnlinkAttempted = true;
        await fs.rename(file, `${file}.owned-partial`);
        await fs.writeFile(file, "concurrent-owner\n", { mode: 0o640 });
      }
      return realUnlink(file, ...rest);
    });
    try {
      await repairPre048Group();
    } finally {
      unlinkSpy.mockRestore();
      failure.spy.mockRestore();
    }

    expect(failure.wasInjected()).toBe(true);
    expect(markerUnlinkAttempted).toBe(false);
    await expect(fs.lstat(markerPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a marker created concurrently at the atomic publication boundary", async () => {
    await seedPre048Group();
    const realLink = fs.link.bind(fs);
    let replacementInjected = false;
    const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      if (!replacementInjected && target === markerPath()) {
        await fs.writeFile(target, "concurrent-owner\n", { mode: 0o640 });
        replacementInjected = true;
      }
      return realLink(source, target);
    });
    try {
      await repairPre048Group();
    } finally {
      linkSpy.mockRestore();
    }

    expect(replacementInjected).toBe(true);
    expect(await readMarker()).toBe("concurrent-owner\n");
    if (!IS_WIN) expect((await fs.stat(markerPath())).mode & 0o777).toBe(0o640);
  });

  it("rejects a legacy topology config replaced after lstat instead of reading the replacement", async () => {
    await seedPre048Group();
    const realLstat = fs.lstat.bind(fs);
    let replacementInjected = false;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (file, ...rest) => {
      const stat = await realLstat(file, ...rest);
      if (!replacementInjected && file === containerConfigPath()) {
        await fs.rename(file, `${file}.original`);
        await fs.writeFile(file, JSON.stringify({
          mcpServers: {
            "midbrain-memory": {
              command: "npx",
              args: ["-y", "midbrain-memory-mcp@latest"],
              env: { MIDBRAIN_CLIENT: "claude", MIDBRAIN_API_KEY: TEST_KEY },
            },
          },
        }));
        replacementInjected = true;
      }
      return stat;
    });
    try {
      await repairPre048Group();
    } finally {
      lstatSpy.mockRestore();
    }

    expect(replacementInjected).toBe(true);
    await expect(fs.lstat(markerPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("negative — host Claude with the same client/env-key shape but no NanoClaw topology → no marker written", async () => {
    await seedHostClaude();

    await runSelfRepair(NPX_CTX);

    await expect(fs.stat(markerPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("negative — a non-nanoclaw capture-client value is not treated as the gate", async () => {
    await seedHostClaude();
    process.env.MIDBRAIN_CAPTURE_CLIENT = "codex";

    await runSelfRepair(NPX_CTX);

    await expect(fs.stat(markerPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("idempotent: a second repair pass produces no content or mtime churn", async () => {
    await seedPre048Group();
    await repairPre048Group();

    const before = await snapshotTree(env.home);
    await repairPre048Group();
    const after = await snapshotTree(env.home);

    expect(diffSnapshots(before, after)).toEqual([]);
  });

  it("preserves a user/dev-authored marker with a different valid value", async () => {
    await seedPre048Group();
    await fs.mkdir(path.dirname(markerPath()), { recursive: true });
    await fs.writeFile(markerPath(), "my-custom-label\n", { mode: 0o600 });
    const beforeStat = await fs.stat(markerPath());
    await repairPre048Group();

    expect(await readMarker()).toBe("my-custom-label\n");
    const afterStat = await fs.stat(markerPath());
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("preserves every byte of an existing malformed regular marker", async () => {
    await seedPre048Group();
    const malformed = Buffer.from("INVALID USER VALUE\n\0keep-these-bytes", "utf8");
    await fs.mkdir(path.dirname(markerPath()), { recursive: true });
    await fs.writeFile(markerPath(), malformed, { mode: 0o640 });
    const before = await fs.stat(markerPath());

    await repairPre048Group();

    expect(await fs.readFile(markerPath())).toEqual(malformed);
    const after = await fs.stat(markerPath());
    expect(after.mtimeMs).toBe(before.mtimeMs);
    if (!IS_WIN) expect(after.mode & 0o777).toBe(0o640);
  });

  it.skipIf(IS_WIN)("returns promptly and preserves an existing FIFO marker", async () => {
    await seedPre048Group();
    await fs.mkdir(path.dirname(markerPath()), { recursive: true });
    const fifo = spawnSync("mkfifo", [markerPath()], { encoding: "utf8" });
    expect(fifo.status).toBe(0);
    const installUrl = new URL("../install.mjs", import.meta.url).href;
    const script = `
      import { runSelfRepair } from ${JSON.stringify(installUrl)};
      await runSelfRepair(${JSON.stringify({ ...NPX_CTX, nanoclawConfigPath: containerConfigPath() })});
    `;

    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: env.childEnv({
        MIDBRAIN_CLIENT: "claude",
        MIDBRAIN_API_KEY: TEST_KEY,
      }),
      encoding: "utf8",
      timeout: 3000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect((await fs.lstat(markerPath())).isFIFO()).toBe(true);
  });

  it("preserves directories and symlinks without reading their contents", async () => {
    await seedPre048Group();
    await fs.mkdir(markerPath(), { recursive: true });
    await repairPre048Group();
    expect((await fs.lstat(markerPath())).isDirectory()).toBe(true);

    await fs.rmdir(markerPath());
    const victim = path.join(env.home, "marker-victim.txt");
    await fs.writeFile(victim, "victim-bytes\n");
    await fs.symlink(victim, markerPath());
    await repairPre048Group();
    expect((await fs.lstat(markerPath())).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(victim, "utf8")).toBe("victim-bytes\n");
  });

  it.skipIf(IS_WIN || process.getuid?.() === 0)("preserves an unreadable marker and its permissions", async () => {
    await seedPre048Group();
    await fs.mkdir(path.dirname(markerPath()), { recursive: true });
    await fs.writeFile(markerPath(), "unreadable-user-state\n", { mode: 0o600 });
    await fs.chmod(markerPath(), 0o000);
    try {
      await repairPre048Group();
      expect((await fs.stat(markerPath())).mode & 0o777).toBe(0o000);
    } finally {
      await fs.chmod(markerPath(), 0o600);
    }
    expect(await fs.readFile(markerPath(), "utf8")).toBe("unreadable-user-state\n");
  });

  it("ignores a planted legacy predictable-temp symlink and never touches its victim", async () => {
    await seedPre048Group();
    await fs.mkdir(path.dirname(markerPath()), { recursive: true });
    const victim = path.join(env.home, "temp-victim.txt");
    const planted = `${markerPath()}.${process.pid}.tmp`;
    await fs.writeFile(victim, "victim-original\n", { mode: 0o644 });
    await fs.symlink(victim, planted);

    await repairPre048Group();

    expect(await readMarker()).toBe("nanoclaw\n");
    expect((await fs.lstat(markerPath())).isFile()).toBe(true);
    expect(await fs.readFile(victim, "utf8")).toBe("victim-original\n");
    expect((await fs.lstat(planted)).isSymbolicLink()).toBe(true);
  });

  it.each([
    ["tmp", "/private/tmp/some-checkout"],
    ["worktree", "/Users/u/dev/some-worktree"],
    ["ci", "/home/runner/work/checkout"],
  ])("%s launch context → migration skipped, no marker write", async (kind, ctxPath) => {
    await seedPre048Group();

    await runSelfRepair({
      context: { kind, path: ctxPath },
      nanoclawConfigPath: containerConfigPath(),
    });

    await expect(fs.stat(markerPath())).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ===================================================================
// Issue #51 e2e — after migration a hook child (env-stripped) resolves the
// marker and stores the capture with client: "nanoclaw".
// ===================================================================

describe.skipIf(IS_WIN)("Issue #51 e2e — migrated marker labels the capture nanoclaw", () => {
  let fetchLog;
  let workspace;

  beforeEach(async () => {
    await fs.writeFile(
      env.paths.claudeSettings,
      JSON.stringify(migratedClaudeSettings(), null, 2) + "\n",
    );
    workspace = path.join(env.home, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const configPath = path.join(env.root, "workspace", "agent", "container.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({
      mcpServers: {
        "midbrain-memory": {
          command: "npx",
          args: ["-y", "midbrain-memory-mcp@latest"],
          env: { MIDBRAIN_CLIENT: "claude", MIDBRAIN_API_KEY: TEST_KEY },
        },
      },
    }, null, 2) + "\n");
    env.nanoclawConfigPath = configPath;

    fetchLog = path.join(env.tmp, "fetch-log-51.ndjson");
    const preload = path.join(env.tmp, "fetch-preload-51.mjs");
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
      // childEnv() strips MIDBRAIN_* — exactly what NanoClaw does to hook
      // children. The marker seeded by self-repair is the only label source.
      env: env.childEnv({
        NODE_OPTIONS: `--import ${env.preloadUrl}`,
        MIDBRAIN_TEST_FETCH_LOG: fetchLog,
      }),
    });
  }

  it("pre-v0.4.8 server start (without the new gate) seeds the marker; the env-less hook child captures client: nanoclaw", async () => {
    process.env.MIDBRAIN_API_KEY = TEST_KEY;
    process.env.MIDBRAIN_CLIENT = "claude";
    expect(process.env.MIDBRAIN_CAPTURE_CLIENT).toBeUndefined();
    await runSelfRepair({ ...NPX_CTX, nanoclawConfigPath: env.nanoclawConfigPath });
    // The hook child inherits neither the key nor the capture-client env.
    delete process.env.MIDBRAIN_API_KEY;

    expect(await readMarker()).toBe("nanoclaw\n");
    expect(env.childEnv()).not.toHaveProperty("MIDBRAIN_CAPTURE_CLIENT");

    const result = runShim("user", { prompt: "issue 51 marker migration e2e", cwd: workspace });

    expect(result.status).toBe(0);
    const episodic = (await readFetchLog()).filter((r) => r.url.includes("/memories/episodic"));
    expect(episodic).toHaveLength(1);
    expect(episodic[0].body?.memory_metadata?.client).toBe("nanoclaw");
  });
});

// ===================================================================
// Issue #52 — cold-wake opener recovery: bounded key-wait, keyless spool on
// the durable ~/.claude surface, and a disciplined server-start flush.
// ===================================================================

describe.skipIf(IS_WIN)("Issue #52 — opener recovery (spool + flush)", () => {
  const spoolPath = () => path.join(env.home, ".claude", ".midbrain-spool.ndjson");

  async function readSpool() {
    const raw = await fs.readFile(spoolPath(), "utf8");
    return raw.trim().split("\n").filter(Boolean).map(JSON.parse);
  }

  let workspace;
  let preloadUrl;

  beforeEach(async () => {
    await fs.writeFile(
      env.paths.claudeSettings,
      JSON.stringify(migratedClaudeSettings(), null, 2) + "\n",
    );
    workspace = path.join(env.home, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    // A hermetic dev shim pointing at this checkout (repair preserves dev bodies).
    await installShim("claude", { mode: "install", isDev: true });
    await fs.mkdir(path.dirname(markerPath()), { recursive: true });
    await fs.writeFile(markerPath(), "nanoclaw\n", { mode: 0o600 });
    establishSpoolBinding(new MidbrainApi(TEST_KEY, "test").cacheScope);

    // Hook children must fail fast on the key-wait (no key will ever appear in
    // the child) so the spool path runs without a 20s real wait.
    const preload = path.join(env.tmp, "spool-preload.mjs");
    await fs.writeFile(preload, `
      globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => "", json: async () => ({}) });
    `);
    preloadUrl = pathToFileURL(preload).href;
  });

  function runShim(role, input) {
    return spawnSync("/bin/sh", [stableShimPath("claude"), role], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 30_000,
      env: env.childEnv({
        NODE_OPTIONS: `--import ${preloadUrl}`,
        MIDBRAIN_KEY_WAIT_MS: "0", // no key will arrive in the child; don't wait
      }),
    });
  }

  it("cold wake with no key: the opener is spooled to ~/.claude, not dropped (exit 0)", async () => {
    // No key on any resolution path, no MIDBRAIN_* in the hook child env.
    const result = runShim("user", { prompt: "the very first message", cwd: workspace });

    expect(result.status).toBe(0);
    await assertSandboxed(env, spoolPath());
    const spooled = await readSpool();
    expect(spooled).toHaveLength(1);
    expect(spooled[0].text).toBe("the very first message");
    expect(spooled[0].role).toBe("user");
    if (!IS_WIN) {
      const { mode } = await fs.stat(spoolPath());
      expect(mode & 0o777).toBe(0o600);
    }
  });

  it("host Claude with no key creates no NanoClaw spool", async () => {
    await fs.unlink(markerPath());
    await fs.unlink(path.join(env.home, ".claude", ".midbrain-spool-binding"));

    const result = runShim("user", { prompt: "host no-key negative", cwd: workspace });

    expect(result.status).toBe(0);
    await expect(fs.stat(spoolPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounded key-wait: a key that appears mid-wait is used, and nothing is spooled", async () => {
    // Seed the global key BEFORE the hook runs but let the wait be generous:
    // the very first resolution attempt should already succeed (fast path).
    await fs.mkdir(path.dirname(env.paths.globalKey), { recursive: true });
    await fs.writeFile(env.paths.globalKey, `${TEST_KEY}\n`, { mode: 0o600 });

    // This child records fetches so we can assert a real authenticated POST.
    const fetchLog = path.join(env.tmp, "keywait-fetch.ndjson");
    const preload = path.join(env.tmp, "keywait-preload.mjs");
    await fs.writeFile(preload, `
      import fs from "node:fs";
      globalThis.fetch = async (url, opts = {}) => {
        const headers = opts.headers || {};
        fs.appendFileSync(process.env.MIDBRAIN_TEST_FETCH_LOG, JSON.stringify({
          url: String(url),
          hasAuth: typeof headers.Authorization === "string" && headers.Authorization.length > 0,
          body: opts.body ? JSON.parse(opts.body) : undefined,
        }) + "\\n");
        if (String(url).includes("/memories/episodic")) return { ok: true, status: 201, text: async () => "", json: async () => ({}) };
        return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
      };
    `);
    const result = spawnSync("/bin/sh", [stableShimPath("claude"), "user"], {
      input: JSON.stringify({ prompt: "captured not spooled", cwd: workspace }),
      encoding: "utf8",
      timeout: 30_000,
      env: env.childEnv({
        NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
        MIDBRAIN_TEST_FETCH_LOG: fetchLog,
      }),
    });

    expect(result.status).toBe(0);
    await expect(fs.stat(spoolPath())).rejects.toMatchObject({ code: "ENOENT" });
    const log = (await fs.readFile(fetchLog, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    const episodic = log.filter((r) => r.url.includes("/memories/episodic"));
    expect(episodic).toHaveLength(1);
    expect(episodic[0].hasAuth).toBe(true);
    expect(episodic[0].body?.text).toBe("captured not spooled");
  });

});

// Flush/cooldown behavior is driven by in-process runSelfRepair + a mocked
// fetch, so (unlike the shim-based blocks above) it needs no POSIX shell and
// runs on every platform.
describe("Issue #52 — server-start spool flush discipline", () => {
  const spoolPath = () => path.join(env.home, ".claude", ".midbrain-spool.ndjson");
  const cooldownPath = () => path.join(env.home, ".claude", ".midbrain-spool-cooldown");

  async function readSpool() {
    const raw = await fs.readFile(spoolPath(), "utf8");
    return raw.trim().split("\n").filter(Boolean).map(JSON.parse);
  }

  beforeEach(async () => {
    await fs.writeFile(env.paths.claudeSettings, JSON.stringify(migratedClaudeSettings(), null, 2) + "\n");
    process.env.MIDBRAIN_CAPTURE_CLIENT = "nanoclaw";
    process.env.MIDBRAIN_CLIENT = "claude";
    establishSpoolBinding(new MidbrainApi(TEST_KEY, "test").cacheScope);
  });

  it("server-start flush drains the spool once the key is present (each entry POSTed once)", async () => {
    // Spool two entries as a keyless hook would.
    const { appendToSpool } = await import("../shared/claude-spool.mjs");
    appendToSpool({ text: "opener one", role: "user", memory_metadata: { client: "nanoclaw" } });
    appendToSpool({ text: "reply one", role: "assistant", memory_metadata: { client: "nanoclaw" } });

    const posts = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts = {}) => {
      if (String(url).includes("/memories/episodic")) {
        posts.push(JSON.parse(opts.body));
        return { ok: true, status: 201, headers: new Map(), text: async () => "", json: async () => ({}) };
      }
      return { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) };
    });

    process.env.MIDBRAIN_API_KEY = TEST_KEY;
    process.env.MIDBRAIN_SPOOL_POST_SPACING_MS = "0";
    try {
      await runSelfRepair(NPX_CTX);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.MIDBRAIN_API_KEY;
      delete process.env.MIDBRAIN_SPOOL_POST_SPACING_MS;
    }

    expect(posts.map((p) => p.text).sort()).toEqual(["opener one", "reply one"]);
    // Spool cleared after a fully-successful flush.
    await expect(fs.stat(spoolPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("WAF rejection: flush stops, entries are preserved (never dropped), cooldown is set", async () => {
    const { appendToSpool } = await import("../shared/claude-spool.mjs");
    appendToSpool({ text: "opener a", role: "user", memory_metadata: { client: "nanoclaw" } });
    appendToSpool({ text: "opener b", role: "user", memory_metadata: { client: "nanoclaw" } });
    appendToSpool({ text: "opener c", role: "user", memory_metadata: { client: "nanoclaw" } });

    // First POST 429s → the whole pass stops immediately.
    let calls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/memories/episodic")) {
        calls += 1;
        return { ok: false, status: 429, headers: new Map(), text: async () => "rate limited", json: async () => ({}) };
      }
      return { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) };
    });

    process.env.MIDBRAIN_API_KEY = TEST_KEY;
    process.env.MIDBRAIN_SPOOL_POST_SPACING_MS = "0";
    process.env.MIDBRAIN_SPOOL_COOLDOWN_MS = "300000";
    try {
      await runSelfRepair(NPX_CTX);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.MIDBRAIN_API_KEY;
      delete process.env.MIDBRAIN_SPOOL_POST_SPACING_MS;
      delete process.env.MIDBRAIN_SPOOL_COOLDOWN_MS;
    }

    // Only one POST attempted (the pass stopped on the 429), no burst.
    expect(calls).toBe(1);
    // All three entries preserved — nothing dropped.
    const spooled = await readSpool();
    expect(spooled.map((e) => e.text).sort()).toEqual(["opener a", "opener b", "opener c"]);
    // Cooldown persisted in the future.
    const until = Number((await fs.readFile(cooldownPath(), "utf8")).trim());
    expect(until).toBeGreaterThan(Date.now());
  });

  it("different binding posts zero rows and preserves the old row", async () => {
    establishSpoolBinding("f".repeat(64));
    const { appendToSpool } = await import("../shared/claude-spool.mjs");
    appendToSpool({ text: "other-agent row", role: "user", memory_metadata: { client: "nanoclaw" } });

    let calls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/memories/episodic")) calls += 1;
      return { ok: true, status: 201, headers: new Map(), text: async () => "", json: async () => ({}) };
    });
    process.env.MIDBRAIN_API_KEY = TEST_KEY;
    try {
      await runSelfRepair(NPX_CTX);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.MIDBRAIN_API_KEY;
    }

    expect(calls).toBe(0);
    expect((await readSpool()).map((entry) => entry.text)).toEqual(["other-agent row"]);
  });

  it("cooldown defers the next flush: no POST while cooling down, entries kept", async () => {
    const { appendToSpool } = await import("../shared/claude-spool.mjs");
    appendToSpool({ text: "still pending", role: "user", memory_metadata: { client: "nanoclaw" } });
    // Active cooldown in the future.
    await fs.writeFile(cooldownPath(), String(Date.now() + 300_000), { mode: 0o600 });

    let calls = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/memories/episodic")) calls += 1;
      return { ok: true, status: 201, headers: new Map(), text: async () => "", json: async () => ({}) };
    });

    process.env.MIDBRAIN_API_KEY = TEST_KEY;
    try {
      await runSelfRepair(NPX_CTX);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.MIDBRAIN_API_KEY;
    }

    expect(calls).toBe(0); // deferred, no POST
    const spooled = await readSpool();
    expect(spooled.map((e) => e.text)).toEqual(["still pending"]); // preserved
  });

  it("never-drop across repeated failing starts: entry count is non-decreasing until success", async () => {
    const { appendToSpool } = await import("../shared/claude-spool.mjs");
    appendToSpool({ text: "durable opener", role: "user", memory_metadata: { client: "nanoclaw" } });

    // Two failing (503) server starts — the entry must survive both.
    const failSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/memories/episodic")) {
        return { ok: false, status: 503, headers: new Map(), text: async () => "", json: async () => ({}) };
      }
      return { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) };
    });
    process.env.MIDBRAIN_API_KEY = TEST_KEY;
    process.env.MIDBRAIN_SPOOL_POST_SPACING_MS = "0";
    try {
      await runSelfRepair(NPX_CTX);
      await runSelfRepair(NPX_CTX);
    } finally {
      failSpy.mockRestore();
    }
    expect((await readSpool()).map((e) => e.text)).toEqual(["durable opener"]);

    // Now a successful start drains it.
    const okSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/memories/episodic")) {
        return { ok: true, status: 201, headers: new Map(), text: async () => "", json: async () => ({}) };
      }
      return { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) };
    });
    try {
      await runSelfRepair(NPX_CTX);
    } finally {
      okSpy.mockRestore();
      delete process.env.MIDBRAIN_API_KEY;
      delete process.env.MIDBRAIN_SPOOL_POST_SPACING_MS;
    }
    await expect(fs.stat(spoolPath())).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ===================================================================
// Issue #52 — MIDBRAIN_STATE_DIR relocation closes the shim-missing race by
// putting the shim + key under the durable ~/.claude mount, so both survive a
// cold --rm respawn and exist at t=0. Cross-platform (in-process; no shell).
// ===================================================================

describe("Issue #52 — durable state under ~/.claude (MIDBRAIN_STATE_DIR)", () => {
  const stateDir = () => path.join(env.home, ".claude", ".midbrain");
  const relocatedShim = () =>
    path.join(stateDir(), "bin", process.platform === "win32" ? "claude-hook.cmd" : "claude-hook");
  const relocatedKey = () => path.join(stateDir(), ".midbrain-key");

  // Ephemeral container dirs that a --rm respawn wipes (everything NOT under
  // the ~/.claude mount).
  async function wipeEphemeralDirs() {
    await fs.rm(path.join(env.home, ".midbrain"), { recursive: true, force: true });
    await fs.rm(path.join(env.home, ".config", "midbrain"), { recursive: true, force: true });
    await fs.rm(path.join(env.home, ".cache", "midbrain"), { recursive: true, force: true });
  }

  const hostShim = () =>
    path.join(env.home, ".midbrain", "bin", process.platform === "win32" ? "claude-hook.cmd" : "claude-hook");
  const hostKey = () => path.join(env.home, ".config", "midbrain", ".midbrain-key");

  it("relocates the shim and persisted key under ~/.claude when the env is set", async () => {
    process.env.MIDBRAIN_STATE_DIR = stateDir();
    process.env.MIDBRAIN_API_KEY = TEST_KEY;
    try {
      // The MCP server writes the shim (installShim → stableShimPath) and, via
      // runSelfRepair, persists the env key. Both honor MIDBRAIN_STATE_DIR.
      await installShim("claude", { mode: "install", isDev: true });
      await runSelfRepair(NPX_CTX);

      // Shim + key landed under the durable mount, not the ephemeral dirs.
      await assertSandboxed(env, relocatedShim());
      await assertSandboxed(env, relocatedKey());
      expect(await fs.stat(relocatedShim())).toBeTruthy();
      expect((await fs.readFile(relocatedKey(), "utf8")).trim()).toBe(TEST_KEY);
      // The ephemeral locations were NOT used.
      await expect(fs.stat(hostShim())).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(hostKey())).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      delete process.env.MIDBRAIN_STATE_DIR;
      delete process.env.MIDBRAIN_API_KEY;
    }
  });

  it("shim + key survive a cold respawn: the ephemeral dirs are wiped but ~/.claude persists", async () => {
    process.env.MIDBRAIN_STATE_DIR = stateDir();
    process.env.MIDBRAIN_API_KEY = TEST_KEY;
    try {
      await installShim("claude", { mode: "install", isDev: true });
      await runSelfRepair(NPX_CTX); // "first boot" writes durable state

      // Simulate the --rm respawn: wipe everything NOT under ~/.claude.
      await wipeEphemeralDirs();

      // The durable shim + key are still present at t=0 of the next spawn,
      // BEFORE any server work — this is what closes the shim-missing race.
      expect(await fs.stat(relocatedShim())).toBeTruthy();
      expect((await fs.readFile(relocatedKey(), "utf8")).trim()).toBe(TEST_KEY);
    } finally {
      delete process.env.MIDBRAIN_STATE_DIR;
      delete process.env.MIDBRAIN_API_KEY;
    }
  });

  it("host parity: with the env UNSET, everything stays on the historical paths", async () => {
    process.env.MIDBRAIN_API_KEY = TEST_KEY;
    try {
      await installShim("claude", { mode: "install", isDev: true });
      await runSelfRepair(NPX_CTX);

      // Historical locations used; nothing relocated under ~/.claude/.midbrain.
      expect(await fs.stat(hostShim())).toBeTruthy();
      expect((await fs.readFile(hostKey(), "utf8")).trim()).toBe(TEST_KEY);
      await expect(fs.stat(stateDir())).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      delete process.env.MIDBRAIN_API_KEY;
    }
  });
});
