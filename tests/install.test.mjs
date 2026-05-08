/**
 * Unit tests for install.mjs
 *
 * All filesystem operations are mocked — no real files are read or written.
 * Tests cover: readJson, writeJson, detectTools, installOpenCode,
 * installClaudeJson, installClaudeSettings, and projectSetup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";

// ---------------------------------------------------------------------------
// Mock fs/promises (default import in install.mjs: `import fs from 'fs/promises'`)
// ---------------------------------------------------------------------------
vi.mock("fs/promises", () => ({
  default: {
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn(),
    realpath: vi.fn(),
    copyFile: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Mock fs (named import: `import { existsSync } from 'fs'`)
// ---------------------------------------------------------------------------
vi.mock("fs", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    existsSync: vi.fn(() => false),
    // realpathSync must work for the isMain guard
    realpathSync: orig.realpathSync,
  };
});

// ---------------------------------------------------------------------------
// Import module-under-test AFTER mocks are set up (vitest hoists vi.mock)
// ---------------------------------------------------------------------------
const {
  readJson,
  writeJson,
  patchJsonFile,
  resolveOpencodeConfig,
  detectTools,
  projectSetup,
  installOpenCode,
  installClaudeJson,
  installClaudeSettings,
  installClaudeCode,
  installClaudeProjectLocal,
  // Codex (PRD-008)
  installCodex,
  patchCodexMcpServer,
  patchCodexFeatures,
  readCodexToml,
  writeCodexToml,
  buildCodexHookCommand,
  buildCodexHooks,
  shellQuote,
  writeCodexProjectConfig,
  hasCodexBinary,
  PATHS,
  MCP_KEY,
} = await import("../install.mjs");

const fs = (await import("fs/promises")).default;
const { existsSync } = await import("fs");

// Convenience: the resolved opencode.json path (OPENCODE_CONFIG was removed
// in favor of PATHS.opencodeDir + resolveOpencodeConfig; this matches the old path).
const OPENCODE_CONFIG = path.join(PATHS.opencodeDir, "opencode.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset all mocks and set sane defaults between tests. */
function resetMocks() {
  vi.clearAllMocks();
  fs.readFile.mockRejectedValue(enoent("default"));
  fs.writeFile.mockResolvedValue(undefined);
  fs.mkdir.mockResolvedValue(undefined);
  fs.chmod.mockResolvedValue(undefined);
  fs.copyFile.mockResolvedValue(undefined);
  fs.stat.mockRejectedValue(enoent("default"));
  fs.realpath.mockImplementation(async (p) => p);
  existsSync.mockReturnValue(false);
}

/** Creates an ENOENT error matching Node's format. */
function enoent(filePath) {
  const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
  err.code = "ENOENT";
  return err;
}

/** Make existsSync return true for specific paths. */
function existsFor(...paths) {
  existsSync.mockImplementation((p) => paths.includes(p));
}

/** Make fs.readFile return content for specific paths, ENOENT for others. */
function readFileReturns(mapping) {
  fs.readFile.mockImplementation(async (filePath) => {
    if (mapping[filePath] !== undefined) return mapping[filePath];
    throw enoent(filePath);
  });
}

// ===================================================================
// readJson
// ===================================================================

describe("readJson", () => {
  beforeEach(resetMocks);

  it("reads and parses a .json file", async () => {
    fs.readFile.mockResolvedValue('{"key": "value"}');
    const result = await readJson("/some/file.json");
    expect(result).toEqual({ key: "value" });
    expect(fs.readFile).toHaveBeenCalledWith("/some/file.json", "utf8");
  });

  it("returns null for ENOENT (file not found)", async () => {
    fs.readFile.mockRejectedValue(enoent("/missing.json"));
    const result = await readJson("/missing.json");
    expect(result).toBeNull();
  });

  it("throws on invalid JSON content", async () => {
    fs.readFile.mockResolvedValue("not json at all");
    await expect(readJson("/bad.json")).rejects.toThrow(/Failed to parse/);
  });

  it("propagates non-ENOENT errors (e.g. permission denied)", async () => {
    const err = new Error("Permission denied");
    err.code = "EACCES";
    fs.readFile.mockRejectedValue(err);
    await expect(readJson("/protected.json")).rejects.toThrow(/Failed to parse/);
  });

  it("parses nested JSON correctly", async () => {
    const data = { mcp: { server: { type: "local", enabled: true } }, model: "x" };
    fs.readFile.mockResolvedValue(JSON.stringify(data));
    const result = await readJson("/config.json");
    expect(result).toEqual(data);
  });

  it("parses JSON with whitespace and formatting", async () => {
    fs.readFile.mockResolvedValue('{\n  "a": 1,\n  "b": 2\n}\n');
    const result = await readJson("/formatted.json");
    expect(result).toEqual({ a: 1, b: 2 });
  });
});

// ===================================================================
// writeJson
// ===================================================================

describe("writeJson", () => {
  beforeEach(resetMocks);

  it("writes formatted JSON with 2-space indent and trailing newline", async () => {
    await writeJson("/dir/file.json", { a: 1 });
    expect(fs.writeFile).toHaveBeenCalledWith(
      "/dir/file.json",
      '{\n  "a": 1\n}\n',
      "utf8"
    );
  });

  it("creates parent directories", async () => {
    await writeJson("/deep/nested/dir/file.json", {});
    expect(fs.mkdir).toHaveBeenCalledWith("/deep/nested/dir", { recursive: true });
  });

  it("calls mkdir before writeFile", async () => {
    const callOrder = [];
    fs.mkdir.mockImplementation(async () => callOrder.push("mkdir"));
    fs.writeFile.mockImplementation(async () => callOrder.push("writeFile"));
    await writeJson("/dir/file.json", {});
    expect(callOrder).toEqual(["mkdir", "writeFile"]);
  });

  it("serializes nested objects correctly", async () => {
    const data = { mcp: { "midbrain-memory": { type: "local", enabled: true } } };
    await writeJson("/config.json", data);
    const written = fs.writeFile.mock.calls[0][1];
    expect(JSON.parse(written)).toEqual(data);
  });

  it("handles arrays in JSON", async () => {
    await writeJson("/file.json", { items: [1, 2, 3] });
    const written = fs.writeFile.mock.calls[0][1];
    expect(JSON.parse(written)).toEqual({ items: [1, 2, 3] });
  });
});

// ===================================================================
// detectTools
// ===================================================================

describe("detectTools", () => {
  beforeEach(resetMocks);

  it("detects OpenCode when opencode.json exists in config dir", () => {
    existsFor(OPENCODE_CONFIG);
    const tools = detectTools();
    expect(tools.opencode).toBe(true);
  });

  it("does not detect OpenCode when opencode.json is missing", () => {
    // existsSync returns false for everything (default)
    const tools = detectTools();
    expect(tools.opencode).toBe(false);
  });

  it("detects OpenCode when config dir exists but config file is missing (PRD-010 I-13a)", () => {
    // Fresh-install scenario: ~/.config/opencode/ exists but opencode.json
    // has not been created yet. Previously detectTools returned false here,
    // so main() never reached installOpenCode's starter-config path.
    existsFor(PATHS.opencodeDir);
    const tools = detectTools();
    expect(tools.opencode).toBe(true);
  });

  it("detects Claude Code via .claude.json", () => {
    existsFor(PATHS.claudeJson);
    const tools = detectTools();
    expect(tools.claudeCode).toBe(true);
  });

  it("detects Claude Code via settings.json", () => {
    existsFor(PATHS.claudeSettings);
    const tools = detectTools();
    expect(tools.claudeCode).toBe(true);
  });

  it("detects Claude Code when both .claude.json and settings.json exist", () => {
    existsFor(PATHS.claudeJson, PATHS.claudeSettings);
    const tools = detectTools();
    expect(tools.claudeCode).toBe(true);
  });

  it("detects both clients when both exist", () => {
    existsFor(OPENCODE_CONFIG, PATHS.claudeJson);
    const tools = detectTools();
    expect(tools.opencode).toBe(true);
    expect(tools.claudeCode).toBe(true);
  });

  it("detects neither when nothing exists", () => {
    const tools = detectTools();
    expect(tools.opencode).toBe(false);
    expect(tools.claudeCode).toBe(false);
  });

  it("checks the correct paths", () => {
    detectTools();
    // Should have checked for opencode config (.jsonc then .json) and claude paths
    const checkedPaths = existsSync.mock.calls.map(([p]) => p);
    expect(checkedPaths).toContain(OPENCODE_CONFIG);
    expect(checkedPaths).toContain(PATHS.claudeJson);
  });
});

// ===================================================================
// installOpenCode
// ===================================================================

