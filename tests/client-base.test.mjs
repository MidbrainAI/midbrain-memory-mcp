/**
 * Unit tests for shared/clients/base.mjs
 *
 * Tests the key resolution chain in BaseClient.resolveKey(), including:
 *   - EACCES on a key file is a hard error
 *   - Empty key files are a hard error naming the file path
 *   - ENOENT falls through silently
 *   - Project→global fallthrough emits a WARN to stderr
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";

import { makeResetMocks, makeReadFileReturns } from "./fs-mock.mjs";

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

const { BaseClient } = await import("../shared/clients/base.mjs");

const resetMocks = makeResetMocks(mocks);
const readFileReturns = makeReadFileReturns(mocks);

/** Minimal concrete subclass for testing BaseClient directly. */
class TestClient extends BaseClient {
  get id() { return "test"; }
  get displayName() { return "Test"; }
  isInstalled() { return true; }
  async writeKey() { return "written"; }
  async installGlobal() { return []; }
  async installProject() { return []; }
  projectConfigFiles() { return []; }
}

// ===================================================================
// tryReadKey behaviour (exercised via resolveKey)
// ===================================================================

describe("BaseClient.resolveKey — EACCES", () => {
  const client = new TestClient();
  const PROJECT_DIR = "/home/testuser/proj";
  const keyPath = path.join(PROJECT_DIR, ".midbrain", ".midbrain-key");
  const savedEnv = {};

  beforeEach(() => {
    resetMocks();
    savedEnv.MIDBRAIN_PROJECT_DIR = process.env.MIDBRAIN_PROJECT_DIR;
    savedEnv.MIDBRAIN_API_KEY = process.env.MIDBRAIN_API_KEY;
    delete process.env.MIDBRAIN_PROJECT_DIR;
    delete process.env.MIDBRAIN_API_KEY;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("throws when project key file has EACCES", async () => {
    const err = new Error(`EACCES: permission denied, open '${keyPath}'`);
    err.code = "EACCES";
    mocks.readFile.mockRejectedValue(err);

    await expect(client.resolveKey(PROJECT_DIR)).rejects.toThrow(/Permission denied reading key file/);
    await expect(client.resolveKey(PROJECT_DIR)).rejects.toThrow(keyPath);
  });

  it("throws when project key file is empty", async () => {
    readFileReturns({ [keyPath]: "   \n" });

    await expect(client.resolveKey(PROJECT_DIR)).rejects.toThrow(/Key file is empty/);
    await expect(client.resolveKey(PROJECT_DIR)).rejects.toThrow(keyPath);
  });

  it("falls through silently on ENOENT", async () => {
    // All reads return ENOENT — should resolve to null (no key found), not throw
    process.env.MIDBRAIN_API_KEY = "env-key";
    const result = await client.resolveKey(PROJECT_DIR);
    expect(result).toEqual({ key: "env-key", source: "env:MIDBRAIN_API_KEY" });
  });
});

// ===================================================================
// Project→global WARN
// ===================================================================

describe("BaseClient.resolveKey — project→global WARN", () => {
  const client = new TestClient();
  const PROJECT_DIR = "/home/testuser/proj";
  const savedEnv = {};
  let errSpy;

  beforeEach(() => {
    resetMocks();
    savedEnv.MIDBRAIN_PROJECT_DIR = process.env.MIDBRAIN_PROJECT_DIR;
    savedEnv.MIDBRAIN_API_KEY = process.env.MIDBRAIN_API_KEY;
    delete process.env.MIDBRAIN_PROJECT_DIR;
    delete process.env.MIDBRAIN_API_KEY;
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("emits WARN to stderr when projectDir given but no project key found", async () => {
    process.env.MIDBRAIN_API_KEY = "fallback-key";
    await client.resolveKey(PROJECT_DIR);

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/WARN.*no project key found.*falling through/i)
    );
  });

  it("does not emit WARN when no projectDir is provided", async () => {
    process.env.MIDBRAIN_API_KEY = "env-key";
    await client.resolveKey();

    expect(errSpy).not.toHaveBeenCalled();
  });

  it("does not emit WARN when project key is found", async () => {
    const keyPath = path.join(PROJECT_DIR, ".midbrain", ".midbrain-key");
    readFileReturns({ [keyPath]: "project-key\n" });

    await client.resolveKey(PROJECT_DIR);

    expect(errSpy).not.toHaveBeenCalled();
  });
});
