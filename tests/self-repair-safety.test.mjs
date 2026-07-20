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
import { buildShimBody } from "../shared/clients/shim.mjs";

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

function canonicalClaudeSettings(home) {
  const shim = path.join(home, ".midbrain", "bin", "claude-hook");
  return {
    hooks: {
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: `'${shim}' user`, timeout: 30 }] },
      ],
      Stop: [
        { hooks: [{ type: "command", command: `'${shim}' assistant`, timeout: 30, async: true }] },
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
      const expected = canonicalClaudeSettings(env.home);

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
      expect((await fs.stat(shimPath)).mode & 0o777).toBe(0o755);

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
