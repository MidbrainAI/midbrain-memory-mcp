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
import os from "os";
import path from "path";
import os from "os";

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
  writeCredential: vi.fn().mockResolvedValue({ action: "written", backupPath: null }),
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
vi.mock("../shared/clients/credential-writer.mjs", () => ({
  writeCredential: mocks.writeCredential,
}));

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

  it("reports the selected resolution scope only when requested", async () => {
    process.env.MIDBRAIN_API_KEY = "env-key";

    await expect(client.resolveKey(undefined, { includeScope: true })).resolves.toEqual({
      key: "env-key",
      source: "env:MIDBRAIN_API_KEY",
      scope: "environment",
    });
    await expect(client.resolveKey()).resolves.toEqual({
      key: "env-key",
      source: "env:MIDBRAIN_API_KEY",
    });
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

describe("BaseClient.inspectCredentialScopes", () => {
  const client = new TestClient();
  const PROJECT_DIR = "/home/testuser/proj";
  const projectKey = path.join(PROJECT_DIR, ".midbrain", ".midbrain-key");
  const globalKey = path.join(os.homedir(), ".config", "midbrain", ".midbrain-key");
  const savedEnv = {};

  beforeEach(() => {
    resetMocks();
    savedEnv.MIDBRAIN_PROJECT_DIR = process.env.MIDBRAIN_PROJECT_DIR;
    savedEnv.MIDBRAIN_API_KEY = process.env.MIDBRAIN_API_KEY;
    delete process.env.MIDBRAIN_PROJECT_DIR;
    delete process.env.MIDBRAIN_API_KEY;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("marks the winner and reports only a differing higher-priority shadow", async () => {
    readFileReturns({ [projectKey]: "project-key", [globalKey]: "global-key" });
    const resolved = await client.resolveKey(PROJECT_DIR, { includeScope: true });
    const state = await client.inspectCredentialScopes(PROJECT_DIR, resolved);

    expect(state.entries).toEqual([
      { scope: "project", status: "present", source: projectKey, winner: true },
      { scope: "client", status: "absent", winner: false },
      { scope: "global", status: "present", source: globalKey, winner: false },
      { scope: "environment", status: "absent", winner: false },
    ]);
    expect(state.shadowNote).toBe(
      "project credential shadows the global credential for this client",
    );
    expect(JSON.stringify(state)).not.toContain("project-key");
    expect(JSON.stringify(state)).not.toContain("global-key");
  });

  it("does not report a same-content shadow", async () => {
    readFileReturns({ [projectKey]: "same-key", [globalKey]: "same-key" });
    const resolved = await client.resolveKey(PROJECT_DIR, { includeScope: true });
    const state = await client.inspectCredentialScopes(PROJECT_DIR, resolved);
    expect(state.shadowNote).toBeNull();
  });

  it("reports a fixed reason label for read errors, never a raw path", async () => {
    // Project read succeeds (winner); global read fails with an unexpected
    // errno whose message embeds a username-bearing absolute path.
    const ioError = Object.assign(
      new Error(`EIO: i/o error, open '${globalKey}'`),
      { code: "EIO" },
    );
    mocks.readFile.mockImplementation(async (filePath) => {
      if (filePath === projectKey) return "project-key\n";
      if (filePath === globalKey) throw ioError;
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    });

    const resolved = await client.resolveKey(PROJECT_DIR, { includeScope: true });
    const state = await client.inspectCredentialScopes(PROJECT_DIR, resolved);

    const globalEntry = state.entries.find((entry) => entry.scope === "global");
    expect(globalEntry).toMatchObject({ status: "error", reason: "unreadable" });
    expect(globalEntry).not.toHaveProperty("source");
    // The error branch must never carry the raw fs message or the failing
    // path. (The winner entry legitimately carries its own source, which the
    // diagnostics report sanitizes at assembly time — not tested here.)
    const errorEntry = JSON.stringify(globalEntry);
    expect(errorEntry).not.toContain("testuser");
    expect(errorEntry).not.toContain("i/o error");
    expect(errorEntry).not.toContain(".midbrain-key");
  });
});

// ===================================================================
// Agent-key resolution uses ONLY .midbrain-key (keystore is not a selector)
// ===================================================================

describe("BaseClient.resolveKey — keystore is not an agent selector", () => {
  const client = new TestClient();
  const PROJECT_DIR = "/home/testuser/proj";
  const projKeystore = path.join(PROJECT_DIR, ".midbrain", ".midbrain-keystore.json");
  const globalKeystore = path.join(os.homedir(), ".config", "midbrain", ".midbrain-keystore.json");
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

  const agentKeystore = (key) =>
    JSON.stringify({
      version: 1,
      agents: { agent_a: { agent_key: key, key_provider: "midbrain" } },
    }) + "\n";

  it("does NOT resolve an agent key from a project keystore", async () => {
    // Only a keystore is present (no .midbrain-key). resolveKey must NOT use it
    // for the agent key — selection is .midbrain-key-only.
    readFileReturns({ [projKeystore]: agentKeystore("keystore-key") });
    await expect(client.resolveKey(PROJECT_DIR)).resolves.toBeNull();
  });

  it("does NOT resolve an agent key from the global keystore", async () => {
    readFileReturns({ [globalKeystore]: agentKeystore("global-ks-key") });
    await expect(client.resolveKey()).resolves.toBeNull();
  });

  it("resolves the project .midbrain-key normally", async () => {
    const legacySub = path.join(PROJECT_DIR, ".midbrain", ".midbrain-key");
    readFileReturns({ [legacySub]: "legacy-key\n" });
    await expect(client.resolveKey(PROJECT_DIR)).resolves.toEqual({
      key: "legacy-key",
      source: legacySub,
    });
  });
});

describe("BaseClient.resolveUserKey", () => {
  const client = new TestClient();
  const globalKeystore = path.join(os.homedir(), ".config", "midbrain", ".midbrain-keystore.json");
  const savedEnv = {};

  beforeEach(() => {
    resetMocks();
    savedEnv.MIDBRAIN_USER_API_KEY = process.env.MIDBRAIN_USER_API_KEY;
    delete process.env.MIDBRAIN_USER_API_KEY;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("prefers MIDBRAIN_USER_API_KEY env var", async () => {
    process.env.MIDBRAIN_USER_API_KEY = "sk-user-env";
    await expect(client.resolveUserKey()).resolves.toEqual({
      key: "sk-user-env",
      source: "env:MIDBRAIN_USER_API_KEY",
    });
  });

  it("reads user_key from the global keystore", async () => {
    readFileReturns({
      [globalKeystore]: JSON.stringify({ version: 1, user_key: "sk-user-ks", agents: {} }) + "\n",
    });
    await expect(client.resolveUserKey()).resolves.toEqual({
      key: "sk-user-ks",
      source: globalKeystore,
    });
  });

  it("returns null when no user key configured", async () => {
    await expect(client.resolveUserKey()).resolves.toBeNull();
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

describe("Generic credential writes", () => {
  const client = new Generic();
  const projectDir = "/home/testuser/proj";

  beforeEach(resetMocks);

  it("delegates the global credential and preserves the summary", async () => {
    const targetPath = path.join(os.homedir(), ".config", "midbrain", ".midbrain-key");
    const line = await client.writeKey("global-dummy");

    expect(mocks.writeCredential).toHaveBeenCalledWith({
      clientId: "generic",
      scope: "global",
      targetPath,
      key: "global-dummy",
      replaceApproved: false,
    });
    expect(line).toBe("Key: ~/.config/midbrain/.midbrain-key (chmod 600)");
  });

  it("delegates the canonical project credential and returns its path", async () => {
    const targetPath = path.join(projectDir, ".midbrain", ".midbrain-key");
    await expect(client.setProjectKey(projectDir, "project-dummy")).resolves.toBe(targetPath);
    expect(mocks.writeCredential).toHaveBeenCalledWith({
      clientId: "generic",
      scope: "project",
      targetPath,
      projectDir,
      key: "project-dummy",
    });
  });
});
