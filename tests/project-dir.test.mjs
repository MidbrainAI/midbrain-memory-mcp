/**
 * Unit tests for shared/project-dir.mjs (issue #92): which directory a hook
 * resolves from, and which directories may hold the project key.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import {
  configuredProjectDir, effectiveProjectDir, hookProjectDir, isStrictProject, logProjectFallback,
  mainWorktreeRoot, projectRootCandidates,
} from "../shared/project-dir.mjs";

let home;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "midbrain-project-dir-"));
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("hookProjectDir", () => {
  const saved = process.env.MIDBRAIN_PROJECT_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.MIDBRAIN_PROJECT_DIR;
    else process.env.MIDBRAIN_PROJECT_DIR = saved;
  });

  it("uses the client's cwd and falls back to MIDBRAIN_PROJECT_DIR only without one", () => {
    process.env.MIDBRAIN_PROJECT_DIR = "/configured/project";
    expect(configuredProjectDir()).toBe("/configured/project");
    expect(hookProjectDir("/reported/cwd")).toBe("/reported/cwd");
    expect(hookProjectDir(undefined)).toBe("/configured/project");
    expect(hookProjectDir("  ")).toBe("/configured/project");
  });

  it("treats the TERMINAL_CWD placeholder as unset, and reports it", () => {
    process.env.MIDBRAIN_PROJECT_DIR = "${TERMINAL_CWD}";
    expect(configuredProjectDir()).toBeUndefined();
    expect(hookProjectDir("/reported/cwd")).toBe("/reported/cwd");
    expect(hookProjectDir(undefined)).toBeUndefined();
    expect(effectiveProjectDir(undefined)).toEqual({ dir: undefined, unresolved: true });
    expect(effectiveProjectDir("/explicit")).toEqual({ dir: "/explicit", unresolved: false });
  });

  it("returns undefined for a blank or missing cwd with no env, and trims a reported cwd", () => {
    delete process.env.MIDBRAIN_PROJECT_DIR;
    expect(hookProjectDir("   ")).toBeUndefined();
    expect(hookProjectDir(undefined)).toBeUndefined();
    expect(hookProjectDir(" /reported/cwd\n")).toBe("/reported/cwd");
    // an explicit directory keeps its bytes: a directory name may carry spaces
    expect(effectiveProjectDir(" /explicit ")).toEqual({ dir: " /explicit ", unresolved: false });
  });
});

describe("isStrictProject", () => {
  it("is on only for the exact value 1", () => {
    expect(isStrictProject({ MIDBRAIN_STRICT_PROJECT: "1" })).toBe(true);
    expect(isStrictProject({ MIDBRAIN_STRICT_PROJECT: "true" })).toBe(false);
    expect(isStrictProject({})).toBe(false);
  });
});

describe("mainWorktreeRoot", () => {
  it("resolves a linked worktree's .git file, absolute or relative, to the main root", async () => {
    const main = path.join(home, "proj");
    const linked = path.join(home, "wt");
    await fs.mkdir(linked, { recursive: true });
    await fs.writeFile(path.join(linked, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
    expect(await mainWorktreeRoot(linked)).toBe(main);

    await fs.writeFile(path.join(linked, ".git"), "gitdir: ../proj/.git/worktrees/wt\n");
    expect(await mainWorktreeRoot(linked)).toBe(main);
  });

  it("is null for a main worktree, a submodule, and a directory without .git", async () => {
    const main = path.join(home, "proj");
    await fs.mkdir(path.join(main, ".git"), { recursive: true });
    expect(await mainWorktreeRoot(main)).toBeNull();

    const sub = path.join(home, "sub");
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, ".git"), "gitdir: ../proj/.git/modules/sub\n");
    expect(await mainWorktreeRoot(sub)).toBeNull();

    expect(await mainWorktreeRoot(path.join(home, "plain"))).toBeNull();
  });
});

describe("projectRootCandidates", () => {
  it("lists the start directory and its parents, nearest first, stopping below home", async () => {
    const start = path.join(home, "proj", "sub", "deeper");
    await fs.mkdir(start, { recursive: true });
    expect(await projectRootCandidates(start, { homeDir: home })).toEqual([
      start,
      path.join(home, "proj", "sub"),
      path.join(home, "proj"),
    ]);
  });

  it("offers the home directory only as the start directory, never as a parent", async () => {
    expect(await projectRootCandidates(home, { homeDir: home })).toEqual([home]);
    expect(await projectRootCandidates(`${home}${path.sep}`, { homeDir: home })).toEqual([home]);
    const sub = path.join(home, "proj");
    await fs.mkdir(sub, { recursive: true });
    expect(await projectRootCandidates(`${sub}${path.sep}${path.sep}`, { homeDir: home })).toEqual([sub]);
  });

  it("makes a relative start directory absolute instead of walking toward the working directory", async () => {
    const start = path.join(home, "proj", "sub");
    await fs.mkdir(start, { recursive: true });
    const relative = path.relative(process.cwd(), start);
    // on Windows the temp dir may sit on another drive than the working directory: no relative spelling exists
    if (path.isAbsolute(relative)) return;
    expect(await projectRootCandidates(relative, { homeDir: home })).toEqual([start, path.join(home, "proj")]);
  });

  it.skipIf(process.platform === "win32")("stops at home whether home is given as a symlink or its real path", async () => {
    const link = `${home}-link`;
    await fs.symlink(home, link);
    try {
      const start = path.join(home, "proj", "sub");
      await fs.mkdir(start, { recursive: true });
      expect(await projectRootCandidates(start, { homeDir: link })).toEqual([start, path.join(home, "proj")]);
    } finally {
      await fs.unlink(link);
    }
  });

  it.runIf(process.platform === "win32")("keeps the double leading separator of a UNC main worktree", async () => {
    const linked = path.join(home, "wt");
    await fs.mkdir(linked, { recursive: true });
    await fs.writeFile(path.join(linked, ".git"), "gitdir: \\\\server\\share\\repo\\.git\\worktrees\\wt\n");
    expect(await mainWorktreeRoot(linked)).toBe("\\\\server\\share\\repo");
  });

  it("resolves a worktree that is itself named worktrees", async () => {
    const main = path.join(home, "proj");
    const linked = path.join(home, "worktrees");
    await fs.mkdir(linked, { recursive: true });
    await fs.writeFile(path.join(linked, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "worktrees")}\n`);
    expect(await mainWorktreeRoot(linked)).toBe(main);
  });

  it.runIf(process.platform === "win32")("stops at home regardless of drive-letter or path case", async () => {
    const start = path.join(home, "proj", "sub");
    await fs.mkdir(start, { recursive: true });
    const candidates = await projectRootCandidates(start.toUpperCase(), { homeDir: home });
    expect(candidates.map((c) => c.toLowerCase())).toEqual([start, path.join(home, "proj")].map((c) => c.toLowerCase()));
  });

  it("walks a directory outside home up to, not including, the filesystem root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "midbrain-outside-"));
    try {
      const candidates = await projectRootCandidates(path.join(outside, "a"), { homeDir: home });
      expect(candidates[0]).toBe(path.join(outside, "a"));
      expect(candidates).toContain(outside);
      expect(candidates).not.toContain(path.parse(outside).root);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("adds the main worktree's root and parents for a linked worktree", async () => {
    const main = path.join(home, "code", "proj");
    const linked = path.join(home, "wt", "proj-feature");
    await fs.mkdir(linked, { recursive: true });
    await fs.writeFile(path.join(linked, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "proj-feature")}\n`);

    const candidates = await projectRootCandidates(path.join(linked, "src"), { homeDir: home });
    expect(candidates.slice(0, 3)).toEqual([path.join(linked, "src"), linked, path.join(home, "wt")]);
    expect(candidates).toContain(main);
    expect(candidates).toContain(path.join(home, "code"));
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe("logProjectFallback", () => {
  it("warns through the hook logger with the note and the directory", () => {
    const logger = { warn: vi.fn() };
    logProjectFallback({ projectFallbackNote: "no project key covers the project directory; captures from it use the global key", requestedProjectDir: "/work/proj/sub" }, logger);
    expect(logger.warn).toHaveBeenCalledWith(
      "SCOPE: no project key covers the project directory; captures from it use the global key (project directory: /work/proj/sub)",
    );
  });

  it("is silent without a note, and never throws without a logger", () => {
    const logger = { warn: vi.fn() };
    logProjectFallback({ projectFallbackNote: null }, logger);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(() => logProjectFallback({ projectFallbackNote: "x" }, undefined)).not.toThrow();
  });
});
