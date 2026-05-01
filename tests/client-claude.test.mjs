/**
 * Unit tests for shared/clients/claude.mjs
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

const { Claude } = await import("../shared/clients/claude.mjs");

const HOME = os.homedir();
const MCP_KEY = "midbrain-memory";

const PATHS = {
  claudeJson:     path.join(HOME, ".claude.json"),
  claudeSettings: path.join(HOME, ".claude", "settings.json"),
};

// ===================================================================
// isInstalled
// ===================================================================

describe("Claude.isInstalled", () => {
  const cc = new Claude();
  beforeEach(resetMocks);

  it("detects via .claude.json", () => {
    existsFor(PATHS.claudeJson);
    expect(cc.isInstalled()).toBe(true);
  });

  it("detects via settings.json", () => {
    existsFor(PATHS.claudeSettings);
    expect(cc.isInstalled()).toBe(true);
  });

  it("detects when both exist", () => {
    existsFor(PATHS.claudeJson, PATHS.claudeSettings);
    expect(cc.isInstalled()).toBe(true);
  });

  it("returns false when neither exists", () => {
    expect(cc.isInstalled()).toBe(false);
  });
});

// ===================================================================
// installGlobal
// ===================================================================

describe("Claude.installGlobal", () => {
  const cc = new Claude();
  beforeEach(resetMocks);

  it("adds MCP server to .claude.json", async () => {
    readFileReturns({ [PATHS.claudeJson]: '{"mcpServers": {}}' });
    existsFor(PATHS.claudeJson);
    await cc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers[MCP_KEY]).toBeDefined();
    expect(written.mcpServers[MCP_KEY].type).toBe("stdio");
    expect(written.mcpServers[MCP_KEY].env.MIDBRAIN_CLIENT).toBe("claude");
  });

  it("preserves existing mcpServers entries", async () => {
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify({
        mcpServers: { "other-mcp": { command: "other" } },
      }),
    });
    existsFor(PATHS.claudeJson);
    await cc.installGlobal();

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
    const lines = await cc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers[MCP_KEY].command).not.toBe("old-node");
    expect(lines.some((s) => s.includes("updated"))).toBe(true);
  });

  it("creates .claude.json from scratch when file missing", async () => {
    const lines = await cc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers[MCP_KEY]).toBeDefined();
    expect(lines.some((s) => s.includes("added"))).toBe(true);
  });

  it("command defaults to npx -y midbrain-memory-mcp@latest", async () => {
    readFileReturns({ [PATHS.claudeJson]: "{}" });
    existsFor(PATHS.claudeJson);
    await cc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    const srv = written.mcpServers[MCP_KEY];
    expect(srv.command).toBe("npx");
    expect(srv.args).toEqual(["-y", "midbrain-memory-mcp@latest"]);
  });

  it("--dev writes absolute node + index.js paths", async () => {
    readFileReturns({ [PATHS.claudeJson]: "{}" });
    existsFor(PATHS.claudeJson);
    await cc.installGlobal({ isDev: true });

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    const srv = written.mcpServers[MCP_KEY];
    expect(path.isAbsolute(srv.command)).toBe(true);
    expect(srv.args[0]).toContain("index.js");
  });

  it("preserves custom env vars on existing midbrain entry", async () => {
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify({
        mcpServers: {
          [MCP_KEY]: {
            type: "stdio", command: "/old/node", args: ["/old/index.js"],
            env: { MIDBRAIN_CONFIG_DIR: "/old/cfg", CUSTOM_CC: "keep-me" },
          },
        },
      }),
    });
    existsFor(PATHS.claudeJson);
    await cc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    const env = written.mcpServers[MCP_KEY].env;
    expect(env.CUSTOM_CC).toBe("keep-me");
    expect(env.MIDBRAIN_CLIENT).toBe("claude");
    expect(env.MIDBRAIN_CONFIG_DIR).toBeUndefined();
  });

  it("adds hooks and permissions to settings.json", async () => {
    await cc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeSettings);
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    expect(written.hooks.UserPromptSubmit).toBeDefined();
    expect(written.hooks.Stop).toBeDefined();
    expect(written.permissions.allow).toContain("mcp__midbrain-memory__memory_search");
  });

  it("adds all 6 permission keys", async () => {
    await cc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeSettings);
    const written = JSON.parse(writeCall[1]);
    expect(written.permissions.allow).toHaveLength(6);
    expect(written.permissions.allow).toContain("mcp__midbrain-memory__grep");
    expect(written.permissions.allow).toContain("mcp__midbrain-memory__list_files");
    expect(written.permissions.allow).toContain("mcp__midbrain-memory__read_file");
    expect(written.permissions.allow).toContain("mcp__midbrain-memory__memory_setup_project");
    expect(written.permissions.allow).toContain("mcp__midbrain-memory__get_episodic_memories_by_date");
  });

  it("does not duplicate existing permissions", async () => {
    readFileReturns({
      [PATHS.claudeSettings]: JSON.stringify({
        permissions: { allow: ["mcp__midbrain-memory__memory_search", "mcp__midbrain-memory__grep"] },
      }),
    });
    await cc.installGlobal();

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeSettings);
    const written = JSON.parse(writeCall[1]);
    const midbrainPerms = written.permissions.allow.filter((p) => p.startsWith("mcp__midbrain-memory__"));
    expect(midbrainPerms).toHaveLength(6);
  });

  it("hooks contain capture script paths", async () => {
    await cc.installGlobal();

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
});

// ===================================================================
// installProject
// ===================================================================

describe("Claude.installProject", () => {
  const cc = new Claude();
  const PROJECT_DIR = "/home/testuser/myproject";
  beforeEach(resetMocks);

  it("writes .mcp.json with project-level MCP config", async () => {
    await cc.installProject(PROJECT_DIR);

    const configPath = path.join(PROJECT_DIR, ".mcp.json");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === configPath);
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    expect(written.mcpServers[MCP_KEY]).toBeDefined();
    expect(written.mcpServers[MCP_KEY].env.MIDBRAIN_PROJECT_DIR).toBe(PROJECT_DIR);
    expect(written.mcpServers[MCP_KEY].env.MIDBRAIN_CLIENT).toBe("claude");
  });

  it("patches ~/.claude.json project-local scope (trust gate bypass)", async () => {
    readFileReturns({ [PATHS.claudeJson]: JSON.stringify({ projects: {} }) });
    await cc.installProject(PROJECT_DIR);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    expect(writeCall).toBeDefined();
    const written = JSON.parse(writeCall[1]);
    const entry = written.projects[PROJECT_DIR].mcpServers[MCP_KEY];
    expect(entry).toBeDefined();
    expect(entry.env.MIDBRAIN_PROJECT_DIR).toBe(PROJECT_DIR);
  });

  it("preserves custom env vars on existing project-local entry", async () => {
    readFileReturns({
      [PATHS.claudeJson]: JSON.stringify({
        projects: {
          [PROJECT_DIR]: {
            mcpServers: {
              [MCP_KEY]: {
                type: "stdio", command: "npx", args: ["-y", "midbrain-memory-mcp"],
                env: { MIDBRAIN_CONFIG_DIR: "/old", CUSTOM_VAR: "keep-me" },
              },
            },
          },
        },
      }),
    });
    await cc.installProject(PROJECT_DIR);

    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const written = JSON.parse(writeCall[1]);
    const entry = written.projects[PROJECT_DIR].mcpServers[MCP_KEY];
    expect(entry.env.CUSTOM_VAR).toBe("keep-me");
    expect(entry.env.MIDBRAIN_CLIENT).toBe("claude");
    expect(entry.env.MIDBRAIN_CONFIG_DIR).toBeUndefined();
  });

  it("is idempotent — second run skips write when already at @latest", async () => {
    readFileReturns({ [PATHS.claudeJson]: JSON.stringify({ projects: {} }) });
    await cc.installProject(PROJECT_DIR);

    const firstWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeJson);
    const firstResult = JSON.parse(firstWrite[1]);

    resetMocks();
    readFileReturns({ [PATHS.claudeJson]: JSON.stringify(firstResult) });
    await cc.installProject(PROJECT_DIR);

    expect(firstResult.projects[PROJECT_DIR].mcpServers[MCP_KEY]).toBeDefined();
  });
});
