/**
 * Unit tests for shared/install-context.mjs (PRD-034 S1, AC-2).
 *
 * classifyInstallContext(repoRoot, opts) → { kind, path } with normative
 * first-match order: worktree → npx-cache → tmp → ci → durable.
 * Env and tmpdir are injected so cases are deterministic anywhere,
 * including under a real CI runner.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs/promises";
import { realpathSync } from "fs";
import os from "os";
import path from "path";

import { classifyInstallContext } from "../shared/install-context.mjs";

const NO_ENV = { env: {} };
const roots = [];

async function makeDir(structure = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "midbrain-ctx-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(structure)) {
    const full = path.join(root, rel);
    if (content === null) {
      await fs.mkdir(full, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf8");
    }
  }
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })));
});

describe("classifyInstallContext — kinds (AC-2)", () => {
  it("classifies a path under the ambient tmpdir as tmp", async () => {
    const dir = await makeDir();
    expect(classifyInstallContext(dir, NO_ENV)).toEqual({ kind: "tmp", path: dir });
  });

  it("classifies the realpath of a tmpdir path as tmp (symlinked macOS /var/folders)", async () => {
    const dir = await makeDir();
    const real = realpathSync(dir);
    expect(classifyInstallContext(real, NO_ENV).kind).toBe("tmp");
  });

  it.each([
    "/private/tmp/midbrain-clone/repo",
    "/tmp/midbrain-clone",
    "/tmp",
    "/private/tmp",
  ])("classifies the literal POSIX tmp root path %s as tmp", (p) => {
    expect(classifyInstallContext(p, { env: {}, tmpdir: "/nonexistent-tmp" })).toEqual({ kind: "tmp", path: p });
  });

  it("classifies a directory whose .git is a FILE as worktree", async () => {
    const dir = await makeDir({ ".git": "gitdir: /somewhere/.git/worktrees/x\n" });
    expect(classifyInstallContext(dir, { env: {}, tmpdir: "/nonexistent-tmp" }).kind).toBe("worktree");
  });

  it("does not classify a .git DIRECTORY as worktree (real checkout → durable)", async () => {
    const dir = await makeDir({ ".git/HEAD": "ref: refs/heads/main\n" });
    expect(classifyInstallContext(dir, { env: {}, tmpdir: "/nonexistent-tmp" }).kind).toBe("durable");
  });

  it.each(["1", "true", "TRUE", "yes"])("classifies CI=%s as ci", (v) => {
    expect(classifyInstallContext("/opt/app", { env: { CI: v } }).kind).toBe("ci");
  });

  it.each(["false", "0", "", "FALSE"])("does not classify CI=%j as ci", (v) => {
    expect(classifyInstallContext("/opt/app", { env: { CI: v } }).kind).toBe("durable");
  });

  it("classifies an _npx cache path as npx-cache", () => {
    const p = "/Users/dev/.npm/_npx/0123abc/node_modules/midbrain-memory-mcp";
    expect(classifyInstallContext(p, NO_ENV)).toEqual({ kind: "npx-cache", path: p });
  });

  it("classifies a global npm root as durable", () => {
    const p = "/usr/local/lib/node_modules/midbrain-memory-mcp";
    expect(classifyInstallContext(p, NO_ENV).kind).toBe("durable");
  });
});

describe("classifyInstallContext — normative order (B13, S1 residual)", () => {
  it("npx-cache wins over tmp: _npx under the ambient tmpdir", async () => {
    const base = await makeDir({ "_npx/beef01/node_modules/midbrain-memory-mcp/package.json": "{}" });
    const p = path.join(base, "_npx", "beef01", "node_modules", "midbrain-memory-mcp");
    expect(classifyInstallContext(p, NO_ENV).kind).toBe("npx-cache");
  });

  it("npx-cache wins over ci: CI=1 plus an _npx path", () => {
    const p = "/Users/dev/.npm/_npx/0123abc/node_modules/midbrain-memory-mcp";
    expect(classifyInstallContext(p, { env: { CI: "1" } }).kind).toBe("npx-cache");
  });

  it("tmp wins over ci: CI=1 plus a /tmp path", () => {
    expect(
      classifyInstallContext("/tmp/clone", { env: { CI: "1" }, tmpdir: "/nonexistent-tmp" }).kind
    ).toBe("tmp");
  });

  it("worktree wins over npx-cache: .git file inside an _npx-named path", async () => {
    const base = await makeDir({ "_npx/cafe02/repo/.git": "gitdir: elsewhere\n" });
    const p = path.join(base, "_npx", "cafe02", "repo");
    expect(classifyInstallContext(p, NO_ENV).kind).toBe("worktree");
  });
});

describe("classifyInstallContext — win32-style paths (AC-2)", () => {
  it("classifies a win32 npm-cache _npx path as npx-cache", () => {
    const p = "C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\midbrain-memory-mcp";
    expect(classifyInstallContext(p, NO_ENV).kind).toBe("npx-cache");
  });

  it("classifies a win32 path under a win32 tmpdir as tmp", () => {
    const p = "C:\\Users\\dev\\AppData\\Local\\Temp\\midbrain-clone";
    expect(
      classifyInstallContext(p, { env: {}, tmpdir: "C:\\Users\\dev\\AppData\\Local\\Temp" }).kind
    ).toBe("tmp");
  });

  it("classifies a plain win32 project path as durable", () => {
    expect(
      classifyInstallContext("C:\\projects\\app", { env: {}, tmpdir: "C:\\Users\\dev\\AppData\\Local\\Temp" }).kind
    ).toBe("durable");
  });

  it("does not treat a different win32 drive as under the tmpdir", () => {
    expect(
      classifyInstallContext("D:\\Temp\\x", { env: {}, tmpdir: "C:\\Temp" }).kind
    ).toBe("durable");
  });
});

describe("classifyInstallContext — never throws (B9 spirit)", () => {
  it.each([null, undefined, "", 42])("returns durable for invalid input %j", (input) => {
    const result = classifyInstallContext(input, NO_ENV);
    expect(result.kind).toBe("durable");
  });

  it("returns durable for a nonexistent path outside tmp", () => {
    expect(
      classifyInstallContext("/definitely/not/real/checkout", { env: {}, tmpdir: "/nonexistent-tmp" }).kind
    ).toBe("durable");
  });

  it("defaults env to process.env and tmpdir to os.tmpdir()", async () => {
    const dir = await makeDir();
    // dir is under the real os.tmpdir(); ambient call must classify tmp.
    expect(classifyInstallContext(dir).kind).toBe("tmp");
  });
});
