/**
 * Unit tests for shared/clients/codex.mjs
 *
 * All filesystem operations are mocked — no real files read or written.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";

import { makeResetMocks, makeExistsFor, makeReadFileReturns, makeStatFor } from "./fs-mock.mjs";

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
const statFor = makeStatFor(mocks);

const { BaseClient } = await import("../shared/clients/base.mjs");
const { Codex } = await import("../shared/clients/codex.mjs");
const { buildShimBody } = await import("../shared/clients/shim.mjs");
const TOML = await import("smol-toml");

const HOME = os.homedir();
const IS_WIN = process.platform === "win32";

const PATHS = {
  codexDir:    path.join(HOME, ".codex"),
  codexConfig: path.join(HOME, ".codex", "config.toml"),
  codexHooks:  path.join(HOME, ".codex", "hooks.json"),
  codexShim:   path.join(HOME, ".midbrain", "bin", "codex-hook"),
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
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexHooks);
    expect(writeCall).toBeDefined();
    return JSON.parse(writeCall[1]);
  }

  function hookCommands() {
    const hooks = writtenHooks().hooks;
    return {
      user: hooks.UserPromptSubmit[0].hooks[0].command,
      tool: hooks.PostToolUse[0].hooks[0].command,
      assistant: hooks.Stop[0].hooks[0].command,
    };
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

  it("writes stable shim hooks.json for UserPromptSubmit, PostToolUse, and Stop", async () => {
    await codex.installGlobal();

    const hooks = writtenHooks().hooks;
    for (const event of ["UserPromptSubmit", "PostToolUse", "Stop"]) {
      expect(hooks[event]).toHaveLength(1);
      const hook = hooks[event][0].hooks[0];
      expect(hook.type).toBe("command");
      expect(hook.command).toContain(PATHS.codexShim);
      expect(hook.command).not.toContain(process.execPath);
      expect(hook.command).not.toContain("node_modules");
      expect(hook.command).not.toContain("_npx");
      expect(hook.command).not.toContain("Cellar/node");
      expect(hook.command).not.toContain("plugins/codex/capture-");
      expect(hook).not.toHaveProperty("async");
    }
    expect(hookCommands()).toEqual({
      user: `'${PATHS.codexShim}' user`,
      tool: `'${PATHS.codexShim}' tool`,
      assistant: `'${PATHS.codexShim}' assistant`,
    });
  });

  it("writes the stable Codex hook shim with executable permissions", async () => {
    await codex.installGlobal();

    const shimWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexShim);
    expect(fs.mkdir).toHaveBeenCalledWith(path.dirname(PATHS.codexShim), { recursive: true });
    expect(shimWrite).toBeDefined();
    expect(shimWrite[1]).toContain("npx -y midbrain-memory-mcp@latest hook codex");
    expect(shimWrite[1]).toContain('"$@"');
    expect(shimWrite[1]).not.toContain("MIDBRAIN_API_KEY");
    expect(shimWrite[1]).not.toContain(".midbrain-key");
    // chmod applies exec bits on POSIX only; win32 skips it.
    if (!IS_WIN) expect(fs.chmod).toHaveBeenCalledWith(PATHS.codexShim, 0o755);
  });

  it("keeps hook command stable across Node path changes", async () => {
    await codex.installGlobal();

    for (const command of Object.values(hookCommands())) {
      expect(command).not.toContain(process.execPath);
      expect(command).toContain(PATHS.codexShim);
    }
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
    existsFor(PATHS.codexHooks);
    readFileReturns({
      [PATHS.codexHooks]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "/bin/echo foreign" }] },
            { hooks: [{ type: "command", command: "node /old/plugins/codex/capture-user.mjs" }] },
            { hooks: [{ type: "command", command: `'${PATHS.codexShim}' user` }] },
            { hooks: [{ type: "command", command: "~/.midbrain/bin/codex-hook user" }] },
            { hooks: [{ type: "command", command: "$HOME/.midbrain/bin/codex-hook user" }] },
            { hooks: [{ type: "command", command: "npx -y midbrain-memory-mcp@latest 'hook' 'codex' user" }] },
          ],
        },
      }),
    });

    await codex.installGlobal();

    const groups = writtenHooks().hooks.UserPromptSubmit;
    const commands = groups.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain("/bin/echo foreign");
    expect(commands.filter((cmd) => cmd.includes("capture-user.mjs"))).toHaveLength(0);
    expect(commands.filter((cmd) => cmd.includes(PATHS.codexShim))).toHaveLength(1);
    expect(commands.filter((cmd) => cmd.includes("codex-hook"))).toHaveLength(1);
    expect(commands.filter((cmd) => cmd.includes("hook codex"))).toHaveLength(0);
  });

  it("migrates old direct Codex hook commands to the stable shim", async () => {
    existsFor(PATHS.codexHooks);
    readFileReturns({
      [PATHS.codexHooks]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "'/opt/homebrew/Cellar/node/26.3.0/bin/node' '/old/plugins/codex/capture-user.mjs'" }] }],
          PostToolUse: [{ hooks: [{ type: "command", command: "'/private/tmp/_npx/abc/node_modules/midbrain-memory-mcp/plugins/codex/capture-tool.mjs'" }] }],
          Stop: [{ hooks: [{ type: "command", command: "'/old/node' '/old/plugins/codex/capture-assistant.mjs'" }] }],
        },
      }),
    });

    await codex.installGlobal();

    expect(hookCommands()).toEqual({
      user: `'${PATHS.codexShim}' user`,
      tool: `'${PATHS.codexShim}' tool`,
      assistant: `'${PATHS.codexShim}' assistant`,
    });
  });

  it("backs up existing TOML and hooks files before writing", async () => {
    existsFor(PATHS.codexConfig, PATHS.codexHooks);
    readFileReturns({ [PATHS.codexConfig]: "", [PATHS.codexHooks]: '{"hooks":{}}' });

    await codex.installGlobal();

    expect(fs.copyFile).toHaveBeenCalledWith(PATHS.codexConfig, PATHS.codexConfig + ".bak");
    expect(fs.copyFile).toHaveBeenCalledWith(PATHS.codexHooks, PATHS.codexHooks + ".bak");
  });

  it("fails closed on corrupt TOML without overwriting config.toml", async () => {
    existsFor(PATHS.codexConfig);
    readFileReturns({ [PATHS.codexConfig]: "bad toml = = =" });

    await expect(codex.installGlobal()).rejects.toThrow(/Failed to parse/);

    const configWrites = fs.writeFile.mock.calls.filter(([p]) => p === PATHS.codexConfig);
    expect(configWrites).toHaveLength(0);
  });
});

describe("Codex hook freshness and repair", () => {
  const codex = new Codex();
  beforeEach(resetMocks);

  function readHooksAsWritten() {
    const writeCall = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexHooks);
    expect(writeCall).toBeDefined();
    return JSON.parse(writeCall[1]);
  }

  it("isFresh returns false for legacy direct capture script commands", async () => {
    existsFor(PATHS.codexHooks);
    readFileReturns({
      [PATHS.codexHooks]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ command: `${process.execPath} /tmp/midbrain/plugins/codex/capture-user.mjs` }] }],
          PostToolUse: [{ hooks: [{ command: `${process.execPath} /tmp/midbrain/plugins/codex/capture-tool.mjs` }] }],
          Stop: [{ hooks: [{ command: `${process.execPath} /tmp/midbrain/plugins/codex/capture-assistant.mjs` }] }],
        },
      }),
    });

    await expect(codex.isFresh()).resolves.toBe(false);
  });

  it("isFresh returns true when no MidBrain hooks are installed", async () => {
    existsFor(PATHS.codexHooks);
    readFileReturns({
      [PATHS.codexHooks]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ command: "/bin/echo foreign" }] }],
        },
      }),
    });

    await expect(codex.isFresh()).resolves.toBe(true);
  });

  it("isFresh returns true for stable shim hooks", async () => {
    existsFor(PATHS.codexHooks, PATHS.codexShim);
    readFileReturns({
      [PATHS.codexHooks]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ command: `'${PATHS.codexShim}' user` }] }],
          PostToolUse: [{ hooks: [{ command: `'${PATHS.codexShim}' tool` }] }],
          Stop: [{ hooks: [{ command: `'${PATHS.codexShim}' assistant` }] }],
        },
      }),
      // AC-11: freshness reads the shim body + mode, not mere existence
      [PATHS.codexShim]: buildShimBody("codex"),
    });
    statFor(PATHS.codexShim);

    await expect(codex.isFresh()).resolves.toBe(true);
  });

  it("isFresh returns false when the shim body is stale even though the file exists (B14)", async () => {
    existsFor(PATHS.codexHooks, PATHS.codexShim);
    readFileReturns({
      [PATHS.codexHooks]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ command: `'${PATHS.codexShim}' user` }] }],
          PostToolUse: [{ hooks: [{ command: `'${PATHS.codexShim}' tool` }] }],
          Stop: [{ hooks: [{ command: `'${PATHS.codexShim}' assistant` }] }],
        },
      }),
      [PATHS.codexShim]: `#!/bin/sh\n'/private/tmp/gone/index.js' hook codex "$@"\n`,
    });
    statFor(PATHS.codexShim);

    await expect(codex.isFresh()).resolves.toBe(false);
  });

  it("repairHooks rewrites legacy commands to the stable shim and installs the shim", async () => {
    existsFor(PATHS.codexHooks);
    readFileReturns({
      [PATHS.codexHooks]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ command: "node /old/plugins/codex/capture-user.mjs" }] }],
          PostToolUse: [{ hooks: [{ command: "node /old/plugins/codex/capture-tool.mjs" }] }],
          Stop: [{ hooks: [{ command: "node /old/plugins/codex/capture-assistant.mjs" }] }],
        },
      }),
    });

    const lines = await codex.repairHooks();

    const hooks = readHooksAsWritten().hooks;
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe(`'${PATHS.codexShim}' user`);
    expect(hooks.PostToolUse[0].hooks[0].command).toBe(`'${PATHS.codexShim}' tool`);
    expect(hooks.Stop[0].hooks[0].command).toBe(`'${PATHS.codexShim}' assistant`);
    if (!IS_WIN) expect(fs.chmod).toHaveBeenCalledWith(PATHS.codexShim, 0o755);
    expect(lines.join("\n")).toContain("stable Codex hook shim");
  });

  it("repairHooks is idempotent across mixed legacy, shim, package, and foreign hooks", async () => {
    existsFor(PATHS.codexHooks);
    const mixedHooks = {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ command: "/bin/echo foreign" }] },
          { hooks: [{ command: "node /old/plugins/codex/capture-user.mjs" }] },
          { hooks: [{ command: `'${PATHS.codexShim}' user` }] },
          { hooks: [{ command: "~/.midbrain/bin/codex-hook user" }] },
          { hooks: [{ command: "npx -y midbrain-memory-mcp@latest 'hook' 'codex' user" }] },
        ],
        PostToolUse: [
          { hooks: [{ command: "node /old/plugins/codex/capture-tool.mjs" }] },
          { hooks: [{ command: "$HOME/.midbrain/bin/codex-hook tool" }] },
        ],
        Stop: [
          { hooks: [{ command: "node /old/plugins/codex/capture-assistant.mjs" }] },
          { hooks: [{ command: `${process.execPath} /repo/midbrain-memory-mcp/index.js hook codex assistant` }] },
        ],
      },
    };
    readFileReturns({ [PATHS.codexHooks]: JSON.stringify(mixedHooks) });

    await codex.repairHooks();
    const once = readHooksAsWritten();
    fs.writeFile.mockClear();
    readFileReturns({ [PATHS.codexHooks]: JSON.stringify(once) });

    await codex.repairHooks();

    const hooks = readHooksAsWritten().hooks;
    expect(hooks.UserPromptSubmit).toHaveLength(2);
    expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe("/bin/echo foreign");
    expect(hooks.UserPromptSubmit[1].hooks[0].command).toBe(`'${PATHS.codexShim}' user`);
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.PostToolUse[0].hooks[0].command).toBe(`'${PATHS.codexShim}' tool`);
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.Stop[0].hooks[0].command).toBe(`'${PATHS.codexShim}' assistant`);
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