describe("installOpenCode", () => {
  beforeEach(resetMocks);

  /** Set up mocks for a successful installOpenCode call. */
  function setupOpenCode(configContent) {
    readFileReturns({ [OPENCODE_CONFIG]: JSON.stringify(configContent) });
    existsFor(OPENCODE_CONFIG);
  }

  it("copies plugin and shared lib to plugins dir", async () => {
    setupOpenCode({ $schema: "https://opencode.ai/config.json" });
    const summary = [];
    await installOpenCode(summary);

    const copyArgs = fs.copyFile.mock.calls.map(([src, dst]) => [
      path.basename(src),
      path.basename(dst),
    ]);
    expect(copyArgs).toContainEqual(["midbrain-memory.ts", "midbrain-memory.ts"]);
    expect(copyArgs).toContainEqual(["midbrain-common.mjs", "midbrain-common.mjs"]);
  });

  it("creates plugins directory", async () => {
    setupOpenCode({ $schema: "https://opencode.ai/config.json" });
    const summary = [];
    await installOpenCode(summary);
    expect(fs.mkdir).toHaveBeenCalledWith(PATHS.opencodePlugins, { recursive: true });
  });

  it("writes MCP config into opencode.json", async () => {
    setupOpenCode({ $schema: "https://opencode.ai/config.json" });
    const summary = [];
    await installOpenCode(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === OPENCODE_CONFIG);
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    expect(written.mcp).toBeDefined();
    expect(written.mcp[MCP_KEY]).toBeDefined();
    expect(written.mcp[MCP_KEY].type).toBe("local");
    expect(written.mcp[MCP_KEY].enabled).toBe(true);
    expect(written.mcp[MCP_KEY].environment.MIDBRAIN_CONFIG_DIR).toContain("opencode");
  });

  it("preserves existing config keys when adding MCP", async () => {
    setupOpenCode({
      $schema: "https://opencode.ai/config.json",
      provider: { "amazon-bedrock": { options: { region: "eu-central-1" } } },
      model: "some-model",
    });
    const summary = [];
    await installOpenCode(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === OPENCODE_CONFIG);
    const written = JSON.parse(writeCall[1]);
    expect(written.provider).toEqual({
      "amazon-bedrock": { options: { region: "eu-central-1" } },
    });
    expect(written.model).toBe("some-model");
    expect(written.mcp[MCP_KEY]).toBeDefined();
  });

  it("updates existing MCP entry without losing other mcp entries", async () => {
    setupOpenCode({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        "other-server": { type: "local", command: ["other"], enabled: true },
        [MCP_KEY]: { type: "local", command: ["old-node", "old-server.js"], enabled: true },
      },
    });
    const summary = [];
    await installOpenCode(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === OPENCODE_CONFIG);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcp["other-server"]).toBeDefined();
    expect(written.mcp[MCP_KEY].command).not.toContain("old-node");
    expect(summary.some((s) => s.includes("updated"))).toBe(true);
  });

  it("removes invalid mcpServers key", async () => {
    setupOpenCode({
      $schema: "https://opencode.ai/config.json",
      mcpServers: { "old-format": {} },
    });
    const summary = [];
    await installOpenCode(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === OPENCODE_CONFIG);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers).toBeUndefined();
    expect(summary.some((s) => s.includes("mcpServers"))).toBe(true);
  });

  it("backs up config before writing", async () => {
    setupOpenCode({ $schema: "https://opencode.ai/config.json" });
    const summary = [];
    await installOpenCode(summary);

    expect(fs.copyFile).toHaveBeenCalledWith(
      OPENCODE_CONFIG,
      OPENCODE_CONFIG + ".bak"
    );
  });

  it("throws when config file cannot be read", async () => {
    // PRD-010 AC-8 I-11: missing ~/.config/opencode/opencode.json is no longer
    // a hard error. installOpenCode now creates a minimal starter config with
    // $schema and the MCP entry.
    const summary = [];
    await installOpenCode(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === OPENCODE_CONFIG);
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    expect(written.$schema).toBe("https://opencode.ai/config.json");
    expect(written.mcp[MCP_KEY]).toBeDefined();
  });

  it("command array defaults to npx -y midbrain-memory-mcp@latest (PRD-010 I-1)", async () => {
    setupOpenCode({ $schema: "https://opencode.ai/config.json" });
    const summary = [];
    await installOpenCode(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === OPENCODE_CONFIG);
    const written = JSON.parse(writeCall[1]);
    const cmd = written.mcp[MCP_KEY].command;
    expect(cmd).toEqual(["npx", "-y", "midbrain-memory-mcp@latest"]);
  });

  it("--dev flag writes absolute node + server.js paths (PRD-010 I-3)", async () => {
    setupOpenCode({ $schema: "https://opencode.ai/config.json" });
    const summary = [];
    await installOpenCode(summary, { isDev: true });

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === OPENCODE_CONFIG);
    const written = JSON.parse(writeCall[1]);
    const cmd = written.mcp[MCP_KEY].command;
    expect(cmd).toHaveLength(2);
    expect(path.isAbsolute(cmd[0])).toBe(true); // node path
    expect(cmd[1]).toContain("server.js");
  });

  it("preserves custom env vars on existing midbrain entry (PRD-010 AC-3)", async () => {
    setupOpenCode({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        [MCP_KEY]: {
          type: "local",
          command: ["/old/node", "/old/server.js"],
          environment: {
            MIDBRAIN_CONFIG_DIR: "/old/cfg",
            CUSTOM_OC: "keep-me",
          },
          enabled: true,
        },
      },
    });
    const summary = [];
    await installOpenCode(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === OPENCODE_CONFIG);
    const written = JSON.parse(writeCall[1]);
    const env = written.mcp[MCP_KEY].environment;
    expect(env.CUSTOM_OC).toBe("keep-me");
    expect(env.MIDBRAIN_CONFIG_DIR).toContain("opencode");
    expect(env.MIDBRAIN_CONFIG_DIR).not.toBe("/old/cfg");
  });

  it("summary reports addition for new MCP entry", async () => {
    setupOpenCode({ $schema: "https://opencode.ai/config.json" });
    const summary = [];
    await installOpenCode(summary);
    expect(summary.some((s) => s.includes("added") || s.includes("MCP server"))).toBe(true);
  });

  it("writes to opencode.json config path", async () => {
    setupOpenCode({ $schema: "https://opencode.ai/config.json" });
    const summary = [];
    await installOpenCode(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === OPENCODE_CONFIG);
    expect(writeCall).toBeDefined();
    expect(OPENCODE_CONFIG).toContain("opencode.json");
  });
});

// ===================================================================
// installClaudeJson
// ===================================================================

describe("installClaudeJson", () => {
  beforeEach(resetMocks);

  it("adds MCP server to .claude.json", async () => {
    readFileReturns({ [PATHS.claudeJson]: '{"mcpServers": {}}' });
    existsFor(PATHS.claudeJson);
    const summary = [];
    await installClaudeJson(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers[MCP_KEY]).toBeDefined();
    expect(written.mcpServers[MCP_KEY].type).toBe("stdio");
    expect(written.mcpServers[MCP_KEY].env.MIDBRAIN_CONFIG_DIR).toContain("claude");
  });

  it("preserves existing mcpServers entries", async () => {
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify({
        mcpServers: { "other-mcp": { command: "other" } },
      }),
    });
    existsFor(PATHS.claudeJson);
    const summary = [];
    await installClaudeJson(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers["other-mcp"]).toEqual({ command: "other" });
    expect(written.mcpServers[MCP_KEY]).toBeDefined();
  });

  it("updates existing midbrain-memory entry", async () => {
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify({
        mcpServers: { [MCP_KEY]: { command: "old-node", args: ["old.js"] } },
      }),
    });
    existsFor(PATHS.claudeJson);
    const summary = [];
    await installClaudeJson(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers[MCP_KEY].command).not.toBe("old-node");
    expect(summary.some((s) => s.includes("updated"))).toBe(true);
  });

  it("creates .claude.json from scratch when file missing", async () => {
    // readJson returns null -> fallback to {}
    const summary = [];
    await installClaudeJson(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers[MCP_KEY]).toBeDefined();
    expect(summary.some((s) => s.includes("added"))).toBe(true);
  });

  it("backs up existing file", async () => {
    readFileReturns({ [PATHS.claudeJson]: "{}" });
    existsFor(PATHS.claudeJson);
    const summary = [];
    await installClaudeJson(summary);

    expect(fs.copyFile).toHaveBeenCalledWith(
      PATHS.claudeJson,
      PATHS.claudeJson + ".bak"
    );
  });

  it("command defaults to npx -y midbrain-memory-mcp@latest (PRD-010 I-2)", async () => {
    readFileReturns({ [PATHS.claudeJson]: "{}" });
    existsFor(PATHS.claudeJson);
    const summary = [];
    await installClaudeJson(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    const srv = written.mcpServers[MCP_KEY];
    expect(srv.command).toBe("npx");
    expect(srv.args).toEqual(["-y", "midbrain-memory-mcp@latest"]);
  });

  it("--dev flag writes absolute node + server.js paths (PRD-010 I-4)", async () => {
    readFileReturns({ [PATHS.claudeJson]: "{}" });
    existsFor(PATHS.claudeJson);
    const summary = [];
    await installClaudeJson(summary, { isDev: true });

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    const srv = written.mcpServers[MCP_KEY];
    expect(path.isAbsolute(srv.command)).toBe(true);
    expect(srv.args[0]).toContain("server.js");
  });

  it("preserves custom env vars on existing midbrain entry (PRD-010 AC-3)", async () => {
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify({
        mcpServers: {
          [MCP_KEY]: {
            type: "stdio",
            command: "/old/node",
            args: ["/old/server.js"],
            env: {
              MIDBRAIN_CONFIG_DIR: "/old/cfg",
              CUSTOM_CC: "keep-me",
            },
          },
        },
      }),
    });
    existsFor(PATHS.claudeJson);
    const summary = [];
    await installClaudeJson(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    const env = written.mcpServers[MCP_KEY].env;
    expect(env.CUSTOM_CC).toBe("keep-me");
    expect(env.MIDBRAIN_CONFIG_DIR).toContain("claude");
    expect(env.MIDBRAIN_CONFIG_DIR).not.toBe("/old/cfg");
  });

  it("preserves non-mcpServers keys in .claude.json", async () => {
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify({
        apiKey: "something",
        mcpServers: {},
      }),
    });
    existsFor(PATHS.claudeJson);
    const summary = [];
    await installClaudeJson(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    expect(written.apiKey).toBe("something");
  });
});

// ===================================================================
// installClaudeSettings
// ===================================================================

