/**
 * Behavior-matrix integration tests for PRD-034 (B1–B13) — real filesystem,
 * sandboxed via makeTestEnv(). No fs mocks: these exercise the actual
 * adapters, the actual gate, and the actual shim files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";

import { makeTestEnv, diffSnapshots } from "./helpers/test-env.mjs";
import { runSelfRepair, checkForUpdate } from "../install.mjs";
import { REPO_ROOT } from "../shared/clients/utils.mjs";
import { buildShimBody, installShim, stableShimPath, shellQuote } from "../shared/clients/shim.mjs";

const IS_WIN = process.platform === "win32";

const DURABLE = { context: { kind: "durable", path: "/durable/install" } };
const NPX_CTX = {
  context: { kind: "npx-cache", path: "/Users/u/.npm/_npx/abc123/node_modules/midbrain-memory-mcp" },
};

/** The incident state: direct script paths at volatile locations, 10s timeouts. */
function staleClaudeSettings() {
  return {
    otherSetting: true,
    permissions: { allow: ["custom.perm"] },
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "custom-user-hook --keep" }] },
        {
          hooks: [{
            type: "command",
            command:
              "/Users/u/hermes-agent/node /private/tmp/midbrain-pr33-hermes-setup-headless/repo/plugins/claude-code/capture-user.mjs",
            timeout: 10,
          }],
        },
      ],
      Stop: [
        {
          hooks: [{
            type: "command",
            command:
              "node /Users/u/.npm/_npx/0fd4a1b2/node_modules/midbrain-memory-mcp/plugins/claude-code/capture-assistant.mjs",
            timeout: 10,
            async: true,
          }],
        },
      ],
      Notification: [{ hooks: [{ type: "command", command: "my-custom-notifier" }] }],
    },
  };
}

function canonicalClaudeSettings() {
  // Derive the exact command from the source of truth (platform-correct shim
  // filename + shellQuote) rather than reconstructing it, so the expected
  // value matches what claude.mjs actually writes on any OS.
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

async function seedStaleEverything(env) {
  // claude
  await fs.writeFile(env.paths.claudeSettings, JSON.stringify(staleClaudeSettings(), null, 2) + "\n");
  // codex: legacy direct hook commands
  await fs.mkdir(path.dirname(env.paths.codexHooks), { recursive: true });
  await fs.writeFile(env.paths.codexHooks, JSON.stringify({
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /old/plugins/codex/capture-user.mjs", timeout: 10 }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: "node /old/plugins/codex/capture-tool.mjs", timeout: 10 }] }],
      Stop: [{ hooks: [{ type: "command", command: "node /old/plugins/codex/capture-assistant.mjs", timeout: 10 }] }],
    },
  }, null, 2) + "\n");
  // hermes: stale legacy hook commands
  await fs.writeFile(env.paths.hermesConfig, [
    "hooks:",
    "  pre_llm_call:",
    "    - command: node /old/plugins/hermes/capture-user.mjs",
    "      timeout: 10",
    "  post_llm_call:",
    "    - command: node /old/plugins/hermes/capture-assistant.mjs",
    "      timeout: 10",
    "",
  ].join("\n"));
  // opencode: stale plugins + old-format marker
  await fs.mkdir(env.paths.opencodePlugins, { recursive: true });
  await fs.writeFile(path.join(env.paths.opencodePlugins, "midbrain-memory.ts"), "// stale plugin\n");
  await fs.writeFile(path.join(env.paths.opencodePlugins, "midbrain-shared.mjs"), "// stale bundle\n");
  await fs.writeFile(path.join(env.paths.opencodePlugins, ".midbrain-repo-root"),
    "midbrain-memory-mcp@0.0.1:/private/tmp/old-clone\n");
  // nanoclaw: stale installed skill
  await fs.mkdir(path.dirname(env.paths.nanoclawSkill), { recursive: true });
  await fs.writeFile(env.paths.nanoclawSkill, "stale skill\n");
}

let env;
let errSpy;

beforeEach(async () => {
  env = await makeTestEnv({ clients: ["claude", "codex", "hermes", "opencode", "nanoclaw"] });
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  errSpy.mockRestore();
  await env.restore();
});

