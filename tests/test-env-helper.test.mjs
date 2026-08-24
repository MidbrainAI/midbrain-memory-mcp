/**
 * Self-tests for the PRD-034 S4 sandbox fixture and tripwire internals.
 *
 * These prove the safety net itself: env isolation + restore, client fixture
 * seeding visible to the real adapters, snapshot/diff churn detection, and the
 * tripwire's hash/diff mechanics (against sandbox dirs only — the real-home
 * tripwire is wired separately as vitest globalSetup).
 */

import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "fs";
import os from "os";
import path from "path";

import { makeTestEnv, assertSandboxed, diffSnapshots } from "./helpers/test-env.mjs";
import { tripwireSurfaces, collectHashes, diffHashes, ABSENT } from "./helpers/global-tripwire.mjs";

// Creating directory symlinks needs privilege on Windows (Developer Mode or an
// elevated shell). Probe the real capability once so symlink-dependent tests
// run where supported (Linux, macOS, CI Windows) and skip only where the OS
// refuses — rather than blanket-skipping on all of win32.
const CAN_SYMLINK = (() => {
  let dir;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), "midbrain-symlink-probe-"));
    const target = path.join(dir, "t");
    mkdirSync(target);
    symlinkSync(target, path.join(dir, "l"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
})();

describe("makeTestEnv isolation", () => {
  it("points HOME and adapter env at the sandbox and restores the prior env exactly", async () => {
    const before = {
      HOME: process.env.HOME,
      HERMES_HOME: process.env.HERMES_HOME,
      CI: process.env.CI,
      TMPDIR: process.env.TMPDIR,
    };
    const env = await makeTestEnv();
    try {
      expect(process.env.HOME).toBe(env.home);
      expect(os.homedir()).toBe(env.home);
      expect(os.tmpdir()).toBe(env.tmp);
      expect(process.env.HERMES_HOME).toBe(path.join(env.home, ".hermes"));
      expect(process.env.CI).toBeUndefined();
      expect(env.home.startsWith(env.root)).toBe(true);
    } finally {
      await env.restore();
    }
    expect(process.env.HOME).toBe(before.HOME);
    expect(process.env.HERMES_HOME).toBe(before.HERMES_HOME);
    expect(process.env.CI).toBe(before.CI);
    expect(process.env.TMPDIR).toBe(before.TMPDIR);
    await expect(fs.access(env.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("CI override via opts.env survives the managed defaults", async () => {
    const env = await makeTestEnv({ env: { CI: "1" } });
    try {
      expect(process.env.CI).toBe("1");
    } finally {
      await env.restore();
    }
  });

  it("manages and restores the test sandbox marker and API URL exactly", async () => {
    process.env.MIDBRAIN_TEST_SANDBOX = "prior-sandbox";
    process.env.MIDBRAIN_API_URL = "https://prior.invalid";
    const env = await makeTestEnv();
    try {
      expect(process.env.MIDBRAIN_TEST_SANDBOX).toBe(env.root);
      expect(process.env.MIDBRAIN_API_URL).toBeUndefined();
    } finally {
      await env.restore();
    }
    expect(process.env.MIDBRAIN_TEST_SANDBOX).toBe("prior-sandbox");
    expect(process.env.MIDBRAIN_API_URL).toBe("https://prior.invalid");
    delete process.env.MIDBRAIN_TEST_SANDBOX;
    delete process.env.MIDBRAIN_API_URL;
  });

  it("assertSandboxed accepts inside and relative targets but rejects outside targets", async () => {
    const env = await makeTestEnv();
    try {
      await expect(assertSandboxed(env, path.join(env.home, "inside.key"))).resolves.toBeUndefined();
      await expect(
        assertSandboxed(env, path.relative(path.resolve("."), env.paths.globalKey)),
      ).resolves.toBeUndefined();
      await expect(assertSandboxed(env, path.join(path.dirname(env.root), "outside.key"))).rejects.toThrow(
        /outside test sandbox/,
      );
    } finally {
      await env.restore();
    }
  });

  it.skipIf(!CAN_SYMLINK)("assertSandboxed resolves symlinked parents before checking containment", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "midbrain-prd035-outside-"));
    const env = await makeTestEnv();
    try {
      const insideLink = path.join(env.root, "inside-link");
      const outsideLink = path.join(env.root, "outside-link");
      await fs.symlink(env.home, insideLink, "dir");
      await fs.symlink(outside, outsideLink, "dir");
      await expect(assertSandboxed(env, path.join(insideLink, "key"))).resolves.toBeUndefined();
      await expect(assertSandboxed(env, path.join(outsideLink, "key"))).rejects.toThrow(
        /outside test sandbox/,
      );
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
      await env.restore();
    }
  });

  it("seeds client fixtures the real registry detects — and only those", async () => {
    const env = await makeTestEnv({ clients: ["claude", "codex", "hermes", "opencode"] });
    try {
      const { detectClients } = await import("../shared/clients/registry.mjs");
      const ids = detectClients().map((c) => c.id).sort();
      expect(ids).toEqual(["claude", "codex", "hermes", "opencode"]);
    } finally {
      await env.restore();
    }
  });

  it("seeds a nanoclaw layout the registry detects", async () => {
    const env = await makeTestEnv({ clients: ["nanoclaw"] });
    try {
      const { detectClients } = await import("../shared/clients/registry.mjs");
      expect(detectClients().map((c) => c.id)).toEqual(["nanoclaw"]);
    } finally {
      await env.restore();
    }
  });

  it("pre-seeds a fresh update-check throttle cache in the sandbox tmp", async () => {
    const env = await makeTestEnv();
    try {
      const raw = await fs.readFile(path.join(env.tmp, ".midbrain-update-check.json"), "utf8");
      const cache = JSON.parse(raw);
      expect(Date.now() - cache.lastCheck).toBeLessThan(60_000);
    } finally {
      await env.restore();
    }
  });
});

describe("snapshotTree / diffSnapshots churn detection", () => {
  it("returns [] for an untouched tree and flags content, mtime, added, removed", async () => {
    const env = await makeTestEnv({ clients: ["claude"] });
    try {
      const s1 = await env.snapshot();
      expect(diffSnapshots(s1, await env.snapshot())).toEqual([]);

      // content change
      await fs.writeFile(env.paths.claudeJson, '{"x":1}\n', "utf8");
      const s2 = await env.snapshot();
      expect(diffSnapshots(s1, s2)).toContainEqual({ path: env.paths.claudeJson, change: "content" });

      // mtime-only change (same bytes rewritten later)
      await new Promise((r) => setTimeout(r, 10));
      const bytes = await fs.readFile(env.paths.claudeJson);
      await fs.writeFile(env.paths.claudeJson, bytes);
      const s3 = await env.snapshot();
      expect(diffSnapshots(s2, s3)).toEqual([{ path: env.paths.claudeJson, change: "mtime" }]);

      // added + removed
      const extra = path.join(env.home, "extra.txt");
      await fs.writeFile(extra, "x", "utf8");
      const s4 = await env.snapshot();
      expect(diffSnapshots(s3, s4)).toEqual([{ path: extra, change: "added" }]);
      await fs.rm(env.paths.claudeSettings);
      const s5 = await env.snapshot();
      expect(diffSnapshots(s4, s5)).toContainEqual({ path: env.paths.claudeSettings, change: "removed" });
    } finally {
      await env.restore();
    }
  });
});

describe("tripwire internals (sandbox only)", () => {
  it("covers every PRD-listed real surface", () => {
    // Use an absolute, platform-native fake home so path.join produces the
    // real separator style; then compare separator-agnostically (forward
    // slashes) so this assertion holds on both POSIX and Windows.
    const fakeHome = path.resolve(path.sep, "fake-home");
    const toPosix = (p) => p.split(path.sep).join("/");
    const rel = tripwireSurfaces(fakeHome).map((p) =>
      toPosix(p).replace(toPosix(fakeHome), "~"),
    );
    for (const required of [
      "~/.claude.json",
      "~/.claude/settings.json",
      "~/.codex/config.toml",
      "~/.codex/hooks.json",
      "~/.config/opencode/opencode.json",
      "~/.config/opencode/opencode.jsonc",
      "~/.midbrain/bin/claude-hook",
      "~/.midbrain/bin/codex-hook",
      "~/.midbrain/bin/hermes-hook",
      "~/.config/midbrain/.midbrain-key",
    ]) {
      expect(rel).toContain(required);
    }
    // Hermes config resolves via HERMES_HOME when set; sandbox sets it, so
    // assert the seam separately below rather than a literal here.
    expect(rel.some((p) => p.endsWith("config.yaml"))).toBe(true);
  });

  it("hashes files, marks missing ones ABSENT, and flags create/modify/delete as drift", async () => {
    const env = await makeTestEnv();
    try {
      const a = path.join(env.home, "a.json");
      const b = path.join(env.home, "b.json");
      await fs.writeFile(a, "{}", "utf8");

      const before = collectHashes([a, b]);
      expect(before[b]).toBe(ABSENT);
      expect(before[a]).toMatch(/^[0-9a-f]{64}$/);
      expect(diffHashes(before, collectHashes([a, b]))).toEqual([]);

      await fs.writeFile(a, '{"changed":1}', "utf8"); // modify
      await fs.writeFile(b, "{}", "utf8"); // create
      const after = collectHashes([a, b]);
      expect(diffHashes(before, after).sort()).toEqual([a, b].sort());

      await fs.rm(a); // delete registers as drift from the modified state
      expect(diffHashes(after, collectHashes([a, b]))).toEqual([a]);
    } finally {
      await env.restore();
    }
  });
});