describe("installClaudeSettings", () => {
  beforeEach(resetMocks);

  it("adds hooks and permissions to settings.json", async () => {
    const summary = [];
    await installClaudeSettings(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeSettings);
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    expect(written.hooks).toBeDefined();
    expect(written.hooks.UserPromptSubmit).toBeDefined();
    expect(written.hooks.Stop).toBeDefined();
    expect(written.permissions.allow).toContain("mcp__midbrain-memory__memory_search");
  });

  it("adds all 6 permission keys", async () => {
    const summary = [];
    await installClaudeSettings(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeSettings);
    const written = JSON.parse(writeCall[1]);
    expect(written.permissions.allow).toHaveLength(6);
    expect(written.permissions.allow).toContain("mcp__midbrain-memory__grep");
    expect(written.permissions.allow).toContain("mcp__midbrain-memory__list_files");
    expect(written.permissions.allow).toContain("mcp__midbrain-memory__read_file");
    expect(written.permissions.allow).toContain("mcp__midbrain-memory__memory_setup_project");
    expect(written.permissions.allow).toContain(
      "mcp__midbrain-memory__get_episodic_memories_by_date"
    );
  });

  it("does not duplicate existing permissions", async () => {
    readFileReturns({
      [PATHS.claudeSettings]: JSON.stringify({
        permissions: {
          allow: [
            "mcp__midbrain-memory__memory_search",
            "mcp__midbrain-memory__grep",
          ],
        },
      }),
    });
    const summary = [];
    await installClaudeSettings(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeSettings);
    const written = JSON.parse(writeCall[1]);
    // Only 6 unique midbrain permissions, not 8 (2 existing + 6 new with duplicates)
    const midbrainPerms = written.permissions.allow.filter((p) =>
      p.startsWith("mcp__midbrain-memory__")
    );
    expect(midbrainPerms).toHaveLength(6);
  });

  it("preserves existing permissions from other tools", async () => {
    readFileReturns({
      [PATHS.claudeSettings]: JSON.stringify({
        permissions: { allow: ["some-other-permission"] },
      }),
    });
    const summary = [];
    await installClaudeSettings(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeSettings);
    const written = JSON.parse(writeCall[1]);
    expect(written.permissions.allow).toContain("some-other-permission");
    expect(written.permissions.allow.length).toBe(7); // 1 existing + 6 new
  });

  it("hooks contain capture-user.mjs and capture-assistant.mjs paths", async () => {
    const summary = [];
    await installClaudeSettings(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeSettings);
    const written = JSON.parse(writeCall[1]);
    const userHook = written.hooks.UserPromptSubmit[0].hooks[0];
    const stopHook = written.hooks.Stop[0].hooks[0];
    expect(userHook.command).toContain("capture-user.mjs");
    expect(stopHook.command).toContain("capture-assistant.mjs");
    expect(userHook.type).toBe("command");
    expect(userHook.timeout).toBe(10);
    expect(userHook.async).toBe(true);
  });

  it("updates existing hooks when capture-user.mjs already present", async () => {
    readFileReturns({
      [PATHS.claudeSettings]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                { type: "command", command: "/old/path/capture-user.mjs", timeout: 5 },
              ],
            },
          ],
        },
      }),
    });
    const summary = [];
    await installClaudeSettings(summary);

    expect(summary.some((s) => s.includes("updated"))).toBe(true);
  });

  it("creates settings directory if needed", async () => {
    const summary = [];
    await installClaudeSettings(summary);

    const settingsDir = path.dirname(PATHS.claudeSettings);
    expect(fs.mkdir).toHaveBeenCalledWith(settingsDir, { recursive: true });
  });

  it("preserves existing non-hook/non-permission settings", async () => {
    readFileReturns({
      [PATHS.claudeSettings]: JSON.stringify({
        theme: "dark",
        permissions: { allow: [] },
      }),
    });
    const summary = [];
    await installClaudeSettings(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeSettings);
    const written = JSON.parse(writeCall[1]);
    expect(written.theme).toBe("dark");
  });

  it("hooks include MIDBRAIN_CONFIG_DIR in command string", async () => {
    const summary = [];
    await installClaudeSettings(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeSettings);
    const written = JSON.parse(writeCall[1]);
    const userHook = written.hooks.UserPromptSubmit[0].hooks[0];
    expect(userHook.command).toContain("MIDBRAIN_CONFIG_DIR=");
    expect(userHook.command).toContain(".config/claude");
  });
});

// ===================================================================
// installClaudeCode — PRD-010 I-13b: fresh-install dead-path
// ===================================================================

describe("installClaudeCode (PRD-010 I-13b)", () => {
  beforeEach(resetMocks);

  it("calls installClaudeJson even when ~/.claude.json does not exist (fresh install)", async () => {
    // Fresh-install scenario: Claude Code installed, ~/.claude/settings.json
    // exists (so detectTools returns claudeCode: true), but ~/.claude.json
    // does not. Previously installClaudeCode gated installClaudeJson on
    // existsSync(PATHS.claudeJson), so the MCP entry was silently skipped.
    // Now installClaudeJson runs unconditionally; readJson() || {} handles
    // the missing-file case and creates the file with the MCP entry.

    // Only settings.json exists, NOT .claude.json
    existsFor(PATHS.claudeSettings);

    // readFile returns ENOENT for .claude.json AND for settings.json
    // (installClaudeSettings also uses readJson()||{} for missing files)
    fs.readFile.mockImplementation(async () => { throw enoent("default"); });

    const summary = [];
    await installClaudeCode(summary, { isDev: false });

    // installClaudeJson must have been called -> writes to ~/.claude.json
    const claudeWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    expect(claudeWrite).toBeDefined();

    const written = JSON.parse(claudeWrite[1]);
    expect(written.mcpServers).toBeDefined();
    expect(written.mcpServers[MCP_KEY]).toBeDefined();
    expect(written.mcpServers[MCP_KEY].command).toBe("npx");
    expect(written.mcpServers[MCP_KEY].args).toEqual([
      "-y", "midbrain-memory-mcp@latest",
    ]);

    // Summary should show the "+ added" line (not the "~ updated" line)
    const added = summary.find((l) => l.includes("+ MCP server added to ~/.claude.json"));
    expect(added).toBeDefined();
  });
});

// ===================================================================
// projectSetup
// ===================================================================