function stderrText() {
  return errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

// ===================================================================
// B1 — volatile contexts never write; exactly one stderr skip-line
// ===================================================================

describe("B1 / AC-1 — volatile launch contexts skip all repair", () => {
  it.each([
    ["tmp", "/private/tmp/midbrain-clone/repo"],
    ["worktree", "/Users/u/midbrain-wt"],
    ["ci", "/home/runner/work/midbrain/repo"],
  ])("kind=%s: zero bytes change across every client surface", async (kind, p) => {
    await seedStaleEverything(env);
    const before = await env.snapshot();

    const result = await runSelfRepair({ context: { kind, path: p } });

    expect(result.skipped).toBe(true);
    expect(diffSnapshots(before, await env.snapshot())).toEqual([]);

    const skipLines = errSpy.mock.calls
      .map((c) => c.join(" "))
      .filter((line) => line.includes("self-repair skipped"));
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]).toBe(
      `[midbrain] self-repair skipped: running from ${kind} (${p}); run 'npx midbrain-memory-mcp install' to repair configs from a durable install`
    );
  });

  it.each([
    ["worktree", { ".git": "gitdir: /elsewhere/.git/worktrees/x\n" }, true],
    ["tmp", {}, true],
    ["npx-cache", { "_npx/beef99/node_modules/midbrain-memory-mcp/package.json": "{}" }, false],
  ])(
    "default seam: real classification of a real %s fixture drives the gate",
    async (kind, structure, expectSkipped) => {
      // No context injected: runSelfRepair classifies repoRoot itself.
      // Fixtures live under the sandbox TMPDIR (the classifier's ambient
      // os.tmpdir()), so order rules are exercised for real: a .git FILE
      // wins over tmp; an _npx segment wins over tmp; a plain dir is tmp.
      let fixtureRoot = path.join(env.tmp, "fixture-root");
      for (const [rel, content] of Object.entries(structure)) {
        const full = path.join(fixtureRoot, rel);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content, "utf8");
      }
      await fs.mkdir(fixtureRoot, { recursive: true });
      if (kind === "npx-cache") {
        fixtureRoot = path.join(fixtureRoot, "_npx", "beef99", "node_modules", "midbrain-memory-mcp");
      }

      const result = await runSelfRepair({ repoRoot: fixtureRoot });

      expect(result.skipped).toBe(expectSkipped);
      expect(result.kind).toBe(kind);
    }
  );

  it("checkForUpdate wiring: volatile context skips repair and never fetches", async () => {
    await seedStaleEverything(env);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false });
    const before = await env.snapshot();

    await checkForUpdate({ context: { kind: "tmp", path: "/tmp/x" } });

    expect(diffSnapshots(before, await env.snapshot())).toEqual([]);
    expect(stderrText()).toContain("self-repair skipped: running from tmp (/tmp/x)");
    expect(fetchSpy).not.toHaveBeenCalled(); // fresh sandbox throttle cache
    fetchSpy.mockRestore();
  });
});

// ===================================================================
// B2/B5/AC-7 — stale hooks repaired to the canonical claude-hook shim
// ===================================================================

describe("B2/B5/AC-7 — claude hooks repaired to canonical shim", () => {
  it.each([["durable", DURABLE], ["npx-cache", NPX_CTX]])(
    "context=%s: direct-path hooks become shim hooks; custom hooks survive",
    async (_label, ctx) => {
      await fs.writeFile(env.paths.claudeSettings, JSON.stringify(staleClaudeSettings(), null, 2) + "\n");

      const result = await runSelfRepair(ctx);
      expect(result.skipped).toBe(false);

      const settings = JSON.parse(await fs.readFile(env.paths.claudeSettings, "utf8"));
      const expected = canonicalClaudeSettings();

      // exactly one midbrain group per event, canonical shape
      const upsGroups = settings.hooks.UserPromptSubmit;
      const midUps = upsGroups.filter((g) => g.hooks.some((h) => h.command.includes("claude-hook")));
      expect(midUps).toEqual(expected.hooks.UserPromptSubmit);
      const stopGroups = settings.hooks.Stop;
      const midStop = stopGroups.filter((g) => g.hooks.some((h) => h.command.includes("claude-hook")));
      expect(midStop).toEqual(expected.hooks.Stop);

      // no legacy commands anywhere
      const allCommands = JSON.stringify(settings.hooks);
      expect(allCommands).not.toContain("capture-user.mjs");
      expect(allCommands).not.toContain("capture-assistant.mjs");

      // user hooks preserved
      expect(allCommands).toContain("custom-user-hook --keep");
      expect(allCommands).toContain("my-custom-notifier");
      expect(settings.hooks.Notification).toEqual(staleClaudeSettings().hooks.Notification);

      // unrelated settings preserved
      expect(settings.otherSetting).toBe(true);
      expect(settings.permissions.allow).toContain("custom.perm");

      // shim installed, canonical, executable
      const shimPath = env.paths.claudeShim;
      expect(await fs.readFile(shimPath, "utf8")).toBe(buildShimBody("claude"));
      if (!IS_WIN) expect((await fs.stat(shimPath)).mode & 0o777).toBe(0o755);

      expect(stderrText()).toContain("Claude Code hooks repaired");
    }
  );
});

