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
const TOML = await import("smol-toml");

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

describe("Codex.installGlobal", () => {
  const codex = new Codex();
  beforeEach(resetMocks);

  function writtenToml() {
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexConfig);
    expect(writeCall).toBeDefined();
    return TOML.parse(writeCall[1]);
  }

  function writtenHooks() {
    const hooksPath = path.join(PATHS.codexDir, "hooks.json");
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === hooksPath);
    expect(writeCall).toBeDefined();
    return JSON.parse(writeCall[1]);
  }

  it("writes global config.toml with the default npx @latest MCP entry", async () => {
    await codex.installGlobal();

    const entry = writtenToml().mcp_servers["midbrain-memory"];
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "midbrain-memory-mcp@latest"]);
    expect(entry.env.MIDBRAIN_CLIENT).toBe("codex");
  });

  it("--dev writes process.execPath and absolute index.js", async () => {
    await codex.installGlobal({ isDev: true });

    const entry = writtenToml().mcp_servers["midbrain-memory"];
    expect(entry.command).toBe(process.execPath);
    expect(path.isAbsolute(entry.args[0])).toBe(true);
    expect(entry.args[0]).toContain("index.js");
  });

  it("writes hooks.json for UserPromptSubmit, PostToolUse, and Stop", async () => {
    await codex.installGlobal();

    const hooks = writtenHooks().hooks;
    for (const event of ["UserPromptSubmit", "PostToolUse", "Stop"]) {
      expect(hooks[event]).toHaveLength(1);
      const hook = hooks[event][0].hooks[0];
      expect(hook.type).toBe("command");
      expect(hook.command).toContain(process.execPath);
      expect(hook).not.toHaveProperty("async");
    }
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toContain("capture-user.mjs");
    expect(hooks.PostToolUse[0].hooks[0].command).toContain("capture-tool.mjs");
    expect(hooks.Stop[0].hooks[0].command).toContain("capture-assistant.mjs");
  });

  it("does not write deprecated codex_hooks for new config", async () => {
    await codex.installGlobal();

    const parsed = writtenToml();
    expect(parsed.features?.codex_hooks).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("codex_hooks");
  });

  it("migrates deprecated codex_hooks to canonical hooks", async () => {
    existsFor(PATHS.codexConfig);
    readFileReturns({ [PATHS.codexConfig]: "[features]\ncodex_hooks = true\nother = true\n" });

    await codex.installGlobal();

    const parsed = writtenToml();
    expect(parsed.features.codex_hooks).toBeUndefined();
    expect(parsed.features.hooks).toBe(true);
    expect(parsed.features.other).toBe(true);
  });

  it("enables canonical hooks when hooks were disabled", async () => {
    existsFor(PATHS.codexConfig);
    readFileReturns({ [PATHS.codexConfig]: "[features]\nhooks = false\n" });

    await codex.installGlobal();

    expect(writtenToml().features.hooks).toBe(true);
  });

  it("preserves foreign config keys and custom MCP env vars", async () => {
    existsFor(PATHS.codexConfig);
    readFileReturns({
      [PATHS.codexConfig]:
        'model = "gpt-5.5"\n[mcp_servers.midbrain-memory.env]\nCUSTOM_VAR = "keep-me"\nMIDBRAIN_PROJECT_DIR = "/old"\n',
    });

    await codex.installGlobal();

    const parsed = writtenToml();
    const entry = parsed.mcp_servers["midbrain-memory"];
    expect(parsed.model).toBe("gpt-5.5");
    expect(entry.env.CUSTOM_VAR).toBe("keep-me");
    expect(entry.env.MIDBRAIN_CLIENT).toBe("codex");
    expect(entry.env.MIDBRAIN_PROJECT_DIR).toBeUndefined();
  });

  it("preserves pinned midbrain-memory-mcp versions", async () => {
    existsFor(PATHS.codexConfig);
    readFileReturns({
      [PATHS.codexConfig]:
        '[mcp_servers.midbrain-memory]\ncommand = "npx"\nargs = ["-y", "midbrain-memory-mcp@1.2.3"]\n',
    });

    const lines = await codex.installGlobal();

    const entry = writtenToml().mcp_servers["midbrain-memory"];
    expect(entry.args).toEqual(["-y", "midbrain-memory-mcp@1.2.3"]);
    expect(lines.some((line) => line.includes("pinned version preserved"))).toBe(true);
  });

  it("migrates unpinned npx entries to @latest", async () => {
    existsFor(PATHS.codexConfig);
    readFileReturns({
      [PATHS.codexConfig]:
        '[mcp_servers.midbrain-memory]\ncommand = "npx"\nargs = ["-y", "midbrain-memory-mcp"]\n',
    });

    await codex.installGlobal();

    expect(writtenToml().mcp_servers["midbrain-memory"].args)
      .toEqual(["-y", "midbrain-memory-mcp@latest"]);
  });

  it("migrates stale absolute server.js entries to current shape", async () => {
    existsFor(PATHS.codexConfig);
    readFileReturns({
      [PATHS.codexConfig]:
        '[mcp_servers.midbrain-memory]\ncommand = "node"\nargs = ["/old/server.js"]\n',
    });

    await codex.installGlobal();

    const entry = writtenToml().mcp_servers["midbrain-memory"];
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "midbrain-memory-mcp@latest"]);
  });

  it("preserves foreign hooks and replaces duplicate MidBrain hooks", async () => {
    const hooksPath = path.join(PATHS.codexDir, "hooks.json");
    existsFor(hooksPath);
    readFileReturns({
      [hooksPath]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "/bin/echo foreign" }] },
            { hooks: [{ type: "command", command: "old capture-user.mjs" }] },
          ],
        },
      }),
    });

    await codex.installGlobal();

    const groups = writtenHooks().hooks.UserPromptSubmit;
    const commands = groups.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain("/bin/echo foreign");
    expect(commands.filter((cmd) => cmd.includes("capture-user.mjs"))).toHaveLength(1);
  });

  it("backs up existing TOML and hooks files before writing", async () => {
    const hooksPath = path.join(PATHS.codexDir, "hooks.json");
    existsFor(PATHS.codexConfig, hooksPath);
    readFileReturns({ [PATHS.codexConfig]: "", [hooksPath]: '{"hooks":{}}' });

    await codex.installGlobal();

    expect(fs.copyFile).toHaveBeenCalledWith(PATHS.codexConfig, PATHS.codexConfig + ".bak");
    expect(fs.copyFile).toHaveBeenCalledWith(hooksPath, hooksPath + ".bak");
  });

  it("fails closed on corrupt TOML without overwriting config.toml", async () => {
    existsFor(PATHS.codexConfig);
    readFileReturns({ [PATHS.codexConfig]: "bad toml = = =" });

    await expect(codex.installGlobal()).rejects.toThrow(/Failed to parse/);

    const configWrites = fs.writeFile.mock.calls.filter(([p]) => p === PATHS.codexConfig);
    expect(configWrites).toHaveLength(0);
  });
});

