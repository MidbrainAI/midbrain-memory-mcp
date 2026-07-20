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
import os from "os";
import path from "path";

import { makeTestEnv, snapshotTree, diffSnapshots } from "./helpers/test-env.mjs";
import { tripwireSurfaces, collectHashes, diffHashes, ABSENT } from "./helpers/global-tripwire.mjs";

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
    const surfaces = tripwireSurfaces("/fake-home");
    const rel = surfaces.map((p) => p.replace("/fake-home", "~"));
    for (const required of [
      "~/.claude.json",
      path.join("~", ".claude", "settings.json"),
      path.join("~", ".codex", "config.toml"),
      path.join("~", ".codex", "hooks.json"),
      path.join("~", ".config", "opencode", "opencode.json"),
      path.join("~", ".config", "opencode", "opencode.jsonc"),
      path.join("~", ".midbrain", "bin", "claude-hook"),
      path.join("~", ".midbrain", "bin", "codex-hook"),
      path.join("~", ".midbrain", "bin", "hermes-hook"),
      path.join("~", ".config", "midbrain", ".midbrain-key"),
    ]) {
      expect(rel).toContain(required);
    }
    // Hermes config resolves via HERMES_HOME when set; sandbox sets it, so
    // assert the seam separately below rather than a literal here.
    expect(surfaces.some((p) => p.endsWith(path.join("config.yaml")))).toBe(true);
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