// ===================================================================
// AC-3 — no volatile paths in anything repair wrote
// ===================================================================

describe("AC-3 — repaired surfaces carry no volatile or checkout paths", () => {
  it("grep of every written claude surface finds no tmpdir/_npx/checkout values", async () => {
    await fs.writeFile(env.paths.claudeSettings, JSON.stringify(staleClaudeSettings(), null, 2) + "\n");

    await runSelfRepair(NPX_CTX);

    const written = [
      await fs.readFile(env.paths.claudeSettings, "utf8"),
      await fs.readFile(env.paths.claudeShim, "utf8"),
    ].join("\n");
    // the seeded stale state contained _npx and /private/tmp — repair must
    // have removed every one of them (midbrain-owned surfaces only)
    const midbrainLines = written.split("\n").filter((l) => l.includes("midbrain") || l.includes("claude-hook"));
    for (const line of midbrainLines) {
      expect(line).not.toContain("_npx");
      expect(line).not.toContain("/private/tmp");
      expect(line).not.toContain(REPO_ROOT);
    }
  });
});

// ===================================================================
// B3/AC-5 — canonical state: zero writes, zero mtime churn
// ===================================================================

describe("B3/AC-5 — already-canonical sandbox is untouched (no mtime churn)", () => {
  it("second repair pass changes nothing at all", async () => {
    await fs.writeFile(env.paths.claudeSettings, JSON.stringify(staleClaudeSettings(), null, 2) + "\n");
    await runSelfRepair(DURABLE); // converge to canonical

    await new Promise((r) => setTimeout(r, 10));
    const before = await env.snapshot();
    await runSelfRepair(NPX_CTX); // any canonical context
    expect(diffSnapshots(before, await env.snapshot())).toEqual([]);
  });
});

// ===================================================================
// B11 — canonical hooks, shim deleted: shim reinstalled, settings untouched
// ===================================================================

describe("B11 — missing shim is reinstalled without touching settings", () => {
  it("reinstalls the shim; settings mtime unchanged", async () => {
    await fs.writeFile(env.paths.claudeSettings, JSON.stringify(staleClaudeSettings(), null, 2) + "\n");
    await runSelfRepair(DURABLE);
    await fs.rm(env.paths.claudeShim);

    await new Promise((r) => setTimeout(r, 10));
    const settingsStat = await fs.stat(env.paths.claudeSettings);
    await runSelfRepair(DURABLE);

    expect(await fs.readFile(env.paths.claudeShim, "utf8")).toBe(buildShimBody("claude"));
    expect((await fs.stat(env.paths.claudeSettings)).mtimeMs).toBe(settingsStat.mtimeMs);
  });
});

// ===================================================================
// S2d — OpenCode marker is version-only; AC-3 across every surface
// ===================================================================