describe("Codex.installProject", () => {
  const codex = new Codex();
  const PROJECT_DIR = "/home/testuser/codex-project";
  const projectToml = path.join(PROJECT_DIR, ".codex", "config.toml");
  const projectHooks = path.join(PROJECT_DIR, ".codex", "hooks.json");
  beforeEach(resetMocks);

  function writtenProjectToml() {
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === projectToml);
    expect(writeCall).toBeDefined();
    return TOML.parse(writeCall[1]);
  }

  it("writes project .codex/config.toml with MIDBRAIN_PROJECT_DIR", async () => {
    const lines = await codex.installProject(PROJECT_DIR);

    const entry = writtenProjectToml().mcp_servers["midbrain-memory"];
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "midbrain-memory-mcp@latest"]);
    expect(entry.env.MIDBRAIN_CLIENT).toBe("codex");
    expect(entry.env.MIDBRAIN_PROJECT_DIR).toBe(PROJECT_DIR);
    expect(lines.some((line) => line.includes("project trust"))).toBe(true);
  });

  it("--dev writes process.execPath and absolute index.js", async () => {
    await codex.installProject(PROJECT_DIR, { isDev: true });

    const entry = writtenProjectToml().mcp_servers["midbrain-memory"];
    expect(entry.command).toBe(process.execPath);
    expect(path.isAbsolute(entry.args[0])).toBe(true);
    expect(entry.args[0]).toContain("index.js");
  });

  it("does not write project-local hooks.json", async () => {
    await codex.installProject(PROJECT_DIR);

    const hookWrites = fs.writeFile.mock.calls.filter(([p]) => p === projectHooks);
    expect(hookWrites).toHaveLength(0);
  });

  it("preserves foreign project TOML keys", async () => {
    existsFor(projectToml);
    readFileReturns({ [projectToml]: 'approval_policy = "on-request"\n' });

    await codex.installProject(PROJECT_DIR);

    expect(writtenProjectToml().approval_policy).toBe("on-request");
  });

  it("fails closed on corrupt project TOML", async () => {
    existsFor(projectToml);
    readFileReturns({ [projectToml]: "bad toml = = =" });

    await expect(codex.installProject(PROJECT_DIR)).rejects.toThrow(/Failed to parse/);

    const configWrites = fs.writeFile.mock.calls.filter(([p]) => p === projectToml);
    expect(configWrites).toHaveLength(0);
  });
});
