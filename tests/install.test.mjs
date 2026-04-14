/**
 * Unit tests for install.mjs (ORIGINAL behavior before jsonc-parser migration)
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
  detectTools,
  projectSetup,
  installOpenCode,
  installClaudeJson,
  installClaudeSettings,
  PATHS,
  MCP_KEY,
} = await import("../install.mjs");

const fs = (await import("fs/promises")).default;
const { existsSync } = await import("fs");

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
    existsFor(PATHS.opencodeConfig);
    const tools = detectTools();
    expect(tools.opencode).toBe(true);
  });

  it("does not detect OpenCode when opencode.json is missing", () => {
    // existsSync returns false for everything (default)
    const tools = detectTools();
    expect(tools.opencode).toBe(false);
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
    existsFor(PATHS.opencodeConfig, PATHS.claudeJson);
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
    // Should have checked opencodeConfig, claudeJson, claudeSettings
    const checkedPaths = existsSync.mock.calls.map(([p]) => p);
    expect(checkedPaths).toContain(PATHS.opencodeConfig);
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
    readFileReturns({ [PATHS.opencodeConfig]: JSON.stringify(configContent) });
    existsFor(PATHS.opencodeConfig);
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

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
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

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
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

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
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

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers).toBeUndefined();
    expect(summary.some((s) => s.includes("mcpServers"))).toBe(true);
  });

  it("backs up config before writing", async () => {
    setupOpenCode({ $schema: "https://opencode.ai/config.json" });
    const summary = [];
    await installOpenCode(summary);

    expect(fs.copyFile).toHaveBeenCalledWith(
      PATHS.opencodeConfig,
      PATHS.opencodeConfig + ".bak"
    );
  });

  it("throws when config file cannot be read", async () => {
    // readJson returns null for nonexistent config
    const summary = [];
    await expect(installOpenCode(summary)).rejects.toThrow(/Cannot read/);
  });

  it("command array contains absolute node path and server.js path", async () => {
    setupOpenCode({ $schema: "https://opencode.ai/config.json" });
    const summary = [];
    await installOpenCode(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
    const written = JSON.parse(writeCall[1]);
    const cmd = written.mcp[MCP_KEY].command;
    expect(cmd).toHaveLength(2);
    expect(path.isAbsolute(cmd[0])).toBe(true); // node path
    expect(cmd[1]).toContain("server.js");
  });

  it("summary reports addition for new MCP entry", async () => {
    setupOpenCode({ $schema: "https://opencode.ai/config.json" });
    const summary = [];
    await installOpenCode(summary);
    expect(summary.some((s) => s.includes("added") || s.includes("MCP server"))).toBe(true);
  });

  it("writes to PATHS.opencodeConfig (opencode.json)", async () => {
    setupOpenCode({ $schema: "https://opencode.ai/config.json" });
    const summary = [];
    await installOpenCode(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeConfig);
    expect(writeCall).toBeDefined();
    expect(PATHS.opencodeConfig).toContain("opencode.json");
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

  it("command is absolute node path, args contains server.js", async () => {
    readFileReturns({ [PATHS.claudeJson]: "{}" });
    existsFor(PATHS.claudeJson);
    const summary = [];
    await installClaudeJson(summary);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    const srv = written.mcpServers[MCP_KEY];
    expect(path.isAbsolute(srv.command)).toBe(true);
    expect(srv.args[0]).toContain("server.js");
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
      existsPaths.push(PATHS.opencodeConfig);
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

  it("command arrays use absolute paths", async () => {
    setupProjectMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
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