describe("S2d/AC-3 — no repaired surface carries volatile or checkout paths", () => {
  it("opencode marker becomes version-only after repair", async () => {
    await seedStaleEverything(env);
    await runSelfRepair(NPX_CTX);

    const marker = await fs.readFile(path.join(env.paths.opencodePlugins, ".midbrain-repo-root"), "utf8");
    const { PKG_NAME, PKG_VERSION } = await import("../shared/clients/utils.mjs");
    expect(marker.trim()).toBe(`${PKG_NAME}@${PKG_VERSION}`);
    expect(marker).not.toContain(REPO_ROOT);
    expect(marker).not.toContain(":/");
  });

  it("full-converge grep: every midbrain-written surface is free of tmp/_npx/checkout paths", async () => {
    await seedStaleEverything(env);
    await runSelfRepair(DURABLE);

    const surfaces = [
      env.paths.claudeSettings,
      env.paths.claudeShim,
      env.paths.codexHooks,
      env.paths.codexShim,
      env.paths.hermesConfig,
      env.paths.hermesShim,
      path.join(env.paths.opencodePlugins, ".midbrain-repo-root"),
      env.paths.nanoclawSkill,
    ];
    for (const surface of surfaces) {
      const content = await fs.readFile(surface, "utf8");
      const midbrainLines = content.split("\n").filter((l) =>
        l.includes("midbrain") || l.includes("-hook"));
      for (const line of midbrainLines) {
        // user-authored stale lines were removed by repair; midbrain-owned
        // lines must never contain volatile or checkout locations
        expect(line, `${surface}: ${line}`).not.toContain("_npx");
        expect(line, `${surface}: ${line}`).not.toContain("/private/tmp");
        expect(line, `${surface}: ${line}`).not.toContain(REPO_ROOT);
      }
    }
  });
});

// ===================================================================
// B11 for codex/hermes — shim reinstalled without config churn
// ===================================================================

describe("B11 — codex/hermes missing shim reinstalled without config churn", () => {
  it("codex: shim reinstalled, hooks.json mtime unchanged", async () => {
    await seedStaleEverything(env);
    await runSelfRepair(DURABLE); // converge
    await fs.rm(env.paths.codexShim);

    await new Promise((r) => setTimeout(r, 10));
    const hooksStat = await fs.stat(env.paths.codexHooks);
    await runSelfRepair(DURABLE);

    expect(await fs.readFile(env.paths.codexShim, "utf8")).toBe(buildShimBody("codex"));
    expect((await fs.stat(env.paths.codexHooks)).mtimeMs).toBe(hooksStat.mtimeMs);
  });

  it("hermes: shim reinstalled, config.yaml mtime unchanged", async () => {
    await seedStaleEverything(env);
    await runSelfRepair(DURABLE); // converge
    await fs.rm(env.paths.hermesShim);

    await new Promise((r) => setTimeout(r, 10));
    const configStat = await fs.stat(env.paths.hermesConfig);
    await runSelfRepair(DURABLE);

    expect(await fs.readFile(env.paths.hermesShim, "utf8")).toBe(buildShimBody("hermes"));
    expect((await fs.stat(env.paths.hermesConfig)).mtimeMs).toBe(configStat.mtimeMs);
  });
});

// ===================================================================
// AC-5 (full) — converge everything, then a repair pass changes nothing
// ===================================================================

describe("AC-5 full — converged 5-client sandbox has zero churn on repair", () => {
  it("no file content or mtime changes anywhere in the sandbox", async () => {
    await seedStaleEverything(env);
    await runSelfRepair(DURABLE); // converge all clients

    await new Promise((r) => setTimeout(r, 10));
    const before = await env.snapshot();
    await runSelfRepair(NPX_CTX);
    expect(diffSnapshots(before, await env.snapshot())).toEqual([]);
  });
});

// ===================================================================
// S3 — dev marker + mutual pinning (B4/B6/B7, AC-4)
// ===================================================================

