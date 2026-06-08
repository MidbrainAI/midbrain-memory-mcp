/**
 * Unit tests for shared/clients/nanoclaw.mjs
 *
 * All filesystem operations are mocked — no real files read or written.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";

import { makeResetMocks, makeExistsFor, makeReadFileReturns } from "./fs-mock.mjs";

const mocks = vi.hoisted(() => ({
  readFile:   vi.fn(),
  writeFile:  vi.fn().mockResolvedValue(undefined),
  mkdir:      vi.fn().mockResolvedValue(undefined),
  chmod:      vi.fn().mockResolvedValue(undefined),
  stat:       vi.fn(),
  realpath:   vi.fn(),
  copyFile:   vi.fn().mockResolvedValue(undefined),
  existsSync: vi.fn(() => false),
}));

vi.mock("fs/promises", () => ({
  default: { readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir,
             chmod: mocks.chmod, stat: mocks.stat, realpath: mocks.realpath, copyFile: mocks.copyFile },
  readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir, chmod: mocks.chmod,
}));
vi.mock("fs", async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, existsSync: mocks.existsSync, realpathSync: orig.realpathSync };
});

const fs = { readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir,
             chmod: mocks.chmod, stat: mocks.stat, realpath: mocks.realpath, copyFile: mocks.copyFile };
const resetMocks = makeResetMocks(mocks);
const existsFor = makeExistsFor(mocks);
const readFileReturns = makeReadFileReturns(mocks);

const { BaseClient } = await import("../shared/clients/base.mjs");
const { REPO_ROOT } = await import("../shared/clients/utils.mjs");
const { NanoClaw } = await import("../shared/clients/nanoclaw.mjs");

const HOME = os.homedir();
const ENV_ROOT = "/private/tmp/test-nanoclaw";
const INVALID_ROOT = "/private/tmp/not-nanoclaw";
const COMMON_ROOT = path.join(HOME, "nanoclaw-v2");
const KEY_PATH = path.join(HOME, ".config", "nanoclaw", ".midbrain-key");
const SKILL_SRC = path.join(REPO_ROOT, "skills", "nanoclaw", "SKILL.md");

function markerPaths(root) {
  return [
    path.join(root, "container", "Dockerfile"),
    path.join(root, ".claude", "skills"),
  ];
}

function skillPath(root) {
  return path.join(root, ".claude", "skills", "add-midbrain", "SKILL.md");
}

describe("NanoClaw adapter identity", () => {
  const nanoclaw = new NanoClaw();

  it("extends BaseClient", () => {
    expect(nanoclaw).toBeInstanceOf(BaseClient);
  });

  it("has stable id and display name", () => {
    expect(nanoclaw.id).toBe("nanoclaw");
    expect(nanoclaw.displayName).toBe("NanoClaw");
  });
});

describe("NanoClaw.isInstalled", () => {
  const nanoclaw = new NanoClaw();
  const savedEnv = {};

  beforeEach(() => {
    resetMocks();
    savedEnv.NANOCLAW_HOME = process.env.NANOCLAW_HOME;
    delete process.env.NANOCLAW_HOME;
  });

  afterEach(() => {
    if (savedEnv.NANOCLAW_HOME === undefined) delete process.env.NANOCLAW_HOME;
    else process.env.NANOCLAW_HOME = savedEnv.NANOCLAW_HOME;
  });

  it("detects a valid NANOCLAW_HOME", () => {
    process.env.NANOCLAW_HOME = ENV_ROOT;
    existsFor(...markerPaths(ENV_ROOT));

    expect(nanoclaw.isInstalled()).toBe(true);
  });

  it("does not detect an invalid NANOCLAW_HOME", () => {
    process.env.NANOCLAW_HOME = INVALID_ROOT;

    expect(nanoclaw.isInstalled()).toBe(false);
  });

  it("detects a valid common NanoClaw path", () => {
    existsFor(...markerPaths(COMMON_ROOT));

    expect(nanoclaw.isInstalled()).toBe(true);
  });

  it("does not detect when container/Dockerfile is missing", () => {
    existsFor(path.join(COMMON_ROOT, ".claude", "skills"));

    expect(nanoclaw.isInstalled()).toBe(false);
  });

  it("does not detect when .claude/skills is missing", () => {
    existsFor(path.join(COMMON_ROOT, "container", "Dockerfile"));

    expect(nanoclaw.isInstalled()).toBe(false);
  });

  it("returns false when no candidates exist", () => {
    expect(nanoclaw.isInstalled()).toBe(false);
  });
});

describe("NanoClaw key handling", () => {
  const nanoclaw = new NanoClaw();
  beforeEach(resetMocks);

  it("resolves the per-client key through the NanoClaw key path", async () => {
    readFileReturns({ [KEY_PATH]: "nanoclaw-key\n" });

    await expect(nanoclaw.resolveClientKey()).resolves.toEqual({
      key: "nanoclaw-key",
      source: KEY_PATH,
    });
  });

  it("writes the per-client key with chmod 600", async () => {
    const line = await nanoclaw.writeKey("nanoclaw-secret");

    expect(fs.mkdir).toHaveBeenCalledWith(path.dirname(KEY_PATH), { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(KEY_PATH, "nanoclaw-secret\n", "utf8");
    expect(fs.chmod).toHaveBeenCalledWith(KEY_PATH, 0o600);
    expect(line).toContain("~/.config/nanoclaw/.midbrain-key");
    expect(line).toContain("chmod 600");
  });
});

describe("NanoClaw skill install and repair", () => {
  const nanoclaw = new NanoClaw();
  const savedEnv = {};

  beforeEach(() => {
    resetMocks();
    savedEnv.NANOCLAW_HOME = process.env.NANOCLAW_HOME;
    process.env.NANOCLAW_HOME = ENV_ROOT;
    existsFor(...markerPaths(ENV_ROOT));
  });

  afterEach(() => {
    if (savedEnv.NANOCLAW_HOME === undefined) delete process.env.NANOCLAW_HOME;
    else process.env.NANOCLAW_HOME = savedEnv.NANOCLAW_HOME;
  });

  it("copies the packaged skill to the NanoClaw skill destination", async () => {
    const lines = await nanoclaw.installGlobal();
    const dstDir = path.dirname(skillPath(ENV_ROOT));

    expect(fs.mkdir).toHaveBeenCalledWith(dstDir, { recursive: true });
    expect(fs.copyFile).toHaveBeenCalledWith(SKILL_SRC, skillPath(ENV_ROOT));
    expect(lines.some((line) => line.includes("/add-midbrain"))).toBe(true);
  });

  it("reports fresh only when installed skill content matches the packaged skill", async () => {
    const installedSkill = skillPath(ENV_ROOT);
    existsFor(...markerPaths(ENV_ROOT), installedSkill);
    readFileReturns({
      [SKILL_SRC]: "packaged skill\n",
      [installedSkill]: "packaged skill\n",
    });

    await expect(nanoclaw.isFresh()).resolves.toBe(true);
  });

  it("reports stale when installed skill content differs", async () => {
    const installedSkill = skillPath(ENV_ROOT);
    existsFor(...markerPaths(ENV_ROOT), installedSkill);
    readFileReturns({
      [SKILL_SRC]: "packaged skill\n",
      [installedSkill]: "old skill\n",
    });

    await expect(nanoclaw.isFresh()).resolves.toBe(false);
  });

  it("reports stale when the installed skill is missing", async () => {
    await expect(nanoclaw.isFresh()).resolves.toBe(false);
  });

  it("treats absent NanoClaw as fresh because there is nothing to repair", async () => {
    existsFor();

    await expect(nanoclaw.isFresh()).resolves.toBe(true);
  });

  it("re-copies the skill during repair", async () => {
    const lines = await nanoclaw.repairSkill();

    expect(fs.copyFile).toHaveBeenCalledWith(SKILL_SRC, skillPath(ENV_ROOT));
    expect(lines.join("\n")).toContain("NanoClaw skill repaired");
  });
});
