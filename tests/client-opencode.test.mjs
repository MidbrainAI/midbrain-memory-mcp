/**
 * Unit tests for shared/clients/opencode.mjs
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

const { OpenCode, resolveOpencodeConfig } = await import("../shared/clients/opencode.mjs");
const { PKG_NAME, PKG_VERSION } = await import("../shared/clients/utils.mjs");

const HOME = os.homedir();
const MCP_KEY = "midbrain-memory";
// Version-only since PRD-034 S2/M6: the marker must never embed a path.
const MARKER_VALUE = `${PKG_NAME}@${PKG_VERSION}\n`;

const PATHS = {
  opencodeDir:     path.join(HOME, ".config", "opencode"),
  opencodeConfig:  path.join(HOME, ".config", "opencode", "opencode.json"),
  opencodeKey:     path.join(HOME, ".config", "opencode", ".midbrain-key"),
  opencodePlugins: path.join(HOME, ".config", "opencode", "plugins"),
  opencodePlugin:  path.join(HOME, ".config", "opencode", "plugins", "midbrain-memory.ts"),
  opencodeBundle:  path.join(HOME, ".config", "opencode", "plugins", "midbrain-shared.mjs"),
  opencodeMarker:  path.join(HOME, ".config", "opencode", "plugins", ".midbrain-repo-root"),
};

function fileError(code, filePath) {
  const err = new Error(`${code}: test failure, open '${filePath}'`);
  err.code = code;
  return err;
}

// ===================================================================
// isInstalled
// ===================================================================

describe("OpenCode.isInstalled", () => {
  const oc = new OpenCode();
  beforeEach(resetMocks);

  it("detects when opencode.json exists", () => {
    existsFor(PATHS.opencodeConfig);
    expect(oc.isInstalled()).toBe(true);
  });

  it("detects when config dir exists but config file is missing", () => {
    existsFor(PATHS.opencodeDir);
    expect(oc.isInstalled()).toBe(true);
  });

  it("detects when opencode.jsonc exists", () => {
    existsFor(path.join(PATHS.opencodeDir, "opencode.jsonc"));
    expect(oc.isInstalled()).toBe(true);
  });

  it("returns false when nothing exists", () => {
    expect(oc.isInstalled()).toBe(false);
  });
});

// ===================================================================
// resolveClientKey
// ===================================================================

describe("OpenCode.resolveClientKey", () => {
  const oc = new OpenCode();
  beforeEach(resetMocks);

  it("returns the client key when present", async () => {
    readFileReturns({ [PATHS.opencodeKey]: "opencode-key\n" });

    await expect(oc.resolveClientKey()).resolves.toEqual({
      key: "opencode-key",
      source: PATHS.opencodeKey,
    });
  });

  it("returns null when the client key file is missing", async () => {
    await expect(oc.resolveClientKey()).resolves.toBeNull();
  });

  it("throws when the client key file is empty", async () => {
    readFileReturns({ [PATHS.opencodeKey]: " \n" });

    await expect(oc.resolveClientKey()).rejects.toThrow(/Key file is empty/);
    await expect(oc.resolveClientKey()).rejects.toThrow(PATHS.opencodeKey);
  });

  it("throws when the client key file is unreadable", async () => {
    mocks.readFile.mockRejectedValue(fileError("EACCES", PATHS.opencodeKey));

    await expect(oc.resolveClientKey()).rejects.toThrow(/Permission denied reading key file/);
    await expect(oc.resolveClientKey()).rejects.toThrow(PATHS.opencodeKey);
  });

  it("throws unexpected client key read errors", async () => {
    mocks.readFile.mockRejectedValue(fileError("EIO", PATHS.opencodeKey));

    await expect(oc.resolveClientKey()).rejects.toThrow(/EIO/);
  });
});

// ===================================================================
// installGlobal
// ===================================================================

describe("OpenCode.installGlobal", () => {
  const oc = new OpenCode();
  beforeEach(resetMocks);

  function setupConfig(content) {
    readFileReturns({ [PATHS.opencodeConfig]: JSON.stringify(content) });
    existsFor(PATHS.opencodeConfig);
  }

  it("copies plugin and bundled shared lib to plugins dir", async () => {
    setupConfig({ $schema: "https://opencode.ai/config.json" });
    await oc.installGlobal();

    const copyArgs = fs.copyFile.mock.calls.map(([src, dst]) => [
      path.basename(src),
      path.basename(dst),
    ]);
    expect(copyArgs).toContainEqual(["midbrain-memory.ts", "midbrain-memory.ts"]);
    expect(copyArgs).toContainEqual(["midbrain-shared.mjs", "midbrain-shared.mjs"]);
  });

  it("creates plugins directory", async () => {
    setupConfig({ $schema: "https://opencode.ai/config.json" });
    await oc.installGlobal();
    expect(fs.mkdir).toHaveBeenCalledWith(PATHS.opencodePlugins, { recursive: true });
  });

  it("writes MCP config with correct shape", async () => {
    setupConfig({ $schema: "https://opencode.ai/config.json" });
    await oc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    expect(written.mcp[MCP_KEY]).toBeDefined();
    expect(written.mcp[MCP_KEY].type).toBe("local");
    expect(written.mcp[MCP_KEY].enabled).toBe(true);
    expect(written.mcp[MCP_KEY].environment.MIDBRAIN_CLIENT).toBe("opencode");
  });

  it("preserves existing config keys when adding MCP", async () => {
    setupConfig({
      $schema: "https://opencode.ai/config.json",
      provider: { "amazon-bedrock": { options: { region: "eu-central-1" } } },
      model: "some-model",
    });
    await oc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
    const written = JSON.parse(writeCall[1]);
    expect(written.provider).toEqual({ "amazon-bedrock": { options: { region: "eu-central-1" } } });
    expect(written.model).toBe("some-model");
    expect(written.mcp[MCP_KEY]).toBeDefined();
  });

  it("updates existing MCP entry without losing other entries", async () => {
    setupConfig({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        "other-server": { type: "local", command: ["other"], enabled: true },
        [MCP_KEY]: { type: "local", command: ["old-node", "old-index.js"], enabled: true },
      },
    });
    const lines = await oc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcp["other-server"]).toBeDefined();
    expect(written.mcp[MCP_KEY].command).not.toContain("old-node");
    expect(lines.some((s) => s.includes("updated"))).toBe(true);
  });

  it("removes invalid mcpServers key", async () => {
    setupConfig({
      $schema: "https://opencode.ai/config.json",
      mcpServers: { "old-format": {} },
    });
    const lines = await oc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers).toBeUndefined();
    expect(lines.some((s) => s.includes("mcpServers"))).toBe(true);
  });

  it("backs up config before writing", async () => {
    setupConfig({ $schema: "https://opencode.ai/config.json" });
    await oc.installGlobal();
    expect(fs.copyFile).toHaveBeenCalledWith(PATHS.opencodeConfig, PATHS.opencodeConfig + ".bak");
  });

  it("creates config from scratch when file is missing", async () => {
    await oc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    expect(written.$schema).toBe("https://opencode.ai/config.json");
    expect(written.mcp[MCP_KEY]).toBeDefined();
  });

  it("command defaults to npx -y midbrain-memory-mcp@latest", async () => {
    setupConfig({ $schema: "https://opencode.ai/config.json" });
    await oc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcp[MCP_KEY].command).toEqual(["npx", "-y", "midbrain-memory-mcp@latest"]);
  });

  it("--dev writes absolute node + index.js paths", async () => {
    setupConfig({ $schema: "https://opencode.ai/config.json" });
    await oc.installGlobal({ isDev: true });

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
    const written = JSON.parse(writeCall[1]);
    const cmd = written.mcp[MCP_KEY].command;
    expect(cmd).toHaveLength(2);
    expect(path.isAbsolute(cmd[0])).toBe(true);
    expect(cmd[1]).toContain("index.js");
  });

  it("preserves custom env vars on existing midbrain entry", async () => {
    setupConfig({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        [MCP_KEY]: {
          type: "local",
          command: ["/old/node", "/old/index.js"],
          environment: { MIDBRAIN_CONFIG_DIR: "/old/cfg", CUSTOM_OC: "keep-me" },
          enabled: true,
        },
      },
    });
    await oc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
    const written = JSON.parse(writeCall[1]);
    const env = written.mcp[MCP_KEY].environment;
    expect(env.CUSTOM_OC).toBe("keep-me");
    expect(env.MIDBRAIN_CLIENT).toBe("opencode");
    expect(env.MIDBRAIN_CONFIG_DIR).toBeUndefined();
  });

  it("preserves comments in .jsonc config", async () => {
    const jsoncPath = path.join(PATHS.opencodeDir, "opencode.jsonc");
    const jsonc = '{\n  // My provider config\n  "$schema": "https://opencode.ai/config.json",\n  "model": "test"\n}';
    readFileReturns({ [jsoncPath]: jsonc });
    existsFor(jsoncPath);

    const lines = await oc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === jsoncPath);
    expect(writeCall).toBeDefined();
    expect(writeCall[1]).toContain("// My provider config");
    expect(writeCall[1]).toContain("midbrain-memory");
    expect(lines.some((s) => s.includes("opencode.jsonc"))).toBe(true);
  });
});

// ===================================================================
// freshness repair
// ===================================================================

describe("OpenCode plugin freshness", () => {
  const oc = new OpenCode();
  beforeEach(resetMocks);

  it("treats matching marker but stale installed plugin content as not fresh", async () => {
    const repoPlugin = "/repo/plugin";
    const repoBundle = "/repo/bundle";
    mocks.readFile.mockImplementation(async (filePath) => {
      if (filePath === PATHS.opencodeMarker) {
        return MARKER_VALUE;
      }
      if (String(filePath).endsWith(path.join("plugins", "opencode", "midbrain-memory.ts"))) {
        return repoPlugin;
      }
      if (String(filePath).endsWith(path.join("dist", "midbrain-shared.mjs"))) {
        return repoBundle;
      }
      if (filePath === PATHS.opencodePlugin) {
        return "export function normalizeHistoryMessages() {}";
      }
      if (filePath === PATHS.opencodeBundle) {
        return repoBundle;
      }
      throw fileError("ENOENT", filePath);
    });

    await expect(oc.isFresh()).resolves.toBe(false);
  });

  it("treats matching marker but stale installed bundle content as not fresh", async () => {
    const repoPlugin = "export default MidBrainMemoryPlugin;";
    const repoBundle = "bundle";
    mocks.readFile.mockImplementation(async (filePath) => {
      if (filePath === PATHS.opencodeMarker) {
        return MARKER_VALUE;
      }
      if (String(filePath).endsWith(path.join("plugins", "opencode", "midbrain-memory.ts"))) {
        return repoPlugin;
      }
      if (String(filePath).endsWith(path.join("dist", "midbrain-shared.mjs"))) {
        return repoBundle;
      }
      if (filePath === PATHS.opencodePlugin) {
        return repoPlugin;
      }
      if (filePath === PATHS.opencodeBundle) {
        return "stale bundle";
      }
      throw fileError("ENOENT", filePath);
    });

    await expect(oc.isFresh()).resolves.toBe(false);
  });

  it("treats matching marker and matching plugin files as fresh", async () => {
    const repoPlugin = "export default MidBrainMemoryPlugin;";
    const repoBundle = "bundle";
    mocks.readFile.mockImplementation(async (filePath) => {
      if (filePath === PATHS.opencodeMarker) {
        return MARKER_VALUE;
      }
      if (String(filePath).endsWith(path.join("plugins", "opencode", "midbrain-memory.ts"))) {
        return repoPlugin;
      }
      if (String(filePath).endsWith(path.join("dist", "midbrain-shared.mjs"))) {
        return repoBundle;
      }
      if (filePath === PATHS.opencodePlugin) {
        return repoPlugin;
      }
      if (filePath === PATHS.opencodeBundle) {
        return repoBundle;
      }
      throw fileError("ENOENT", filePath);
    });

    await expect(oc.isFresh()).resolves.toBe(true);
  });
});

// ===================================================================
// installProject
// ===================================================================

describe("OpenCode.installProject", () => {
  const oc = new OpenCode();
  const PROJECT_DIR = "/home/testuser/myproject";
  beforeEach(resetMocks);

  it("writes opencode.json with project MCP config", async () => {
    await oc.installProject(PROJECT_DIR);

    const configPath = path.join(PROJECT_DIR, "opencode.json");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === configPath);
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    expect(written.$schema).toBe("https://opencode.ai/config.json");
    expect(written.mcp[MCP_KEY].type).toBe("local");
    expect(written.mcp[MCP_KEY].environment.MIDBRAIN_PROJECT_DIR).toBe(PROJECT_DIR);
    expect(written.mcp[MCP_KEY].environment.MIDBRAIN_CLIENT).toBe("opencode");
  });

  it("removes invalid mcpServers key", async () => {
    const configPath = path.join(PROJECT_DIR, "opencode.json");
    readFileReturns({ [configPath]: JSON.stringify({ $schema: "https://opencode.ai/config.json", mcpServers: { old: {} } }) });
    existsFor(configPath);
    const lines = await oc.installProject(PROJECT_DIR);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === configPath);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers).toBeUndefined();
    expect(lines.some((s) => s.includes("mcpServers"))).toBe(true);
  });

  it("command defaults to npx -y midbrain-memory-mcp@latest", async () => {
    await oc.installProject(PROJECT_DIR);

    const configPath = path.join(PROJECT_DIR, "opencode.json");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === configPath);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcp[MCP_KEY].command).toEqual(["npx", "-y", "midbrain-memory-mcp@latest"]);
  });

  it("--dev writes absolute paths", async () => {
    await oc.installProject(PROJECT_DIR, { isDev: true });

    const configPath = path.join(PROJECT_DIR, "opencode.json");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === configPath);
    const written = JSON.parse(writeCall[1]);
    const cmd = written.mcp[MCP_KEY].command;
    expect(path.isAbsolute(cmd[0])).toBe(true);
    expect(path.isAbsolute(cmd[1])).toBe(true);
  });

  it("uses opencode.jsonc and preserves comments", async () => {
    const jsoncPath = path.join(PROJECT_DIR, "opencode.jsonc");
    const content = '{\n  // Project config\n  "$schema": "https://opencode.ai/config.json"\n}';
    readFileReturns({ [jsoncPath]: content });
    existsFor(jsoncPath);

    await oc.installProject(PROJECT_DIR);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === jsoncPath);
    expect(writeCall).toBeDefined();
    expect(writeCall[1]).toContain("// Project config");
    expect(writeCall[1]).toContain("midbrain-memory");
  });
});

// ===================================================================
// resolveOpencodeConfig
// ===================================================================

describe("resolveOpencodeConfig", () => {
  beforeEach(resetMocks);

  // Build paths with path.join so the separator matches what the adapter uses
  // (backslashes on Windows) — both the existsFor mock key and the expected
  // return value stay platform-consistent.
  const DIR = path.join(path.sep, "dir");
  const JSONC = path.join(DIR, "opencode.jsonc");
  const JSON_ = path.join(DIR, "opencode.json");

  it("returns opencode.jsonc when it exists (preferred)", () => {
    existsFor(JSONC);
    expect(resolveOpencodeConfig(DIR)).toBe(JSONC);
  });

  it("returns opencode.json when only .json exists", () => {
    existsFor(JSON_);
    expect(resolveOpencodeConfig(DIR)).toBe(JSON_);
  });

  it("prefers .jsonc over .json when both exist", () => {
    existsFor(JSONC, JSON_);
    expect(resolveOpencodeConfig(DIR)).toBe(JSONC);
  });

  it("defaults to opencode.json when neither exists", () => {
    expect(resolveOpencodeConfig(DIR)).toBe(JSON_);
  });
});