describe("S3 — dev install marks entries; repair and install respect the marker", () => {
  async function runInstaller(opts) {
    const { main } = await import("../install.mjs");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main({ nonInteractive: true, skipRules: true, ...opts });
      return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    } finally {
      logSpy.mockRestore();
    }
  }

  beforeEach(() => {
    process.env.MIDBRAIN_API_KEY = "test-key-dev-marker";
  });

  it("B6: install --dev writes MIDBRAIN_DEV markers, dev shim bodies, and a banner", async () => {
    const stdout = await runInstaller({ isDev: true });

    const claudeJson = JSON.parse(await fs.readFile(env.paths.claudeJson, "utf8"));
    const claudeEntry = claudeJson.mcpServers["midbrain-memory"];
    expect(claudeEntry.env.MIDBRAIN_DEV).toBe("1");
    expect(claudeEntry.command).toBe(process.execPath);
    expect(claudeEntry.args[0]).toContain(REPO_ROOT);

    const codexToml = await fs.readFile(env.paths.codexConfig, "utf8");
    expect(codexToml).toContain("MIDBRAIN_DEV");

    const opencodeJson = JSON.parse(await fs.readFile(env.paths.opencodeConfig, "utf8"));
    expect(opencodeJson.mcp["midbrain-memory"].environment.MIDBRAIN_DEV).toBe("1");

    const hermesYaml = await fs.readFile(env.paths.hermesConfig, "utf8");
    expect(hermesYaml).toContain("MIDBRAIN_DEV");

    const { isDevShimContent } = await import("../shared/clients/shim.mjs");
    for (const shim of [env.paths.claudeShim, env.paths.codexShim, env.paths.hermesShim]) {
      expect(isDevShimContent(await fs.readFile(shim, "utf8")), shim).toBe(true);
    }

    expect(stdout).toContain("DEV INSTALL");
    expect(stdout).toContain("npx midbrain-memory-mcp install");
  });

  it("B4/AC-4: a canonical instance's repair pass leaves dev state byte-identical", async () => {
    await runInstaller({ isDev: true });

    await new Promise((r) => setTimeout(r, 10));
    const before = await env.snapshot();
    await runSelfRepair(NPX_CTX); // canonical npx instance starting up
    expect(diffSnapshots(before, await env.snapshot())).toEqual([]);
  });

  it("B4 + stale hooks: repair fixes hook entries but preserves the dev shim body", async () => {
    await runInstaller({ isDev: true });
    const devShimBody = await fs.readFile(env.paths.claudeShim, "utf8");

    // Someone hand-broke the hook entries; the dev shim must survive repair.
    const settings = JSON.parse(await fs.readFile(env.paths.claudeSettings, "utf8"));
    settings.hooks.UserPromptSubmit = [
      { hooks: [{ type: "command", command: "node /old/plugins/claude-code/capture-user.mjs", timeout: 10 }] },
    ];
    await fs.writeFile(env.paths.claudeSettings, JSON.stringify(settings, null, 2) + "\n");

    await runSelfRepair(DURABLE);

    const repaired = JSON.parse(await fs.readFile(env.paths.claudeSettings, "utf8"));
    const cmd = repaired.hooks.UserPromptSubmit.at(-1).hooks[0].command;
    expect(cmd).toContain("claude-hook");
    expect(cmd).not.toContain("capture-user.mjs");
    expect(await fs.readFile(env.paths.claudeShim, "utf8")).toBe(devShimBody);
  });

  it("B7: explicit install (no flag) drops markers and restores canonical everywhere", async () => {
    await runInstaller({ isDev: true });
    await runInstaller({});

    const claudeJson = JSON.parse(await fs.readFile(env.paths.claudeJson, "utf8"));
    const claudeEntry = claudeJson.mcpServers["midbrain-memory"];
    expect(claudeEntry.env.MIDBRAIN_DEV).toBeUndefined();
    expect(claudeEntry.command).toBe("npx");
    expect(claudeEntry.args).toEqual(["-y", "midbrain-memory-mcp@latest"]);

    const codexToml = await fs.readFile(env.paths.codexConfig, "utf8");
    expect(codexToml).not.toContain("MIDBRAIN_DEV");
    const opencodeJson = JSON.parse(await fs.readFile(env.paths.opencodeConfig, "utf8"));
    expect(opencodeJson.mcp["midbrain-memory"].environment.MIDBRAIN_DEV).toBeUndefined();
    const hermesYaml = await fs.readFile(env.paths.hermesConfig, "utf8");
    expect(hermesYaml).not.toContain("MIDBRAIN_DEV");

    const { isDevShimContent } = await import("../shared/clients/shim.mjs");
    for (const shim of [env.paths.claudeShim, env.paths.codexShim, env.paths.hermesShim]) {
      expect(isDevShimContent(await fs.readFile(shim, "utf8")), shim).toBe(false);
    }
  });

  it("pinned entry + dev marker: pinning survives the dev round-trip", async () => {
    const pinned = {
      mcpServers: {
        "midbrain-memory": {
          type: "stdio",
          command: "npx",
          args: ["-y", "midbrain-memory-mcp@0.4.5"],
          env: { MIDBRAIN_CLIENT: "claude", KEEP_ME: "yes" },
        },
      },
    };
    await fs.writeFile(env.paths.claudeJson, JSON.stringify(pinned, null, 2) + "\n");

    await runInstaller({ isDev: true });
    let entry = JSON.parse(await fs.readFile(env.paths.claudeJson, "utf8")).mcpServers["midbrain-memory"];
    // pinned entries are preserved wholesale (classifyEntry contract)
    expect(entry.args).toEqual(["-y", "midbrain-memory-mcp@0.4.5"]);
    expect(entry.env.KEEP_ME).toBe("yes");

    await runInstaller({});
    entry = JSON.parse(await fs.readFile(env.paths.claudeJson, "utf8")).mcpServers["midbrain-memory"];
    expect(entry.args).toEqual(["-y", "midbrain-memory-mcp@0.4.5"]);
    expect(entry.env.KEEP_ME).toBe("yes");
  });
});

