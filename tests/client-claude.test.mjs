/**
 * Unit tests for shared/clients/claude.mjs
 *
 * All filesystem operations are mocked — no real files read or written.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "node:url";

import { makeResetMocks, makeExistsFor, makeReadFileReturns } from "./fs-mock.mjs";
import { formatPkContext } from "../shared/pk-inject.mjs";

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
const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");

const PATHS = {
  claudeKey:      path.join(HOME, ".config", "claude", ".midbrain-key"),
  claudeJson:     path.join(HOME, ".claude.json"),
  claudeSettings: path.join(HOME, ".claude", "settings.json"),
};

function fileError(code, filePath) {
  const err = new Error(`${code}: test failure, open '${filePath}'`);
  err.code = code;
  return err;
}

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
// resolveClientKey
// ===================================================================

describe("Claude.resolveClientKey", () => {
  const cc = new Claude();
  beforeEach(resetMocks);

  it("returns the client key when present", async () => {
    readFileReturns({ [PATHS.claudeKey]: "claude-key\n" });

    await expect(cc.resolveClientKey()).resolves.toEqual({
      key: "claude-key",
      source: PATHS.claudeKey,
    });
  });

  it("returns null when the client key file is missing", async () => {
    await expect(cc.resolveClientKey()).resolves.toBeNull();
  });

  it("throws when the client key file is empty", async () => {
    readFileReturns({ [PATHS.claudeKey]: " \n" });

    await expect(cc.resolveClientKey()).rejects.toThrow(/Key file is empty/);
    await expect(cc.resolveClientKey()).rejects.toThrow(PATHS.claudeKey);
  });

  it("throws when the client key file is unreadable", async () => {
    mocks.readFile.mockRejectedValue(fileError("EACCES", PATHS.claudeKey));

    await expect(cc.resolveClientKey()).rejects.toThrow(/Permission denied reading key file/);
    await expect(cc.resolveClientKey()).rejects.toThrow(PATHS.claudeKey);
  });

  it("throws unexpected client key read errors", async () => {
    mocks.readFile.mockRejectedValue(fileError("EIO", PATHS.claudeKey));

    await expect(cc.resolveClientKey()).rejects.toThrow(/EIO/);
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
    expect(userHook.async).not.toBe(true);
    expect(stopHook.async).toBe(true);
  });
});

// ===================================================================
// capture-user hook stdout contract
// ===================================================================

describe("Claude capture-user hook wrapper", () => {
  function tempHomeWithKey() {
    const home = fsSync.mkdtempSync(path.join(os.tmpdir(), "claude-hook-home-"));
    const keyDir = path.join(home, ".config", "midbrain");
    fsSync.mkdirSync(keyDir, { recursive: true });
    fsSync.writeFileSync(path.join(keyDir, ".midbrain-key"), "test-key\n", { mode: 0o600 });
    return home;
  }

  function preload(mode) {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "claude-hook-preload-"));
    const file = path.join(dir, "fetch-preload.mjs");
    fsSync.writeFileSync(file, `
      globalThis.fetch = async (url) => {
        const text = String(url);
        if (${JSON.stringify(mode)} === "throw") throw new Error("network down");
        if (text.includes("/memories/episodic")) return { ok: true, status: 201 };
        if (text.includes("/memories/search/procedural")) {
          const body = ${JSON.stringify(mode)} === "match"
            ? [{ id: 42, title: "Workflow", content: "Use the checklist" }]
            : [];
          return { ok: true, status: 200, json: async () => body };
        }
        return { ok: false, status: 404, text: async () => "not found" };
      };
    `);
    return { dir, file };
  }

  function runHook(input, { mode = "empty", home = tempHomeWithKey() } = {}) {
    const loaded = preload(mode);
    const result = spawnSync(process.execPath, [
      "--import", loaded.file,
      path.join(REPO_ROOT, "plugins", "claude-code", "capture-user.mjs"),
    ], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    fsSync.rmSync(loaded.dir, { recursive: true, force: true });
    return result;
  }

  it("emits hookSpecificOutput.additionalContext when PK matches", () => {
    const result = runHook({ prompt: "workflow please", cwd: "/repo" }, { mode: "match" });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(payload.hookSpecificOutput.additionalContext).toContain("<!-- mb:ctx-start -->");
    expect(payload.hookSpecificOutput.additionalContext).toContain("Workflow");
  });

  it("emits no stdout when no PK matches", () => {
    const result = runHook({ prompt: "unrelated", cwd: "/repo" }, { mode: "empty" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("fails open with no stdout when the API fails", () => {
    const result = runHook({ prompt: "workflow please", cwd: "/repo" }, { mode: "throw" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("fails open with no stdout when no key is configured", () => {
    const home = fsSync.mkdtempSync(path.join(os.tmpdir(), "claude-hook-no-key-"));
    const result = runHook({ prompt: "workflow please", cwd: "/repo" }, { mode: "match", home });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    fsSync.rmSync(home, { recursive: true, force: true });
  });
});

// ===================================================================
// capture-assistant hook storage contract
// ===================================================================

describe("Claude capture-assistant hook wrapper", () => {
  function tempHomeWithKey() {
    const home = fsSync.mkdtempSync(path.join(os.tmpdir(), "claude-assist-home-"));
    const keyDir = path.join(home, ".config", "midbrain");
    fsSync.mkdirSync(keyDir, { recursive: true });
    fsSync.writeFileSync(path.join(keyDir, ".midbrain-key"), "test-key\n", { mode: 0o600 });
    return home;
  }

  function preload(logPath) {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "claude-assist-preload-"));
    const file = path.join(dir, "fetch-preload.mjs");
    fsSync.writeFileSync(file, `
      import fs from "node:fs";
      globalThis.fetch = async (_url, opts = {}) => {
        if (opts.body) fs.appendFileSync(${JSON.stringify(logPath)}, opts.body + "\\n");
        return { ok: true, status: 201 };
      };
    `);
    return { dir, file };
  }

  it("scrubs echoed injected PK blocks before storing assistant memory", () => {
    const home = tempHomeWithKey();
    const logPath = path.join(fsSync.mkdtempSync(path.join(os.tmpdir(), "claude-assist-log-")), "fetch.jsonl");
    const loaded = preload(logPath);
    const block = formatPkContext([{ id: 33, title: "Claude Echo", content: "do not store" }]);

    const result = spawnSync(process.execPath, [
      "--import", loaded.file,
      path.join(REPO_ROOT, "plugins", "claude-code", "capture-assistant.mjs"),
    ], {
      input: JSON.stringify({ last_assistant_message: `${block}\n\nVisible response`, cwd: "/repo" }),
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    const [body] = fsSync.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(body.text).toBe("Visible response");
    expect(body.text).not.toContain("Claude Echo");
    expect(body.text).not.toContain("<!-- mb:pk 33 -->");
    fsSync.rmSync(home, { recursive: true, force: true });
    fsSync.rmSync(path.dirname(logPath), { recursive: true, force: true });
    fsSync.rmSync(loaded.dir, { recursive: true, force: true });
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

  it("does not overwrite corrupt ~/.claude.json project-local config", async () => {
    readFileReturns({
      [PATHS.claudeJson]: "{ not json",
    });
    existsFor(PATHS.claudeJson);

    await expect(cc.installProject(PROJECT_DIR)).rejects.toThrow(/could not patch/i);
    await expect(cc.installProject(PROJECT_DIR)).rejects.toThrow(PATHS.claudeJson);

    const claudeJsonWrites = fs.writeFile.mock.calls.filter(([p]) => p === PATHS.claudeJson);
    expect(claudeJsonWrites).toHaveLength(0);
  });
});
