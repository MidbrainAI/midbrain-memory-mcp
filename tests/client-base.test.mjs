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
const { Generic } = await import("../shared/clients/generic.mjs");

const resetMocks = makeResetMocks(mocks);
const readFileReturns = makeReadFileReturns(mocks);

function fileError(code, filePath) {
  const err = new Error(`${code}: test failure, open '${filePath}'`);
  err.code = code;
  return err;
}

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

  it("treats an unresolved TERMINAL_CWD env placeholder as unavailable scope", async () => {
    process.env.MIDBRAIN_PROJECT_DIR = "${TERMINAL_CWD}";
    process.env.MIDBRAIN_API_KEY = "fallback-key";

    await expect(client.resolveKey()).resolves.toEqual({
      key: "fallback-key",
      source: "env:MIDBRAIN_API_KEY",
    });

    expect(mocks.readFile.mock.calls.flat().some(
      (value) => String(value).includes("${TERMINAL_CWD}"),
    )).toBe(false);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/TERMINAL_CWD.*unresolved/i));
  });

  it("keeps an explicit projectDir ahead of an unresolved env placeholder", async () => {
    process.env.MIDBRAIN_PROJECT_DIR = "${TERMINAL_CWD}";
    const keyPath = path.join(PROJECT_DIR, ".midbrain", ".midbrain-key");
    readFileReturns({ [keyPath]: "project-key\n" });

    await expect(client.resolveKey(PROJECT_DIR)).resolves.toEqual({
      key: "project-key",
      source: keyPath,
    });
    expect(errSpy).not.toHaveBeenCalled();
  });
});

// ===================================================================
// Generic project key CRUD
// ===================================================================

describe("Generic.getProjectKey", () => {
  const client = new Generic();
  const PROJECT_DIR = "/home/testuser/proj";
  const subPath = path.join(PROJECT_DIR, ".midbrain", ".midbrain-key");
  const flatPath = path.join(PROJECT_DIR, ".midbrain-key");

  beforeEach(resetMocks);

  it("returns the subdirectory key before the flat key", async () => {
    readFileReturns({
      [subPath]: "sub-key\n",
      [flatPath]: "flat-key\n",
    });

    await expect(client.getProjectKey(PROJECT_DIR)).resolves.toEqual({
      key: "sub-key",
      source: subPath,
    });
  });

  it("returns the flat key when the subdirectory key is absent", async () => {
    readFileReturns({ [flatPath]: "flat-key\n" });

    await expect(client.getProjectKey(PROJECT_DIR)).resolves.toEqual({
      key: "flat-key",
      source: flatPath,
    });
  });

  it("returns null when both project key files are absent", async () => {
    await expect(client.getProjectKey(PROJECT_DIR)).resolves.toBeNull();
  });

  it("throws when the subdirectory key is unreadable", async () => {
    mocks.readFile.mockImplementation(async (filePath) => {
      if (filePath === subPath) throw fileError("EACCES", filePath);
      throw fileError("ENOENT", filePath);
    });

    await expect(client.getProjectKey(PROJECT_DIR)).rejects.toThrow(/Permission denied reading key file/);
    await expect(client.getProjectKey(PROJECT_DIR)).rejects.toThrow(subPath);
  });

  it("throws when the subdirectory key is empty instead of falling through", async () => {
    readFileReturns({
      [subPath]: " \n",
      [flatPath]: "flat-key\n",
    });

    await expect(client.getProjectKey(PROJECT_DIR)).rejects.toThrow(/Key file is empty/);
    await expect(client.getProjectKey(PROJECT_DIR)).rejects.toThrow(subPath);
  });

  it("throws when the flat key is empty", async () => {
    readFileReturns({ [flatPath]: " \n" });

    await expect(client.getProjectKey(PROJECT_DIR)).rejects.toThrow(/Key file is empty/);
    await expect(client.getProjectKey(PROJECT_DIR)).rejects.toThrow(flatPath);
  });

  it("throws unexpected project key read errors", async () => {
    mocks.readFile.mockImplementation(async (filePath) => {
      if (filePath === subPath) throw fileError("EIO", filePath);
      throw fileError("ENOENT", filePath);
    });

    await expect(client.getProjectKey(PROJECT_DIR)).rejects.toThrow(/EIO/);
  });

  it("prevents project key creation when an existing key is broken", async () => {
    readFileReturns({
      [subPath]: " \n",
    });

    await expect(client.getProjectKey(PROJECT_DIR)).rejects.toThrow(/Key file is empty/);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