// ===================================================================
// B8/AC-6 — explicit install still covers all four config clients
// ===================================================================

describe("B8/AC-6 — explicit install repairs all four detected clients", () => {
  it("installs opencode + claude + codex + hermes in one run", async () => {
    process.env.MIDBRAIN_API_KEY = "test-key-b8";
    const { main } = await import("../install.mjs");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main({ nonInteractive: true, skipRules: true });
    } finally {
      logSpy.mockRestore();
    }

    const claudeJson = JSON.parse(await fs.readFile(env.paths.claudeJson, "utf8"));
    expect(claudeJson.mcpServers["midbrain-memory"].command).toBe("npx");
    expect((await fs.readFile(env.paths.codexConfig, "utf8"))).toContain("midbrain-memory");
    expect(JSON.parse(await fs.readFile(env.paths.opencodeConfig, "utf8")).mcp["midbrain-memory"]).toBeDefined();
    expect((await fs.readFile(env.paths.hermesConfig, "utf8"))).toContain("midbrain-memory");
    // hooks/shims written for the hook-based clients
    for (const shim of [env.paths.claudeShim, env.paths.codexShim, env.paths.hermesShim]) {
      await expect(fs.access(shim)).resolves.toBeUndefined();
    }
  });
});

// ===================================================================
// B9 — corrupt config: skip that client, keep going, never crash
// ===================================================================

describe("B9/B12 — per-client fail-open", () => {
  it("corrupt claude settings: claude skipped, codex still repaired, no crash", async () => {
    await seedStaleEverything(env);
    await fs.writeFile(env.paths.claudeSettings, "{ not json", "utf8");
    const claudeBytes = await fs.readFile(env.paths.claudeSettings, "utf8");

    await expect(runSelfRepair(DURABLE)).resolves.toMatchObject({ skipped: false });

    expect(await fs.readFile(env.paths.claudeSettings, "utf8")).toBe(claudeBytes);
    const codexHooks = await fs.readFile(env.paths.codexHooks, "utf8");
    expect(codexHooks).toContain("codex-hook");
  });

  it("read-only claude settings (write EACCES): claude skipped, codex still repaired, no crash", async () => {
    await seedStaleEverything(env);
    const claudeBytes = await fs.readFile(env.paths.claudeSettings, "utf8");
    // A read-only FILE forces the EACCES on write (a read-only dir would not:
    // overwriting an existing file needs write perm on the file, not the dir).
    await fs.chmod(env.paths.claudeSettings, 0o444);
    try {
      await expect(runSelfRepair(DURABLE)).resolves.toMatchObject({ skipped: false });
      expect(await fs.readFile(env.paths.claudeSettings, "utf8")).toBe(claudeBytes);
      const codexHooks = await fs.readFile(env.paths.codexHooks, "utf8");
      expect(codexHooks).toContain("codex-hook");
    } finally {
      await fs.chmod(env.paths.claudeSettings, 0o644);
    }
  });
});

// ===================================================================
// B20 / AC-15 — one startup converges every client; user-owned and
// dev-marked state pinned; second pass is zero-write
// ===================================================================

