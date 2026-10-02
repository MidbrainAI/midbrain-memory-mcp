/**
 * Unit tests for the real-home tripwire helpers (PRD-034 rev 3, AC-15).
 *
 * Pure-function coverage only: surface composition against a fake home and
 * hashing semantics in a throwaway tmpdir. The end-to-end drift behavior
 * (globalSetup failing a run) stays a documented manual probe.
 */

import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  tripwireSurfaces,
  tripwireStateDirs,
  snapshotCacheEntries,
  diffCacheEntries,
  snapshotWatched,
  diffWatched,
  collectHashes,
  diffHashes,
  ABSENT,
  DIR,
} from "./helpers/global-tripwire.mjs";

const HOME = "/fake/home";

describe("tripwireSurfaces (AC-15)", () => {
  it("covers the OpenCode cleanup targets, including the legacy clients tree", () => {
    const surfaces = tripwireSurfaces(HOME);
    const plugins = path.join(HOME, ".config", "opencode", "plugins");
    expect(surfaces).toContain(path.join(plugins, "clients"));
    expect(surfaces).toContain(path.join(plugins, "logger.mjs"));
    expect(surfaces).toContain(path.join(plugins, "midbrain-api.mjs"));
    expect(surfaces).toContain(path.join(plugins, "midbrain-common.mjs"));
  });

  it("covers the NanoClaw installed-skill destinations for every candidate root", () => {
    const surfaces = tripwireSurfaces(HOME);
    for (const dir of ["nanoclaw-v2", "nanoclaw", "NanoClaw"]) {
      expect(surfaces).toContain(
        path.join(HOME, dir, ".claude", "skills", "add-midbrain", "SKILL.md"),
      );
    }
  });

  it("honors an explicit NANOCLAW_HOME for the skill destination", () => {
    const saved = process.env.NANOCLAW_HOME;
    process.env.NANOCLAW_HOME = "/opt/ncw";
    try {
      // tripwireSurfaces resolves NANOCLAW_HOME with path.resolve (adds a drive
      // letter on Windows); match that here rather than path.join.
      expect(tripwireSurfaces(HOME)).toContain(
        path.join(path.resolve("/opt/ncw"), ".claude", "skills", "add-midbrain", "SKILL.md"),
      );
    } finally {
      if (saved === undefined) delete process.env.NANOCLAW_HOME;
      else process.env.NANOCLAW_HOME = saved;
    }
  });
});

describe("collectHashes — directory awareness (AC-15)", () => {
  it("records dirs with a DIR sentinel so deleting one registers as drift", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "midbrain-tripwire-unit-"));
    const dir = path.join(root, "clients");
    const file = path.join(root, "config.json");
    const missing = path.join(root, "never-existed");
    try {
      await fs.mkdir(dir);
      await fs.writeFile(file, "{}\n", "utf8");

      const before = collectHashes([dir, file, missing]);
      expect(before[dir]).toBe(DIR);
      expect(before[file]).toMatch(/^[0-9a-f]{64}$/);
      expect(before[missing]).toBe(ABSENT);

      await fs.rm(dir, { recursive: true, force: true });
      const after = collectHashes([dir, file, missing]);
      expect(diffHashes(before, after)).toEqual([dir]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("MidBrain cache entries (#88)", () => {
  const real = '{"text":"real","role":"user","ts":1}\n';
  const leak = '{"text":"msg","role":"user","ts":2}\n';

  it("watches the real offline cache directory, not the log directory", () => {
    const dirs = tripwireStateDirs(HOME);
    expect(dirs).toContain(path.join(HOME, ".cache", "midbrain"));
    expect(dirs.some((d) => d.includes(`${path.sep}Logs${path.sep}`) || d.endsWith(`${path.sep}logs`))).toBe(false);
  });

  it("a boot-time drain is not drift: rename, re-cache and delete keep the counts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "midbrain-tripwire-cache-"));
    const cache = path.join(root, "cache");
    const live = path.join(cache, "midbrain-episodic-cache-aaa.ndjson");
    try {
      await fs.mkdir(cache);
      await fs.writeFile(live, real + real, "utf8");
      const snap = () => snapshotCacheEntries([cache, path.join(root, "missing")]);
      const before = snap();
      expect(Object.keys(before)).toEqual([cache]);
      expect(diffCacheEntries(before, snap())).toEqual([]);

      await fs.rename(live, `${live}.processing`);
      expect(diffCacheEntries(before, snap())).toEqual([]);

      // one entry failed the flush and was re-cached; the batch is removed
      await fs.rm(`${live}.processing`);
      await fs.writeFile(live, real, "utf8");
      expect(diffCacheEntries(before, snap())).toEqual([]);

      await fs.rm(live);
      expect(diffCacheEntries(before, snap())).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("an entry the run added is drift, whether in a new file or on top of an existing one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "midbrain-tripwire-cache-"));
    const cache = path.join(root, "cache");
    const live = path.join(cache, "midbrain-episodic-cache-aaa.ndjson");
    const leaked = path.join(cache, "midbrain-episodic-cache-bbb.ndjson");
    try {
      await fs.mkdir(cache);
      await fs.writeFile(live, real, "utf8");
      const snap = () => snapshotCacheEntries([cache]);
      const before = snap();

      await fs.writeFile(leaked, leak, "utf8");
      expect(diffCacheEntries(before, snap())).toEqual([`${cache}: 1 new cache entry`]);

      // a second copy of an entry that already existed still counts
      await fs.appendFile(live, real, "utf8");
      expect(diffCacheEntries(before, snap())).toEqual([`${cache}: 2 new cache entries`]);

      // a cache dir that did not exist before the run
      const fresh = path.join(root, "fresh");
      await fs.mkdir(fresh);
      await fs.writeFile(path.join(fresh, "midbrain-episodic-cache.ndjson"), leak, "utf8");
      expect(diffCacheEntries({}, snapshotCacheEntries([fresh]))).toEqual([`${fresh}: 1 new cache entry`]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("snapshotWatched/diffWatched report config drift and cache drift for one home", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "midbrain-tripwire-home-"));
    const claudeJson = path.join(home, ".claude.json");
    const cache = path.join(home, ".cache", "midbrain");
    try {
      await fs.writeFile(claudeJson, "{}\n", "utf8");
      await fs.mkdir(cache, { recursive: true });
      await fs.writeFile(path.join(cache, "midbrain-episodic-cache-aaa.ndjson"), real, "utf8");
      const before = snapshotWatched(home);
      expect(diffWatched(before, snapshotWatched(home))).toEqual([]);

      await fs.writeFile(claudeJson, '{"changed":true}\n', "utf8");
      await fs.appendFile(path.join(cache, "midbrain-episodic-cache-aaa.ndjson"), leak, "utf8");
      expect(diffWatched(before, snapshotWatched(home))).toEqual([claudeJson, `${cache}: 1 new cache entry`]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