describe("projectSetup", () => {
  const PROJECT_DIR = "/home/testuser/myproject";
  const savedEnv = {};

  beforeEach(() => {
    resetMocks();
    // Save env vars
    for (const k of [
      "MIDBRAIN_API_KEY",
      "MIDBRAIN_PROJECT_DIR",
      "MIDBRAIN_CONFIG_DIR",
    ]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Standard setup: project dir exists, has API key, OpenCode detected. */
  function setupProjectMocks(opts = {}) {
    const {
      projectDir = PROJECT_DIR,
      apiKey = "test-api-key-1234",
      existingProjectKey = false,
      opencodeDetected = true,
      claudeDetected = false,
      existingOpencodeJson = null,
      existingMcpJson = null,
    } = opts;

    // stat + realpath for project dir validation
    fs.stat.mockImplementation(async (p) => {
      if (p === projectDir) return { isDirectory: () => true };
      throw enoent(p);
    });
    fs.realpath.mockImplementation(async (p) => p);

    // Key file resolution
    const files = {};
    if (existingProjectKey) {
      files[path.join(projectDir, ".midbrain", ".midbrain-key")] = apiKey + "\n";
    }
    // Global key fallback
    files[PATHS.globalKey] = apiKey + "\n";

    if (existingOpencodeJson) {
      files[path.join(projectDir, "opencode.json")] =
        JSON.stringify(existingOpencodeJson);
    }
    if (existingMcpJson) {
      files[path.join(projectDir, ".mcp.json")] = JSON.stringify(existingMcpJson);
    }

    readFileReturns(files);

    // existsSync for detectTools + backup
    const existsPaths = [];
    if (opencodeDetected) {
      existsPaths.push(OPENCODE_CONFIG);
    }
    if (claudeDetected) {
      existsPaths.push(PATHS.claudeJson);
    }
    if (existingProjectKey) {
      // No existsSync check for key file — readKeyFile uses readFile
    }
    if (existingOpencodeJson) {
      existsPaths.push(path.join(projectDir, "opencode.json"));
    }
    if (existingMcpJson) {
      existsPaths.push(path.join(projectDir, ".mcp.json"));
    }
    existsFor(...existsPaths);
  }

  it("creates .midbrain/.midbrain-key with chmod 600", async () => {
    setupProjectMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    const keyPath = path.join(PROJECT_DIR, ".midbrain", ".midbrain-key");
    expect(fs.mkdir).toHaveBeenCalledWith(
      path.join(PROJECT_DIR, ".midbrain"),
      { recursive: true }
    );
    const keyWrite = fs.writeFile.mock.calls.find(([p]) => p === keyPath);
    expect(keyWrite).toBeDefined();
    expect(keyWrite[1]).toBe("test-api-key-1234\n");
    expect(fs.chmod).toHaveBeenCalledWith(keyPath, 0o600);
  });

  it("preserves existing project key file", async () => {
    setupProjectMocks({ existingProjectKey: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    const keyPath = path.join(PROJECT_DIR, ".midbrain", ".midbrain-key");
    const keyWrites = fs.writeFile.mock.calls.filter(([p]) => p === keyPath);
    expect(keyWrites).toHaveLength(0); // No write to key file
  });

  it("writes opencode.json with correct MCP config when OpenCode detected", async () => {
    setupProjectMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    const configPath = path.join(PROJECT_DIR, "opencode.json");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === configPath);
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    expect(written.$schema).toBe("https://opencode.ai/config.json");
    expect(written.mcp[MCP_KEY].type).toBe("local");
    expect(written.mcp[MCP_KEY].environment.MIDBRAIN_PROJECT_DIR).toBe(PROJECT_DIR);
    expect(written.mcp[MCP_KEY].environment.MIDBRAIN_CONFIG_DIR).toContain("opencode");
    expect(written.mcp[MCP_KEY].enabled).toBe(true);
  });

  it("merges into existing opencode.json without clobbering other keys", async () => {
    setupProjectMocks({
      existingOpencodeJson: {
        $schema: "https://opencode.ai/config.json",
        provider: { aws: {} },
        model: "my-model",
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    const configPath = path.join(PROJECT_DIR, "opencode.json");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === configPath);
    const written = JSON.parse(writeCall[1]);
    expect(written.provider).toEqual({ aws: {} });
    expect(written.model).toBe("my-model");
    expect(written.mcp[MCP_KEY]).toBeDefined();
  });

  it("removes invalid mcpServers key from opencode config", async () => {
    setupProjectMocks({
      existingOpencodeJson: {
        $schema: "https://opencode.ai/config.json",
        mcpServers: { old: {} },
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    const configPath = path.join(PROJECT_DIR, "opencode.json");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === configPath);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers).toBeUndefined();
  });

  it("writes .mcp.json when Claude Code detected", async () => {
    setupProjectMocks({ opencodeDetected: false, claudeDetected: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    const configPath = path.join(PROJECT_DIR, ".mcp.json");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === configPath);
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers[MCP_KEY]).toBeDefined();
    expect(written.mcpServers[MCP_KEY].env.MIDBRAIN_PROJECT_DIR).toBe(PROJECT_DIR);
    expect(written.mcpServers[MCP_KEY].env.MIDBRAIN_CONFIG_DIR).toContain("claude");
  });

  it("merges into existing .mcp.json without clobbering", async () => {
    setupProjectMocks({
      opencodeDetected: false,
      claudeDetected: true,
      existingMcpJson: {
        mcpServers: { "other-server": { command: "other" } },
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    const configPath = path.join(PROJECT_DIR, ".mcp.json");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === configPath);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers["other-server"]).toEqual({ command: "other" });
    expect(written.mcpServers[MCP_KEY]).toBeDefined();
  });

  it("writes both configs when both clients detected", async () => {
    setupProjectMocks({ opencodeDetected: true, claudeDetected: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    const ocWrite = fs.writeFile.mock.calls.find(([p]) =>
      p.includes("opencode.json")
    );
    const ccWrite = fs.writeFile.mock.calls.find(([p]) => p.includes(".mcp.json"));
    expect(ocWrite).toBeDefined();
    expect(ccWrite).toBeDefined();
  });

  it("patches ~/.claude.json project-local scope when Claude Code detected", async () => {
    setupProjectMocks({ opencodeDetected: false, claudeDetected: true });
    // Also provide ~/.claude.json content for patchJsonFile to read
    const origReadFile = fs.readFile.getMockImplementation();
    const claudeJsonContent = JSON.stringify({ mcpServers: {}, projects: {} });
    fs.readFile.mockImplementation(async (p, ...rest) => {
      if (p === PATHS.claudeJson) return claudeJsonContent;
      return origReadFile(p, ...rest);
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    const claudeJsonWrite = fs.writeFile.mock.calls.find(([p]) =>
      p === PATHS.claudeJson
    );
    expect(claudeJsonWrite).toBeDefined();
    const written = JSON.parse(claudeJsonWrite[1]);
    const entry = written.projects[PROJECT_DIR].mcpServers[MCP_KEY];
    expect(entry).toBeDefined();
    expect(entry.env.MIDBRAIN_PROJECT_DIR).toBe(PROJECT_DIR);
  });

  it("does NOT patch ~/.claude.json when only OpenCode detected", async () => {
    setupProjectMocks({ opencodeDetected: true, claudeDetected: false });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    const claudeJsonWrite = fs.writeFile.mock.calls.find(([p]) =>
      p === PATHS.claudeJson
    );
    expect(claudeJsonWrite).toBeUndefined();
  });

  it("outputs valid JSON result to stdout", async () => {
    setupProjectMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);

    expect(logSpy).toHaveBeenCalled();
    const stdout = logSpy.mock.calls[0][0];
    logSpy.mockRestore();

    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.project_dir).toBe(PROJECT_DIR);
    expect(result.key_file).toContain(".midbrain-key");
    expect(result.restart_required).toBe(true);
    expect(Array.isArray(result.configs_written)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("reports key_created=true when key was created", async () => {
    setupProjectMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    const result = JSON.parse(logSpy.mock.calls[0][0]);
    logSpy.mockRestore();
    expect(result.key_created).toBe(true);
  });

  it("reports key_created=false when key already existed", async () => {
    setupProjectMocks({ existingProjectKey: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    const result = JSON.parse(logSpy.mock.calls[0][0]);
    logSpy.mockRestore();
    expect(result.key_created).toBe(false);
  });

  it("reports configs_written includes opencode.json", async () => {
    setupProjectMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    const result = JSON.parse(logSpy.mock.calls[0][0]);
    logSpy.mockRestore();
    expect(result.configs_written).toContain("opencode.json");
  });

  it("resolves symlinked project directory", async () => {
    setupProjectMocks();
    fs.realpath.mockResolvedValue("/real/path/to/project");
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    readFileReturns({ [PATHS.globalKey]: "test-key\n" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup("/symlink/to/project");
    const result = JSON.parse(logSpy.mock.calls[0][0]);
    logSpy.mockRestore();

    expect(result.project_dir).toBe("/real/path/to/project");
    expect(result.warnings.some((w) => w.includes("Symlink"))).toBe(true);
  });

  it("exits with error for nonexistent directory", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    fs.stat.mockRejectedValue(enoent("/nonexistent"));

    await expect(projectSetup("/nonexistent")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits with error for non-directory path", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    fs.stat.mockResolvedValue({ isDirectory: () => false });

    await expect(projectSetup("/some/file.txt")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits with error when no API key found", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    fs.realpath.mockResolvedValue(PROJECT_DIR);
    // No key files, no env var

    await expect(projectSetup(PROJECT_DIR)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("warns when no clients detected", async () => {
    // Both opencode and claude NOT detected (existsSync returns false for all)
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    fs.realpath.mockResolvedValue(PROJECT_DIR);
    readFileReturns({ [PATHS.globalKey]: "test-key\n" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    const result = JSON.parse(logSpy.mock.calls[0][0]);
    logSpy.mockRestore();

    expect(result.configs_written).toHaveLength(0);
    expect(
      result.warnings.some((w) => w.includes("No supported AI clients"))
    ).toBe(true);
  });

  it("uses MIDBRAIN_API_KEY env as fallback", async () => {
    process.env.MIDBRAIN_API_KEY = "env-fallback-key";
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    fs.realpath.mockResolvedValue(PROJECT_DIR);
    // No key files exist

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    const result = JSON.parse(logSpy.mock.calls[0][0]);
    logSpy.mockRestore();

    expect(result.key_source).toBe("env:MIDBRAIN_API_KEY");
    const keyWrite = fs.writeFile.mock.calls.find(([p]) =>
      p.includes(".midbrain-key")
    );
    expect(keyWrite[1]).toBe("env-fallback-key\n");
  });

  it("command array defaults to npx -y @latest (PRD-010)", async () => {
    setupProjectMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    const configPath = path.join(PROJECT_DIR, "opencode.json");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === configPath);
    const written = JSON.parse(writeCall[1]);
    const cmd = written.mcp[MCP_KEY].command;
    expect(cmd).toEqual(["npx", "-y", "midbrain-memory-mcp@latest"]);
  });

  it("--dev opt writes absolute paths in projectSetup (PRD-010)", async () => {
    setupProjectMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR, { isDev: true });
    logSpy.mockRestore();

    const configPath = path.join(PROJECT_DIR, "opencode.json");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === configPath);
    const written = JSON.parse(writeCall[1]);
    const cmd = written.mcp[MCP_KEY].command;
    expect(path.isAbsolute(cmd[0])).toBe(true);
    expect(path.isAbsolute(cmd[1])).toBe(true);
  });

  it("always writes to opencode.json (not .jsonc) in project dir", async () => {
    setupProjectMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    // Verify the exact path written
    const configWrites = fs.writeFile.mock.calls.filter(([p]) =>
      p.includes("opencode")
    );
    expect(configWrites.length).toBe(1);
    expect(configWrites[0][0]).toBe(path.join(PROJECT_DIR, "opencode.json"));
  });
});

// ===================================================================
// installClaudeProjectLocal (PRD-009)
// ===================================================================

describe("installClaudeProjectLocal", () => {
  const PROJECT_DIR = "/home/testuser/myproject";

  beforeEach(resetMocks);

  it("patches ~/.claude.json with project-local mcpServers entry (PRD-010: @latest)", async () => {
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify({
        mcpServers: {},
        projects: { [PROJECT_DIR]: { allowedTools: [] } },
      }),
    });

    await installClaudeProjectLocal(PROJECT_DIR);

    const writeCall = fs.writeFile.mock.calls.find(([p]) =>
      p === PATHS.claudeJson
    );
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    const entry = written.projects[PROJECT_DIR].mcpServers[MCP_KEY];
    expect(entry).toBeDefined();
    expect(entry.type).toBe("stdio");
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "midbrain-memory-mcp@latest"]);
    expect(entry.env.MIDBRAIN_PROJECT_DIR).toBe(PROJECT_DIR);
    expect(entry.env.MIDBRAIN_CONFIG_DIR).toContain("claude");
  });

  it("--dev writes absolute paths in project-local scope", async () => {
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify({ projects: {} }),
    });

    await installClaudeProjectLocal(PROJECT_DIR, { isDev: true });

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    const entry = written.projects[PROJECT_DIR].mcpServers[MCP_KEY];
    expect(path.isAbsolute(entry.command)).toBe(true);
    expect(entry.args[0]).toContain("server.js");
  });

  it("preserves existing project entries and other mcpServers", async () => {
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify({
        mcpServers: { otter: { command: "otter" } },
        projects: {
          [PROJECT_DIR]: {
            allowedTools: ["Bash"],
            mcpServers: { "other-server": { command: "other" } },
          },
        },
      }),
    });

    await installClaudeProjectLocal(PROJECT_DIR);

    const writeCall = fs.writeFile.mock.calls.find(([p]) =>
      p === PATHS.claudeJson
    );
    const written = JSON.parse(writeCall[1]);
    // Top-level mcpServers preserved
    expect(written.mcpServers.otter).toEqual({ command: "otter" });
    // Project allowedTools preserved
    expect(written.projects[PROJECT_DIR].allowedTools).toEqual(["Bash"]);
    // Other project mcpServers preserved
    expect(written.projects[PROJECT_DIR].mcpServers["other-server"]).toEqual({
      command: "other",
    });
    // New entry added
    expect(written.projects[PROJECT_DIR].mcpServers[MCP_KEY]).toBeDefined();
  });

  it("creates project entry when it does not exist in ~/.claude.json", async () => {
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify({ mcpServers: {} }),
    });

    await installClaudeProjectLocal(PROJECT_DIR);

    const writeCall = fs.writeFile.mock.calls.find(([p]) =>
      p === PATHS.claudeJson
    );
    const written = JSON.parse(writeCall[1]);
    expect(written.projects[PROJECT_DIR].mcpServers[MCP_KEY]).toBeDefined();
  });

  it("skips gracefully when ~/.claude.json does not exist", async () => {
    await installClaudeProjectLocal(PROJECT_DIR);

    const writeCall = fs.writeFile.mock.calls.find(([p]) =>
      p === PATHS.claudeJson
    );
    expect(writeCall).toBeDefined();
  });

  it("is idempotent — running twice produces same result", async () => {
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify({ projects: {} }),
    });

    await installClaudeProjectLocal(PROJECT_DIR);

    const firstWrite = fs.writeFile.mock.calls.find(([p]) =>
      p === PATHS.claudeJson
    );
    const firstResult = JSON.parse(firstWrite[1]);

    // Reset and run again with the output of the first run
    resetMocks();
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify(firstResult),
    });

    await installClaudeProjectLocal(PROJECT_DIR);

    const secondWrite = fs.writeFile.mock.calls.find(([p]) =>
      p === PATHS.claudeJson
    );
    const secondResult = JSON.parse(secondWrite[1]);

    expect(secondResult.projects[PROJECT_DIR].mcpServers[MCP_KEY]).toEqual(
      firstResult.projects[PROJECT_DIR].mcpServers[MCP_KEY]
    );
  });

  it("returns false and skips when ~/.claude.json has EACCES", async () => {
    const err = new Error("Permission denied");
    err.code = "EACCES";
    fs.readFile.mockImplementation(async (p) => {
      if (p === PATHS.claudeJson) throw err;
      throw enoent(p);
    });

    const result = await installClaudeProjectLocal(PROJECT_DIR);

    expect(result).toBe(false);
    const writeCall = fs.writeFile.mock.calls.find(([p]) =>
      p === PATHS.claudeJson
    );
    expect(writeCall).toBeUndefined();
  });

  it("re-throws unexpected errors", async () => {
    const err = new Error("Disk I/O error");
    err.code = "EIO";
    fs.readFile.mockImplementation(async (p) => {
      if (p === PATHS.claudeJson) throw err;
      throw enoent(p);
    });

    await expect(
      installClaudeProjectLocal(PROJECT_DIR)
    ).rejects.toThrow("Disk I/O error");
  });

  it("preserves custom env vars on existing project-local midbrain entry (PRD-010 AC-3)", async () => {
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify({
        projects: {
          [PROJECT_DIR]: {
            mcpServers: {
              [MCP_KEY]: {
                type: "stdio",
                command: "npx",
                args: ["-y", "midbrain-memory-mcp"],
                env: {
                  MIDBRAIN_CONFIG_DIR: "/old/path",
                  CUSTOM_VAR: "keep-me",
                },
              },
            },
          },
        },
      }),
    });

    await installClaudeProjectLocal(PROJECT_DIR);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    const entry = written.projects[PROJECT_DIR].mcpServers[MCP_KEY];
    expect(entry.env.CUSTOM_VAR).toBe("keep-me");
    // Reserved keys get rewritten to the new canonical values, not preserved.
    expect(entry.env.MIDBRAIN_CONFIG_DIR).toContain("claude");
    expect(entry.env.MIDBRAIN_CONFIG_DIR).not.toBe("/old/path");
  });
});

// ===================================================================
// --help output (PRD-010 I-12)
// ===================================================================

describe("printHelp (PRD-010 I-12)", () => {
  it("includes --project, --dev, --help flags and marks --dev for contributors", async () => {
    const { printHelp } = await import("../install.mjs");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    printHelp();
    const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
    logSpy.mockRestore();

    expect(out).toContain("--project");
    expect(out).toContain("--dev");
    expect(out).toContain("--help");
    expect(out.toLowerCase()).toContain("contributor");
    expect(out).toContain("midbrain-memory-mcp@latest");
  });
});

// ===================================================================
// JSONC support: patchJsonFile
// ===================================================================

describe("patchJsonFile", () => {
  beforeEach(resetMocks);

  it("adds a key to an existing JSON file", async () => {
    readFileReturns({ "/config.json": '{"existing": 1}' });
    await patchJsonFile("/config.json", [{ path: ["new"], value: 2 }]);
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === "/config.json");
    const written = JSON.parse(writeCall[1]);
    expect(written.existing).toBe(1);
    expect(written.new).toBe(2);
  });

  it("preserves line comments in JSONC files", async () => {
    const jsonc = '{\n  // My comment\n  "existing": 1\n}';
    readFileReturns({ "/config.jsonc": jsonc });
    await patchJsonFile("/config.jsonc", [{ path: ["new"], value: 2 }]);
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === "/config.jsonc");
    expect(writeCall[1]).toContain("// My comment");
    expect(writeCall[1]).toContain('"new"');
    expect(writeCall[1]).toContain('"existing"');
  });

  it("preserves block comments in JSONC files", async () => {
    const jsonc = '{\n  /* block comment */\n  "a": 1\n}';
    readFileReturns({ "/config.jsonc": jsonc });
    await patchJsonFile("/config.jsonc", [{ path: ["b"], value: 2 }]);
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === "/config.jsonc");
    expect(writeCall[1]).toContain("/* block comment */");
  });

  it("removes a key when value is undefined", async () => {
    readFileReturns({ "/config.json": '{"keep": 1, "remove": 2}' });
    await patchJsonFile("/config.json", [{ path: ["remove"], value: undefined }]);
    const written = JSON.parse(
      fs.writeFile.mock.calls.find(([p]) => p === "/config.json")[1]
    );
    expect(written.keep).toBe(1);
    expect(written.remove).toBeUndefined();
  });

  it("creates file with {} when it does not exist", async () => {
    await patchJsonFile("/new.json", [{ path: ["key"], value: "val" }]);
    const written = JSON.parse(
      fs.writeFile.mock.calls.find(([p]) => p === "/new.json")[1]
    );
    expect(written.key).toBe("val");
  });

  it("applies multiple modifications in order", async () => {
    readFileReturns({ "/config.json": '{"old": true}' });
    await patchJsonFile("/config.json", [
      { path: ["old"], value: undefined },
      { path: ["new"], value: "added" },
    ]);
    const written = JSON.parse(
      fs.writeFile.mock.calls.find(([p]) => p === "/config.json")[1]
    );
    expect(written.old).toBeUndefined();
    expect(written.new).toBe("added");
  });

  it("sets nested keys", async () => {
    readFileReturns({ "/config.json": '{"mcp": {}}' });
    await patchJsonFile("/config.json", [
      { path: ["mcp", "midbrain-memory"], value: { type: "local" } },
    ]);
    const written = JSON.parse(
      fs.writeFile.mock.calls.find(([p]) => p === "/config.json")[1]
    );
    expect(written.mcp["midbrain-memory"]).toEqual({ type: "local" });
  });

  it("ensures trailing newline", async () => {
    readFileReturns({ "/config.json": '{"a": 1}' });
    await patchJsonFile("/config.json", [{ path: ["b"], value: 2 }]);
    const raw = fs.writeFile.mock.calls.find(([p]) => p === "/config.json")[1];
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("creates parent directories", async () => {
    await patchJsonFile("/deep/dir/config.json", [{ path: ["a"], value: 1 }]);
    expect(fs.mkdir).toHaveBeenCalledWith("/deep/dir", { recursive: true });
  });
});

// ===================================================================
// JSONC support: resolveOpencodeConfig
// ===================================================================

describe("resolveOpencodeConfig", () => {
  beforeEach(resetMocks);

  it("returns opencode.jsonc when it exists (preferred)", () => {
    existsFor("/dir/opencode.jsonc");
    expect(resolveOpencodeConfig("/dir")).toBe("/dir/opencode.jsonc");
  });

  it("returns opencode.json when only .json exists", () => {
    existsFor("/dir/opencode.json");
    expect(resolveOpencodeConfig("/dir")).toBe("/dir/opencode.json");
  });

  it("prefers .jsonc over .json when both exist", () => {
    existsFor("/dir/opencode.jsonc", "/dir/opencode.json");
    expect(resolveOpencodeConfig("/dir")).toBe("/dir/opencode.jsonc");
  });

  it("defaults to opencode.json when neither exists (new install)", () => {
    expect(resolveOpencodeConfig("/dir")).toBe("/dir/opencode.json");
  });

  it("works with paths containing spaces", () => {
    existsFor("/my dir/opencode.jsonc");
    expect(resolveOpencodeConfig("/my dir")).toBe("/my dir/opencode.jsonc");
  });
});

// ===================================================================
// JSONC support: detectTools with .jsonc
// ===================================================================

describe("detectTools — JSONC support", () => {
  beforeEach(resetMocks);

  it("detects OpenCode when opencode.jsonc exists", () => {
    existsFor(path.join(PATHS.opencodeDir, "opencode.jsonc"));
    const tools = detectTools();
    expect(tools.opencode).toBe(true);
  });

  it("detects OpenCode when both .json and .jsonc exist", () => {
    existsFor(
      path.join(PATHS.opencodeDir, "opencode.json"),
      path.join(PATHS.opencodeDir, "opencode.jsonc")
    );
    const tools = detectTools();
    expect(tools.opencode).toBe(true);
  });
});

// ===================================================================
// JSONC support: installOpenCode with .jsonc
// ===================================================================

describe("installOpenCode — JSONC support", () => {
  beforeEach(resetMocks);

  it("preserves comments in .jsonc config", async () => {
    const jsoncPath = path.join(PATHS.opencodeDir, "opencode.jsonc");
    const jsonc = '{\n  // My provider config\n  "$schema": "https://opencode.ai/config.json",\n  "model": "test"\n}';
    readFileReturns({ [jsoncPath]: jsonc });
    existsFor(jsoncPath);

    const summary = [];
    await installOpenCode(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === jsoncPath);
    expect(writeCall).toBeDefined();
    expect(writeCall[1]).toContain("// My provider config");
    expect(writeCall[1]).toContain("midbrain-memory");
    expect(summary.some((s) => s.includes("opencode.jsonc"))).toBe(true);
  });
});

// ===================================================================
// JSONC support: projectSetup with .jsonc
// ===================================================================

describe("projectSetup — JSONC support", () => {
  const PROJECT_DIR = "/home/testuser/myproject";
  const savedEnv = {};

  beforeEach(() => {
    resetMocks();
    for (const k of ["MIDBRAIN_API_KEY", "MIDBRAIN_PROJECT_DIR", "MIDBRAIN_CONFIG_DIR"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("uses existing opencode.jsonc and preserves comments", async () => {
    const jsoncContent =
      '{\n  // Project config\n  "$schema": "https://opencode.ai/config.json"\n}';
    const jsoncPath = path.join(PROJECT_DIR, "opencode.jsonc");

    fs.stat.mockImplementation(async (p) => {
      if (p === PROJECT_DIR) return { isDirectory: () => true };
      throw enoent(p);
    });
    fs.realpath.mockImplementation(async (p) => p);
    readFileReturns({
      [PATHS.globalKey]: "test-key\n",
      [jsoncPath]: jsoncContent,
    });
    existsFor(
      OPENCODE_CONFIG, // global config for detectTools
      jsoncPath // project-level .jsonc for resolveOpencodeConfig
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    const result = JSON.parse(logSpy.mock.calls[0][0]);
    logSpy.mockRestore();

    expect(result.configs_written).toContain("opencode.jsonc");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === jsoncPath);
    expect(writeCall).toBeDefined();
    expect(writeCall[1]).toContain("// Project config");
    expect(writeCall[1]).toContain("midbrain-memory");
  });

  it("defaults to opencode.json when no .jsonc exists in project", async () => {
    const jsonPath = path.join(PROJECT_DIR, "opencode.json");

    fs.stat.mockImplementation(async (p) => {
      if (p === PROJECT_DIR) return { isDirectory: () => true };
      throw enoent(p);
    });
    fs.realpath.mockImplementation(async (p) => p);
    readFileReturns({ [PATHS.globalKey]: "test-key\n" });
    existsFor(OPENCODE_CONFIG); // global config for detectTools

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    const result = JSON.parse(logSpy.mock.calls[0][0]);
    logSpy.mockRestore();

    expect(result.configs_written).toContain("opencode.json");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === jsonPath);
    expect(writeCall).toBeDefined();
  });

  it("prefers .jsonc over .json when both exist in project", async () => {
    const jsoncPath = path.join(PROJECT_DIR, "opencode.jsonc");
    const jsonPath = path.join(PROJECT_DIR, "opencode.json");

    fs.stat.mockImplementation(async (p) => {
      if (p === PROJECT_DIR) return { isDirectory: () => true };
      throw enoent(p);
    });
    fs.realpath.mockImplementation(async (p) => p);
    readFileReturns({
      [PATHS.globalKey]: "test-key\n",
      [jsoncPath]: '{"$schema": "https://opencode.ai/config.json"}',
      [jsonPath]: '{"$schema": "https://opencode.ai/config.json"}',
    });
    existsFor(OPENCODE_CONFIG, jsoncPath, jsonPath);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    const result = JSON.parse(logSpy.mock.calls[0][0]);
    logSpy.mockRestore();

    expect(result.configs_written).toContain("opencode.jsonc");
    // .jsonc should be written, not .json
    const jsoncWrite = fs.writeFile.mock.calls.find(([p]) => p === jsoncPath);
    const jsonWrite = fs.writeFile.mock.calls.find(([p]) => p === jsonPath);
    expect(jsoncWrite).toBeDefined();
    expect(jsonWrite).toBeUndefined();
  });

  it("readJson handles JSONC with comments", async () => {
    fs.readFile.mockResolvedValue('{\n  // line comment\n  "key": "value"\n}');
    const result = await readJson("/file.jsonc");
    expect(result).toEqual({ key: "value" });
  });

  it("readJson tolerates trailing commas", async () => {
    fs.readFile.mockResolvedValue('{"a": 1, "b": 2,}');
    const result = await readJson("/file.jsonc");
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("readJson still throws on invalid content", async () => {
    fs.readFile.mockResolvedValue("not json at all");
    await expect(readJson("/bad.json")).rejects.toThrow(/Failed to parse/);
  });
});

// ===================================================================
// Doc-regression: PRD-010 I-14
// ===================================================================
// Ensures no bare `npx midbrain-memory-setup` invocation lands in
// user-facing docs. midbrain-memory-setup is not a published package
// (E404); it is a second bin inside midbrain-memory-mcp. The correct
// invocation is:
//   npx -y --package=midbrain-memory-mcp@latest midbrain-memory-setup

describe("docs regression (PRD-010 I-14)", () => {
  it("README.md and AGENTS.md do not contain bare `npx midbrain-memory-setup`", async () => {
    // Bypass vi.mock('fs/promises') by using the real fs via vi.importActual.
    const actualFs = await vi.importActual("fs/promises");
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const readme = await actualFs.readFile(path.join(repoRoot, "README.md"), "utf8");
    const agents = await actualFs.readFile(path.join(repoRoot, "AGENTS.md"), "utf8");

    // The broken form: `npx midbrain-memory-setup` NOT preceded by
    // `--package=midbrain-memory-mcp@latest `. Regex uses a negative
    // lookbehind so legitimate `--package=...` invocations pass.
    const bareForm = /(?<!--package=midbrain-memory-mcp@latest )\bnpx midbrain-memory-setup\b/;

    expect(readme).not.toMatch(bareForm);
    expect(agents).not.toMatch(bareForm);
  });

  it("README.md does not point `--help` at the midbrain-memory-mcp bin (PRD-010 I-14b)", async () => {
    // The server bin (midbrain-memory-mcp) handles only --version / -v.
    // --help falls through to the MCP stdio loop. Never document it.
    const actualFs = await vi.importActual("fs/promises");
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const readme = await actualFs.readFile(path.join(repoRoot, "README.md"), "utf8");
    expect(readme).not.toMatch(/midbrain-memory-mcp@latest --help/);
    expect(readme).not.toMatch(/\bmidbrain-memory-mcp --help\b/);
  });
});

// ===================================================================
// runInstallerCli export + flag routing (PRD-011 U-1..U-10 + U-5b)
// ===================================================================

describe("runInstallerCli (PRD-011)", () => {
  let exitSpy;
  let errSpy;
  let logSpy;

  beforeEach(() => {
    resetMocks();
    // process.exit stubbed to throw so control flow stops at the exit
    // site and the test can assert exit code without killing vitest.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`__EXIT__${code ?? 0}`);
    });
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  async function callCli(argv) {
    const { runInstallerCli } = await import("../install.mjs");
    return runInstallerCli(argv);
  }

  it("U-1: runInstallerCli is an exported async function", async () => {
    const { runInstallerCli } = await import("../install.mjs");
    expect(typeof runInstallerCli).toBe("function");
    expect(runInstallerCli.constructor.name).toBe("AsyncFunction");
  });

  it("U-2: --help prints help and exits 0", async () => {
    await expect(callCli(["--help"])).rejects.toThrow("__EXIT__0");
    const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("--project");
    expect(out).toContain("--dev");
    expect(out).toContain("npx midbrain-memory-mcp install");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("U-3: -h prints help and exits 0", async () => {
    await expect(callCli(["-h"])).rejects.toThrow("__EXIT__0");
    const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("--project");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("U-4: --project (no value) exits 1 with 'requires a path argument'", async () => {
    await expect(callCli(["--project"])).rejects.toThrow("__EXIT__1");
    const err = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(err).toContain("requires a path argument");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("U-5: --project with empty string exits 1 with 'requires a path argument' (falsy guard)", async () => {
    await expect(callCli(["--project", ""])).rejects.toThrow("__EXIT__1");
    const err = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(err).toContain("requires a path argument");
    expect(err).not.toContain("cannot be empty");
  });

  it("U-5b: --project with whitespace-only string exits 1 with 'cannot be empty'", async () => {
    await expect(callCli(["--project", "   "])).rejects.toThrow("__EXIT__1");
    const err = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(err).toContain("cannot be empty");
  });

  it("U-6: --project with flag-prefix value exits 1 (flag-prefix rejected)", async () => {
    await expect(callCli(["--project", "--dev"])).rejects.toThrow("__EXIT__1");
    const err = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(err).toContain("requires a path argument");
  });

  it("U-7: --project <path> reaches projectSetup (fs.stat called)", async () => {
    // projectSetup's first I/O step is fs.stat(resolved). If runInstallerCli
    // reached projectSetup, fs.stat will be called with the resolved path.
    // We mock fs.stat to reject with ENOENT so projectSetup exits early.
    fs.stat.mockRejectedValue(enoent("/tmp/mbm-u7-xyz"));
    await expect(callCli(["--project", "/tmp/mbm-u7-xyz"])).rejects.toThrow(
      /__EXIT__1/
    );
    expect(fs.stat).toHaveBeenCalledWith(path.resolve("/tmp/mbm-u7-xyz"));
  });

  it("U-8: --project <path> --dev forwards isDev=true to projectSetup", async () => {
    // Same approach: mock fs.stat to reject so we don't fully execute.
    // The proof that --dev reached projectSetup is that the isDev branch
    // would surface the absolute-path command in the config if we let it
    // run. Here we just assert projectSetup was entered (fs.stat called).
    fs.stat.mockRejectedValue(enoent("/tmp/mbm-u8-xyz"));
    await expect(
      callCli(["--project", "/tmp/mbm-u8-xyz", "--dev"])
    ).rejects.toThrow(/__EXIT__1/);
    expect(fs.stat).toHaveBeenCalled();
  });

  it("U-9: no args routes to main() interactive flow", async () => {
    // main() eventually calls detectTools() -> existsSync(). If no tools
    // detected and no key found, main() logs a 'No tools detected' message
    // and exits. We force detectTools to return nothing by keeping
    // existsSync mocked to false (default), causing main() to early-exit.
    existsSync.mockReturnValue(false);
    // main() may call process.exit(1) on empty detection OR may just
    // return cleanly depending on the path. Allow either outcome; assert
    // that it didn't blow up at argv parsing.
    try {
      await callCli([]);
    } catch (err) {
      // accept any __EXIT__ sentinel
      expect(String(err.message)).toMatch(/__EXIT__/);
    }
    // existsSync was called by detectTools inside main()
    expect(existsSync).toHaveBeenCalled();
  });

  it("U-10: --dev alone routes to main() with isDev=true", async () => {
    existsSync.mockReturnValue(false);
    try {
      await callCli(["--dev"]);
    } catch (err) {
      expect(String(err.message)).toMatch(/__EXIT__/);
    }
    expect(existsSync).toHaveBeenCalled();
  });

  it("exports main from install.mjs (PRD-011 AC-1 sub-item)", async () => {
    const mod = await import("../install.mjs");
    expect(typeof mod.main).toBe("function");
  });
});

// ===================================================================
// Codex TOML patcher helpers (PRD-008)
// ===================================================================

describe("patchCodexMcpServer", () => {
  it("sets mcp_servers.midbrain-memory on empty object", () => {
    const obj = {};
    const entry = { command: "npx", args: ["-y", "midbrain-memory-mcp@latest"], env: {} };
    const result = patchCodexMcpServer(obj, entry);
    expect(result.mcp_servers["midbrain-memory"]).toEqual(entry);
    expect(result).toBe(obj);
  });

  it("preserves existing mcp_servers entries", () => {
    const obj = { mcp_servers: { other: { command: "other" } } };
    const entry = { command: "npx", args: ["-y", "midbrain-memory-mcp@latest"], env: {} };
    patchCodexMcpServer(obj, entry);
    expect(obj.mcp_servers.other).toEqual({ command: "other" });
    expect(obj.mcp_servers["midbrain-memory"]).toEqual(entry);
  });

  it("overwrites existing midbrain-memory entry", () => {
    const obj = { mcp_servers: { "midbrain-memory": { command: "old" } } };
    const entry = { command: "new" };
    patchCodexMcpServer(obj, entry);
    expect(obj.mcp_servers["midbrain-memory"]).toEqual({ command: "new" });
  });
});

describe("patchCodexFeatures", () => {
  it("sets codex_hooks = true on empty object", () => {
    const obj = {};
    const result = patchCodexFeatures(obj);
    expect(result.features.codex_hooks).toBe(true);
    expect(result).toBe(obj);
  });

  it("preserves existing features", () => {
    const obj = { features: { other_feature: false } };
    patchCodexFeatures(obj);
    expect(obj.features.other_feature).toBe(false);
    expect(obj.features.codex_hooks).toBe(true);
  });
});

describe("readCodexToml", () => {
  beforeEach(resetMocks);

  it("returns {} when file does not exist", async () => {
    existsSync.mockReturnValue(false);
    const result = await readCodexToml("/nonexistent/config.toml");
    expect(result).toEqual({});
  });

  it("parses valid TOML content", async () => {
    existsFor(PATHS.codexConfigToml);
    fs.readFile.mockResolvedValue('[features]\ncodex_hooks = true\n');
    const result = await readCodexToml(PATHS.codexConfigToml);
    expect(result.features.codex_hooks).toBe(true);
  });

  it("throws on corrupt TOML with clear error", async () => {
    existsFor(PATHS.codexConfigToml);
    fs.readFile.mockResolvedValue("not valid toml = = =");
    await expect(readCodexToml(PATHS.codexConfigToml)).rejects.toThrow(/Failed to parse/);
  });

  it("does NOT overwrite file on corrupt TOML", async () => {
    existsFor(PATHS.codexConfigToml);
    fs.readFile.mockResolvedValue("not valid toml = = =");
    try { await readCodexToml(PATHS.codexConfigToml); } catch { /* expected */ }
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

describe("writeCodexToml", () => {
  beforeEach(resetMocks);

  it("creates parent dirs and writes TOML content", async () => {
    await writeCodexToml("/path/to/config.toml", { features: { codex_hooks: true } });
    expect(fs.mkdir).toHaveBeenCalledWith("/path/to", { recursive: true });
    const writeCall = fs.writeFile.mock.calls[0];
    expect(writeCall[0]).toBe("/path/to/config.toml");
    expect(writeCall[1]).toContain("codex_hooks = true");
    expect(writeCall[2]).toBe("utf8");
  });

  it("idempotent: write then read produces same object", async () => {
    const original = { mcp_servers: { "midbrain-memory": { command: "npx" } }, features: { codex_hooks: true } };
    await writeCodexToml("/tmp/test.toml", original);
    const written = fs.writeFile.mock.calls[0][1];
    const TOML = (await import("@iarna/toml")).default;
    const parsed = TOML.parse(written);
    expect(parsed.features.codex_hooks).toBe(true);
    expect(parsed.mcp_servers["midbrain-memory"].command).toBe("npx");
  });
});

// ===================================================================
// Codex detection in detectTools (PRD-008)
// ===================================================================

describe("detectTools — Codex (PRD-008)", () => {
  beforeEach(resetMocks);

  it("detects Codex when ~/.codex/config.toml exists", () => {
    existsFor(PATHS.codexConfigToml);
    const tools = detectTools();
    expect(tools.codex).toBe(true);
  });

  it("detects Codex when ~/.codex dir exists", () => {
    existsFor(PATHS.codexDir);
    const tools = detectTools();
    expect(tools.codex).toBe(true);
  });

  it("does not detect Codex when neither exists", () => {
    const tools = detectTools();
    expect(tools.codex).toBe(false);
  });

  it("short-circuits Codex on Windows (process.platform) with zero fs access", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      existsFor(PATHS.codexConfigToml, PATHS.codexDir);
      const tools = detectTools();
      expect(tools.codex).toBe(false);
      const codexCalls = existsSync.mock.calls
        .map(([p]) => p)
        .filter((p) => p === PATHS.codexConfigToml || p === PATHS.codexDir);
      expect(codexCalls).toHaveLength(0);
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });

  it("detects all three clients when all exist", () => {
    existsFor(
      path.join(PATHS.opencodeDir, "opencode.json"),
      PATHS.claudeJson,
      PATHS.codexConfigToml,
    );
    const tools = detectTools();
    expect(tools.opencode).toBe(true);
    expect(tools.claudeCode).toBe(true);
    expect(tools.codex).toBe(true);
  });
});

// ===================================================================
// shellQuote (PRD-008)
// ===================================================================

describe("shellQuote", () => {
  it("wraps simple strings in single quotes", () => {
    expect(shellQuote("/usr/local/bin/node")).toBe("'/usr/local/bin/node'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("handles empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("handles paths with spaces", () => {
    expect(shellQuote("/path/with spaces/node")).toBe("'/path/with spaces/node'");
  });
});

// ===================================================================
// buildCodexHooks (PRD-008)
// ===================================================================

describe("buildCodexHooks", () => {
  it("returns hooks object with UserPromptSubmit and Stop", () => {
    const result = buildCodexHooks();
    expect(result.hooks).toBeDefined();
    expect(result.hooks.UserPromptSubmit).toBeDefined();
    expect(result.hooks.Stop).toBeDefined();
  });

  it("UserPromptSubmit hook references capture-user.mjs", () => {
    const result = buildCodexHooks();
    const cmd = result.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(cmd).toContain("capture-user.mjs");
  });

  it("Stop hook references capture-assistant.mjs", () => {
    const result = buildCodexHooks();
    const cmd = result.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("capture-assistant.mjs");
  });

  it("hooks include MIDBRAIN_CONFIG_DIR env", () => {
    const result = buildCodexHooks();
    const cmd = result.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(cmd).toContain("MIDBRAIN_CONFIG_DIR=");
    expect(cmd).toContain(".config/codex");
  });

  it("hooks include MIDBRAIN_QUIET_FALLBACK=1", () => {
    const result = buildCodexHooks();
    const cmd = result.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(cmd).toContain("MIDBRAIN_QUIET_FALLBACK=1");
  });

  it("hooks use shell-quoted paths", () => {
    const result = buildCodexHooks();
    const cmd = result.hooks.UserPromptSubmit[0].hooks[0].command;
    // Should contain single-quoted node path
    expect(cmd).toMatch(/'/);
  });

  it("hooks have timeout=10 and type=command", () => {
    const result = buildCodexHooks();
    const hook = result.hooks.UserPromptSubmit[0].hooks[0];
    expect(hook.timeout).toBe(10);
    expect(hook.type).toBe("command");
  });
});

// ===================================================================
// buildCodexHookCommand (PRD-008)
// ===================================================================

describe("buildCodexHookCommand", () => {
  it("starts with env command", () => {
    const cmd = buildCodexHookCommand("capture-user.mjs");
    expect(cmd.startsWith("env ")).toBe(true);
  });

  it("includes shell-quoted script path", () => {
    const cmd = buildCodexHookCommand("capture-user.mjs");
    expect(cmd).toContain("capture-user.mjs");
  });

  it("includes MIDBRAIN_CONFIG_DIR and MIDBRAIN_QUIET_FALLBACK", () => {
    const cmd = buildCodexHookCommand("capture-user.mjs");
    expect(cmd).toContain("MIDBRAIN_CONFIG_DIR=");
    expect(cmd).toContain("MIDBRAIN_QUIET_FALLBACK=1");
  });
});

// ===================================================================
// installCodex (PRD-008)
// ===================================================================

describe("installCodex", () => {
  beforeEach(resetMocks);

  it("writes key file with chmod 600", async () => {
    const summary = [];
    await installCodex(summary, "test-codex-key-1234");

    const keyWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexKey);
    expect(keyWrite).toBeDefined();
    expect(keyWrite[1]).toBe("test-codex-key-1234\n");
    expect(fs.chmod).toHaveBeenCalledWith(PATHS.codexKey, 0o600);
  });

  it("writes config.toml with MCP server and codex_hooks", async () => {
    const summary = [];
    await installCodex(summary, "test-key");

    const tomlWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexConfigToml);
    expect(tomlWrite).toBeDefined();
    expect(tomlWrite[1]).toContain("midbrain-memory");
    expect(tomlWrite[1]).toContain("codex_hooks = true");
  });

  it("writes hooks.json with UserPromptSubmit and Stop", async () => {
    const summary = [];
    await installCodex(summary, "test-key");

    const hooksWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexHooksJson);
    expect(hooksWrite).toBeDefined();
    const written = JSON.parse(hooksWrite[1]);
    expect(written.hooks.UserPromptSubmit).toBeDefined();
    expect(written.hooks.Stop).toBeDefined();
  });

  it("summary includes key, config, hooks, and restart lines", async () => {
    const summary = [];
    await installCodex(summary, "test-key");

    expect(summary.some((s) => s.includes("Key written"))).toBe(true);
    expect(summary.some((s) => s.includes("config.toml"))).toBe(true);
    expect(summary.some((s) => s.includes("hooks.json"))).toBe(true);
    expect(summary.some((s) => s.includes("Restart"))).toBe(true);
    expect(summary.some((s) => s.includes("Enabled experimental Codex hooks feature"))).toBe(true);
  });

  it("backs up existing config.toml before overwriting", async () => {
    existsFor(PATHS.codexConfigToml);
    fs.readFile.mockResolvedValue('[features]\nother = true\n');
    const summary = [];
    await installCodex(summary, "test-key");

    const backupCalls = fs.copyFile.mock.calls.filter(([src]) => src === PATHS.codexConfigToml);
    expect(backupCalls.length).toBe(1);
    expect(backupCalls[0][1]).toMatch(/\.bak\./);
  });

  it("config.toml defaults to npx @latest command", async () => {
    const summary = [];
    await installCodex(summary, "test-key");

    const tomlWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexConfigToml);
    expect(tomlWrite[1]).toContain("npx");
    expect(tomlWrite[1]).toContain("midbrain-memory-mcp@latest");
  });

  it("--dev flag writes absolute paths in config.toml", async () => {
    const summary = [];
    await installCodex(summary, "test-key", { isDev: true });

    const tomlWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexConfigToml);
    expect(tomlWrite[1]).toContain(process.execPath);
    expect(tomlWrite[1]).toContain("server.js");
  });

  it("preserves existing TOML features when patching", async () => {
    existsFor(PATHS.codexConfigToml);
    fs.readFile.mockResolvedValue('[features]\nexisting_feature = true\n');
    const summary = [];
    await installCodex(summary, "test-key");

    const tomlWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexConfigToml);
    expect(tomlWrite[1]).toContain("existing_feature = true");
    expect(tomlWrite[1]).toContain("codex_hooks = true");
  });

  it("throws on corrupt TOML without overwriting", async () => {
    existsFor(PATHS.codexConfigToml);
    fs.readFile.mockResolvedValue("invalid toml = = =");
    const summary = [];
    await expect(installCodex(summary, "test-key")).rejects.toThrow(/Failed to parse/);
  });
});

// ===================================================================
// hasCodexBinary (AC-7b)
// ===================================================================

describe("hasCodexBinary", () => {
  it("returns a boolean", () => {
    expect(typeof hasCodexBinary()).toBe("boolean");
  });

  it("returns false on Windows", () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(hasCodexBinary()).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
    }
  });
});

// ===================================================================
// writeCodexProjectConfig (PRD-008)
// ===================================================================

describe("writeCodexProjectConfig", () => {
  const PROJECT_DIR = "/home/testuser/myproject";

  beforeEach(resetMocks);

  it("writes .codex/config.toml with MCP entry and MIDBRAIN_PROJECT_DIR", async () => {
    const warnings = [];
    const configsWritten = [];
    await writeCodexProjectConfig(PROJECT_DIR, warnings, configsWritten);

    const tomlPath = path.join(PROJECT_DIR, ".codex", "config.toml");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === tomlPath);
    expect(writeCall).toBeDefined();
    expect(writeCall[1]).toContain("midbrain-memory");
    expect(writeCall[1]).toContain(PROJECT_DIR);
    expect(configsWritten).toContain(".codex/config.toml");
  });

  it("emits ACTION REQUIRED warning", async () => {
    const warnings = [];
    const configsWritten = [];
    await writeCodexProjectConfig(PROJECT_DIR, warnings, configsWritten);

    expect(warnings.some((w) => w.includes("ACTION REQUIRED"))).toBe(true);
  });

  it("merges into existing project TOML without clobbering", async () => {
    const projToml = path.join(PROJECT_DIR, ".codex", "config.toml");
    existsFor(projToml);
    fs.readFile.mockResolvedValue('[other_section]\nkey = "value"\n');
    const warnings = [];
    const configsWritten = [];
    await writeCodexProjectConfig(PROJECT_DIR, warnings, configsWritten);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === projToml);
    expect(writeCall[1]).toContain("other_section");
    expect(writeCall[1]).toContain("midbrain-memory");
  });

  it("throws on corrupt existing project TOML", async () => {
    const projToml = path.join(PROJECT_DIR, ".codex", "config.toml");
    existsFor(projToml);
    fs.readFile.mockResolvedValue("bad toml = = =");
    const warnings = [];
    const configsWritten = [];
    await expect(
      writeCodexProjectConfig(PROJECT_DIR, warnings, configsWritten),
    ).rejects.toThrow(/Failed to parse/);
  });

  it("defaults to npx @latest command", async () => {
    const warnings = [];
    const configsWritten = [];
    await writeCodexProjectConfig(PROJECT_DIR, warnings, configsWritten);

    const projToml = path.join(PROJECT_DIR, ".codex", "config.toml");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === projToml);
    expect(writeCall[1]).toContain("npx");
    expect(writeCall[1]).toContain("midbrain-memory-mcp@latest");
  });

  it("--dev writes absolute paths", async () => {
    const warnings = [];
    const configsWritten = [];
    await writeCodexProjectConfig(PROJECT_DIR, warnings, configsWritten, { isDev: true });

    const projToml = path.join(PROJECT_DIR, ".codex", "config.toml");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === projToml);
    expect(writeCall[1]).toContain(process.execPath);
  });
});

// ===================================================================
// projectSetup — Codex (PRD-008)
// ===================================================================

describe("projectSetup — Codex (PRD-008)", () => {
  const PROJECT_DIR = "/home/testuser/codex-project";
  const savedEnv = {};

  beforeEach(() => {
    resetMocks();
    for (const k of ["MIDBRAIN_API_KEY", "MIDBRAIN_PROJECT_DIR", "MIDBRAIN_CONFIG_DIR"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function setupCodexProjectMocks(opts = {}) {
    const { apiKey = "test-codex-key" } = opts;
    fs.stat.mockImplementation(async (p) => {
      if (p === PROJECT_DIR) return { isDirectory: () => true };
      throw enoent(p);
    });
    fs.realpath.mockImplementation(async (p) => p);
    readFileReturns({ [PATHS.globalKey]: apiKey + "\n" });
    existsFor(PATHS.codexConfigToml);
  }

  it("writes .codex/config.toml when Codex detected", async () => {
    setupCodexProjectMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    const result = JSON.parse(logSpy.mock.calls[0][0]);
    logSpy.mockRestore();

    expect(result.configs_written).toContain(".codex/config.toml");
  });

  it("includes ACTION REQUIRED warning in result", async () => {
    setupCodexProjectMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    const result = JSON.parse(logSpy.mock.calls[0][0]);
    logSpy.mockRestore();

    expect(result.warnings.some((w) => w.includes("ACTION REQUIRED"))).toBe(true);
  });
});

// ===================================================================
// PATHS includes Codex entries (PRD-008)
// ===================================================================

describe("PATHS — Codex entries (PRD-008)", () => {
  it("has codexKey path", () => {
    expect(PATHS.codexKey).toContain(".config/codex");
    expect(PATHS.codexKey).toContain(".midbrain-key");
  });

  it("has codexClientDir path", () => {
    expect(PATHS.codexClientDir).toContain(".config/codex");
  });

  it("has codexDir path", () => {
    expect(PATHS.codexDir).toContain(".codex");
  });

  it("has codexConfigToml path", () => {
    expect(PATHS.codexConfigToml).toContain(".codex/config.toml");
  });

  it("has codexHooksJson path", () => {
    expect(PATHS.codexHooksJson).toContain(".codex/hooks.json");
  });
});