describe("B20 / AC-15 — cross-client convergence in one startup", () => {
  async function walkFiles(dir, out = []) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walkFiles(full, out);
      else if (entry.isFile()) out.push(full);
    }
    return out;
  }

  it("repairs stale midbrain state across all detected clients, preserving user and dev state", async () => {
    await seedStaleEverything(env);

    // user-owned state in every client surface (claude custom hooks +
    // permissions come from staleClaudeSettings itself)
    const codexHooks = JSON.parse(await fs.readFile(env.paths.codexHooks, "utf8"));
    codexHooks.hooks.UserPromptSubmit.unshift({ hooks: [{ type: "command", command: "/bin/echo codex-user-hook" }] });
    await fs.writeFile(env.paths.codexHooks, JSON.stringify(codexHooks, null, 2) + "\n");
    await fs.writeFile(env.paths.hermesConfig,
      "model: user-picked\n" + (await fs.readFile(env.paths.hermesConfig, "utf8")) +
      "  session_start:\n    - command: my-hermes-user-hook\n");
    const opencodeUserFile = path.join(env.paths.opencodePlugins, "clients", "user-owned.txt");
    await fs.mkdir(path.dirname(opencodeUserFile), { recursive: true });
    await fs.writeFile(opencodeUserFile, "user content\n");

    // dev-marked state: a developer's claude shim from an earlier `install --dev`
    await installShim("claude", { mode: "install", isDev: true });
    const devShimBody = await fs.readFile(env.paths.claudeShim, "utf8");

    await runSelfRepair(DURABLE);

    // 1. canonical convergence: no volatile path survives anywhere in the home
    for (const file of await walkFiles(env.home)) {
      const content = await fs.readFile(file, "utf8");
      expect(content, `volatile path leaked into ${file}`).not.toMatch(/_npx|\/private\/tmp\/|\/old\/plugins\//);
    }

    // 2. per-client canonical state
    const claude = JSON.parse(await fs.readFile(env.paths.claudeSettings, "utf8"));
    const claudeCanonical = canonicalClaudeSettings();
    expect(claude.hooks.UserPromptSubmit).toContainEqual(claudeCanonical.hooks.UserPromptSubmit[0]);
    expect(claude.hooks.Stop).toContainEqual(claudeCanonical.hooks.Stop[0]);
    const codexAfter = JSON.parse(await fs.readFile(env.paths.codexHooks, "utf8"));
    for (const [event, role] of [["UserPromptSubmit", "user"], ["PostToolUse", "tool"], ["Stop", "assistant"]]) {
      const commands = codexAfter.hooks[event].flatMap((g) => g.hooks.map((h) => h.command));
      expect(commands.filter((c) => c === `'${env.paths.codexShim}' ${role}`)).toHaveLength(1);
    }
    const hermesAfter = await fs.readFile(env.paths.hermesConfig, "utf8");
    // Parse the YAML and assert on the decoded command values: a raw substring
    // check would fail on Windows, where the yaml serializer double-quotes and
    // backslash-escapes the drive-letter shim path.
    const { parse: parseYaml } = await import("yaml");
    const hermesDoc = parseYaml(hermesAfter);
    const hermesCmds = [
      ...(hermesDoc.hooks?.pre_llm_call ?? []),
      ...(hermesDoc.hooks?.post_llm_call ?? []),
    ].map((h) => h.command);
    expect(hermesCmds).toContain(`'${env.paths.hermesShim}' user`);
    expect(hermesCmds).toContain(`'${env.paths.hermesShim}' assistant`);
    expect(await fs.readFile(path.join(env.paths.opencodePlugins, ".midbrain-repo-root"), "utf8"))
      .not.toContain(":/");
    expect(await fs.readFile(path.join(env.paths.opencodePlugins, "midbrain-shared.mjs"), "utf8"))
      .toBe(await fs.readFile(path.join(REPO_ROOT, "dist", "midbrain-shared.mjs"), "utf8"));
    expect(await fs.readFile(env.paths.nanoclawSkill, "utf8"))
      .toBe(await fs.readFile(path.join(REPO_ROOT, "skills", "nanoclaw", "SKILL.md"), "utf8"));

    // 3. user-owned state preserved everywhere
    const claudeCommands = Object.values(claude.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
    expect(claudeCommands).toContain("custom-user-hook --keep");
    expect(claudeCommands).toContain("my-custom-notifier");
    expect(claude.permissions.allow).toContain("custom.perm");
    const codexCommands = codexAfter.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command));
    expect(codexCommands).toContain("/bin/echo codex-user-hook");
    expect(hermesAfter).toContain("model: user-picked");
    expect(hermesAfter).toContain("my-hermes-user-hook");
    expect(await fs.readFile(opencodeUserFile, "utf8")).toBe("user content\n");

    // 4. dev-marked state preserved byte-identical
    expect(await fs.readFile(env.paths.claudeShim, "utf8")).toBe(devShimBody);

    // 5. steady state: a second startup performs zero writes, zero mtime churn
    const before = await env.snapshot();
    await runSelfRepair(DURABLE);
    expect(diffSnapshots(before, await env.snapshot())).toEqual([]);
  });
});
