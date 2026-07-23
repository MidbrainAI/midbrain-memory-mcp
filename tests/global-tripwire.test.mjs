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
