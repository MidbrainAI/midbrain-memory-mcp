/**
 * Unit tests for shared/clients/codex.mjs
 *
 * All filesystem operations are mocked — no real files read or written.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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
const { Codex } = await import("../shared/clients/codex.mjs");

const HOME = os.homedir();

const PATHS = {
  codexDir:    path.join(HOME, ".codex"),
  codexConfig: path.join(HOME, ".codex", "config.toml"),
  codexKey:    path.join(HOME, ".config", "codex", ".midbrain-key"),
};

function fileError(code, filePath) {
  const err = new Error(`${code}: test failure, open '${filePath}'`);
  err.code = code;
  return err;
}

describe("Codex adapter identity", () => {
  const codex = new Codex();

  it("extends BaseClient", () => {
    expect(codex).toBeInstanceOf(BaseClient);
  });

  it("has stable id and display name", () => {
    expect(codex.id).toBe("codex");
    expect(codex.displayName).toBe("Codex");
  });
});

describe("Codex.isInstalled", () => {
  const codex = new Codex();
  beforeEach(resetMocks);

  it("detects when user config.toml exists", () => {
    existsFor(PATHS.codexConfig);
    expect(codex.isInstalled()).toBe(true);
  });

  it("detects when ~/.codex exists but config.toml is missing", () => {
    existsFor(PATHS.codexDir);
    expect(codex.isInstalled()).toBe(true);
  });

  it("returns false when no Codex config path exists", () => {
    expect(codex.isInstalled()).toBe(false);
  });
});

describe("Codex.resolveClientKey", () => {
  const codex = new Codex();
  beforeEach(resetMocks);

  it("returns the client key when present", async () => {
    readFileReturns({ [PATHS.codexKey]: "codex-key\n" });

    await expect(codex.resolveClientKey()).resolves.toEqual({
      key: "codex-key",
      source: PATHS.codexKey,
    });
  });

  it("returns null when the client key file is missing", async () => {
    await expect(codex.resolveClientKey()).resolves.toBeNull();
  });

  it("throws when the client key file is empty", async () => {
    readFileReturns({ [PATHS.codexKey]: " \n" });

    await expect(codex.resolveClientKey()).rejects.toThrow(/Key file is empty/);
    await expect(codex.resolveClientKey()).rejects.toThrow(PATHS.codexKey);
  });

  it("throws when the client key file is unreadable", async () => {
    mocks.readFile.mockRejectedValue(fileError("EACCES", PATHS.codexKey));

    await expect(codex.resolveClientKey()).rejects.toThrow(/Permission denied reading key file/);
    await expect(codex.resolveClientKey()).rejects.toThrow(PATHS.codexKey);
  });

  it("throws unexpected client key read errors", async () => {
    mocks.readFile.mockRejectedValue(fileError("EIO", PATHS.codexKey));

    await expect(codex.resolveClientKey()).rejects.toThrow(/EIO/);
  });
});

describe("Codex.writeKey", () => {
  const codex = new Codex();
  beforeEach(resetMocks);

  it("writes the per-client key with chmod 600", async () => {
    const line = await codex.writeKey("codex-secret");

    expect(fs.mkdir).toHaveBeenCalledWith(path.dirname(PATHS.codexKey), { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(PATHS.codexKey, "codex-secret\n", "utf8");
    expect(fs.chmod).toHaveBeenCalledWith(PATHS.codexKey, 0o600);
    expect(line).toContain("~/.config/codex/.midbrain-key");
    expect(line).toContain("chmod 600");
  });
});

describe("Codex.projectConfigFiles", () => {
  const codex = new Codex();

  it("reports only the project TOML config path", () => {
    expect(codex.projectConfigFiles("/repo")).toEqual([".codex/config.toml"]);
  });
});
