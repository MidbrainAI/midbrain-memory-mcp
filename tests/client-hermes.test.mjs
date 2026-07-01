/**
 * Unit tests for shared/clients/hermes.mjs
 *
 * All filesystem operations are mocked — no real files read or written.
 * The real `yaml` parser is used (mirrors client-codex.test.mjs using real TOML).
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

const resetMocks = makeResetMocks(mocks);
const existsFor = makeExistsFor(mocks);
const readFileReturns = makeReadFileReturns(mocks);

const { BaseClient } = await import("../shared/clients/base.mjs");
const { Hermes } = await import("../shared/clients/hermes.mjs");
const YAML = await import("yaml");

const HOME = os.homedir();

const PATHS = {
  hermesHome:   path.join(HOME, ".hermes"),
  hermesConfig: path.join(HOME, ".hermes", "config.yaml"),
  hermesShim:   path.join(HOME, ".midbrain", "bin", "hermes-hook"),
  hermesKey:    path.join(HOME, ".config", "hermes", ".midbrain-key"),
};

/** Return the parsed YAML object written to config.yaml (last write). */
function lastConfigWrite() {
  const calls = mocks.writeFile.mock.calls.filter((c) => c[0] === PATHS.hermesConfig);
  if (calls.length === 0) return null;
  return YAML.parse(calls[calls.length - 1][1]);
}

/** Return the raw YAML string written to config.yaml (last write). */
function lastConfigRaw() {
  const calls = mocks.writeFile.mock.calls.filter((c) => c[0] === PATHS.hermesConfig);
  return calls.length ? calls[calls.length - 1][1] : "";
}

const HERMES_HOOK_RE = /hermes-hook' hermes user$/;

describe("Hermes adapter identity", () => {
  const hermes = new Hermes();

  it("extends BaseClient", () => {
    expect(hermes).toBeInstanceOf(BaseClient);
  });

  it("has stable id and display name", () => {
    expect(hermes.id).toBe("hermes");
    expect(hermes.displayName).toBe("Hermes Agent");
  });
});

describe("Hermes.isInstalled", () => {
  const hermes = new Hermes();
  beforeEach(resetMocks);

  it("true when config.yaml exists", () => {
    existsFor(PATHS.hermesConfig);
    expect(hermes.isInstalled()).toBe(true);
  });

  it("true when ~/.hermes dir exists", () => {
    existsFor(PATHS.hermesHome);
    expect(hermes.isInstalled()).toBe(true);
  });

  it("false when nothing exists", () => {
    expect(hermes.isInstalled()).toBe(false);
  });
});

describe("Hermes.resolveClientKey", () => {
  const hermes = new Hermes();
  beforeEach(resetMocks);

  it("reads the per-client key file", async () => {
    readFileReturns({ [PATHS.hermesKey]: "sk-hermes-123\n" });
    const result = await hermes.resolveClientKey();
    expect(result).toEqual({ key: "sk-hermes-123", source: PATHS.hermesKey });
  });

  it("returns null when key file missing", async () => {
    expect(await hermes.resolveClientKey()).toBeNull();
  });
});

describe("Hermes.writeKey", () => {
  const hermes = new Hermes();
  beforeEach(resetMocks);

  it("writes the key with chmod 600", async () => {
    const msg = await hermes.writeKey("sk-abc");
    expect(mocks.writeFile).toHaveBeenCalledWith(PATHS.hermesKey, "sk-abc\n", "utf8");
    expect(mocks.chmod).toHaveBeenCalledWith(PATHS.hermesKey, 0o600);
    expect(msg).toContain(".config/hermes/.midbrain-key");
  });
});

describe("Hermes.installGlobal", () => {
  const hermes = new Hermes();
  beforeEach(resetMocks);

  it("adds mcp_servers.midbrain-memory with hermes client env", async () => {
    await hermes.installGlobal();
    const cfg = lastConfigWrite();
    expect(cfg.mcp_servers["midbrain-memory"]).toEqual({
      command: "npx",
      args: ["-y", "midbrain-memory-mcp@latest"],
      env: { MIDBRAIN_CLIENT: "hermes" },
    });
  });

  it("writes both capture hooks pointing at the stable shim", async () => {
    await hermes.installGlobal();
    const cfg = lastConfigWrite();
    expect(cfg.hooks.pre_llm_call[0].command).toContain("hermes-hook' hermes user");
    expect(cfg.hooks.pre_llm_call[0].timeout).toBe(10);
    expect(cfg.hooks.post_llm_call[0].command).toContain("hermes-hook' hermes assistant");
  });

  it("installs the stable hook shim executable", async () => {
    await hermes.installGlobal();
    expect(mocks.writeFile).toHaveBeenCalledWith(
      PATHS.hermesShim,
      expect.stringContaining("hook hermes"),
      "utf8",
    );
    expect(mocks.chmod).toHaveBeenCalledWith(PATHS.hermesShim, 0o755);
  });

  it("backs up an existing config before writing", async () => {
    existsFor(PATHS.hermesConfig);
    readFileReturns({ [PATHS.hermesConfig]: "model:\n  default: x\n" });
    await hermes.installGlobal();
    expect(mocks.copyFile).toHaveBeenCalledWith(PATHS.hermesConfig, PATHS.hermesConfig + ".bak");
  });

  it("preserves unrelated config keys and user hooks", async () => {
    readFileReturns({
      [PATHS.hermesConfig]:
        "model:\n  default: claude-x\nhooks:\n  pre_tool_call:\n    - command: my-guard.sh\n",
    });
    await hermes.installGlobal();
    const cfg = lastConfigWrite();
    expect(cfg.model.default).toBe("claude-x");
    expect(cfg.hooks.pre_tool_call[0].command).toBe("my-guard.sh");
    expect(cfg.hooks.pre_llm_call).toHaveLength(1);
  });

  it("preserves YAML comments on untouched nodes", async () => {
    readFileReturns({
      [PATHS.hermesConfig]: "# top comment\nmodel:\n  default: x # inline\n",
    });
    await hermes.installGlobal();
    const raw = lastConfigRaw();
    expect(raw).toContain("# top comment");
    expect(raw).toContain("# inline");
  });

  it("preserves a pinned MCP version (no overwrite)", async () => {
    readFileReturns({
      [PATHS.hermesConfig]:
        "mcp_servers:\n  midbrain-memory:\n    command: npx\n    args:\n      - -y\n      - midbrain-memory-mcp@0.3.1\n",
    });
    const summary = await hermes.installGlobal();
    const cfg = lastConfigWrite();
    expect(cfg.mcp_servers["midbrain-memory"].args).toContain("midbrain-memory-mcp@0.3.1");
    expect(summary.join("\n")).toContain("pinned version preserved");
  });

  it("preserves custom env keys on the MCP entry", async () => {
    readFileReturns({
      [PATHS.hermesConfig]:
        "mcp_servers:\n  midbrain-memory:\n    command: npx\n    args:\n      - -y\n      - midbrain-memory-mcp@latest\n    env:\n      HTTP_PROXY: http://proxy:8080\n      MIDBRAIN_CLIENT: hermes\n",
    });
    await hermes.installGlobal();
    const cfg = lastConfigWrite();
    expect(cfg.mcp_servers["midbrain-memory"].env.HTTP_PROXY).toBe("http://proxy:8080");
    expect(cfg.mcp_servers["midbrain-memory"].env.MIDBRAIN_CLIENT).toBe("hermes");
  });

  it("is idempotent — a second install does not duplicate hooks", async () => {
    await hermes.installGlobal();
    const firstRaw = lastConfigRaw();
    readFileReturns({ [PATHS.hermesConfig]: firstRaw });
    await hermes.installGlobal();
    const cfg = lastConfigWrite();
    expect(cfg.hooks.pre_llm_call).toHaveLength(1);
    expect(cfg.hooks.post_llm_call).toHaveLength(1);
  });

  it("fails closed on corrupt YAML (no write)", async () => {
    readFileReturns({ [PATHS.hermesConfig]: "model:\n  default: [unclosed\n" });
    await expect(hermes.installGlobal()).rejects.toThrow(/Failed to parse/);
    const wroteConfig = mocks.writeFile.mock.calls.some((c) => c[0] === PATHS.hermesConfig);
    expect(wroteConfig).toBe(false);
  });

  it("uses a dev entry when isDev is set", async () => {
    await hermes.installGlobal({ isDev: true });
    const cfg = lastConfigWrite();
    expect(cfg.mcp_servers["midbrain-memory"].command).toBe(process.execPath);
    expect(cfg.mcp_servers["midbrain-memory"].args[0]).toContain("index.js");
  });
});

describe("Hermes.installProject", () => {
  const hermes = new Hermes();
  beforeEach(resetMocks);

  const projectDir = path.join(HOME, "work", "acme");
  const projectConfig = path.join(projectDir, ".hermes", "config.yaml");

  it("writes a project MCP entry with MIDBRAIN_PROJECT_DIR", async () => {
    await hermes.installProject(projectDir);
    const call = mocks.writeFile.mock.calls.find((c) => c[0] === projectConfig);
    expect(call).toBeDefined();
    const cfg = YAML.parse(call[1]);
    expect(cfg.mcp_servers["midbrain-memory"].env.MIDBRAIN_PROJECT_DIR).toBe(projectDir);
    expect(cfg.mcp_servers["midbrain-memory"].env.MIDBRAIN_CLIENT).toBe("hermes");
  });

  it("does not write capture hooks into project config", async () => {
    await hermes.installProject(projectDir);
    const call = mocks.writeFile.mock.calls.find((c) => c[0] === projectConfig);
    const cfg = YAML.parse(call[1]);
    expect(cfg.hooks).toBeUndefined();
  });

  it("reports the project config path via projectConfigFiles", () => {
    expect(hermes.projectConfigFiles(projectDir)).toEqual([".hermes/config.yaml"]);
  });
});

describe("Hermes.isFresh / repairHooks", () => {
  const hermes = new Hermes();
  beforeEach(resetMocks);

  it("fresh when no config exists", async () => {
    expect(await hermes.isFresh()).toBe(true);
  });

  it("fresh when hooks reference the current shim and the shim exists", async () => {
    await hermes.installGlobal();
    const raw = lastConfigRaw();
    readFileReturns({ [PATHS.hermesConfig]: raw });
    existsFor(PATHS.hermesShim);
    expect(await hermes.isFresh()).toBe(true);
  });

  it("stale when a legacy capture-user.mjs command is present", async () => {
    readFileReturns({
      [PATHS.hermesConfig]:
        "hooks:\n  pre_llm_call:\n    - command: node /old/plugins/hermes/capture-user.mjs\n",
    });
    expect(await hermes.isFresh()).toBe(false);
  });

  it("repairHooks rewrites hooks and reinstalls the shim", async () => {
    readFileReturns({
      [PATHS.hermesConfig]:
        "hooks:\n  pre_llm_call:\n    - command: node /old/plugins/hermes/capture-user.mjs\n",
    });
    const lines = await hermes.repairHooks();
    const cfg = lastConfigWrite();
    expect(cfg.hooks.pre_llm_call[0].command).toMatch(HERMES_HOOK_RE);
    expect(mocks.chmod).toHaveBeenCalledWith(PATHS.hermesShim, 0o755);
    expect(lines.join("\n")).toContain("repaired");
  });
});
