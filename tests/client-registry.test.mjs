/**
 * Unit tests for shared/clients/registry.mjs
 *
 * All filesystem operations are mocked — no real files read or written.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";

import { makeResetMocks, makeExistsFor } from "./fs-mock.mjs";

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

const { allClients, detectClients, getClient } = await import("../shared/clients/registry.mjs");

const HOME = os.homedir();

const PATHS = {
  opencodeConfig: path.join(HOME, ".config", "opencode", "opencode.json"),
  claudeJson:     path.join(HOME, ".claude.json"),
  codexConfig:    path.join(HOME, ".codex", "config.toml"),
  codexDir:       path.join(HOME, ".codex"),
  nanoclawDocker: path.join(HOME, "nanoclaw-v2", "container", "Dockerfile"),
  nanoclawSkills: path.join(HOME, "nanoclaw-v2", ".claude", "skills"),
};

describe("detectClients", () => {
  beforeEach(resetMocks);

  it("detects both when both installed", () => {
    existsFor(PATHS.opencodeConfig, PATHS.claudeJson);
    const clients = detectClients();
    expect(clients).toHaveLength(2);
    expect(clients.map((c) => c.id).sort()).toEqual(["claude", "opencode"]);
  });

  it("registers Codex in allClients", () => {
    expect(allClients().map((c) => c.id)).toEqual(["opencode", "claude", "codex", "nanoclaw", "hermes", "cursor", "openclaw"]);
  });

  it("returns Codex by id", () => {
    expect(getClient("codex").id).toBe("codex");
  });

  it("returns NanoClaw by id", () => {
    expect(getClient("nanoclaw").id).toBe("nanoclaw");
  });

  it("returns Hermes by id", () => {
    expect(getClient("hermes").id).toBe("hermes");
  });

  it("returns Cursor by id", () => {
    expect(getClient("cursor").id).toBe("cursor");
  });

  it("infers Cursor from a legacy MIDBRAIN_CONFIG_DIR", () => {
    const saved = process.env.MIDBRAIN_CONFIG_DIR;
    process.env.MIDBRAIN_CONFIG_DIR = path.join(HOME, ".config", "cursor");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(getClient().id).toBe("cursor");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('inferred "cursor"'));
    } finally {
      warn.mockRestore();
      if (saved === undefined) delete process.env.MIDBRAIN_CONFIG_DIR;
      else process.env.MIDBRAIN_CONFIG_DIR = saved;
    }
  });

  it("detects only Cursor when only ~/.cursor exists", () => {
    existsFor(path.join(HOME, ".cursor"));
    const clients = detectClients();
    expect(clients).toHaveLength(1);
    expect(clients[0].id).toBe("cursor");
  });

  it("detects only OpenCode when only OpenCode installed", () => {
    existsFor(PATHS.opencodeConfig);
    const clients = detectClients();
    expect(clients).toHaveLength(1);
    expect(clients[0].id).toBe("opencode");
  });

  it("detects only Claude when only Claude installed", () => {
    existsFor(PATHS.claudeJson);
    const clients = detectClients();
    expect(clients).toHaveLength(1);
    expect(clients[0].id).toBe("claude");
  });

  it("detects only Codex when only Codex config exists", () => {
    existsFor(PATHS.codexConfig);
    const clients = detectClients();
    expect(clients).toHaveLength(1);
    expect(clients[0].id).toBe("codex");
  });

  it("detects only Codex when only ~/.codex exists", () => {
    existsFor(PATHS.codexDir);
    const clients = detectClients();
    expect(clients).toHaveLength(1);
    expect(clients[0].id).toBe("codex");
  });

  it("detects only NanoClaw when only NanoClaw markers exist", () => {
    existsFor(PATHS.nanoclawDocker, PATHS.nanoclawSkills);
    const clients = detectClients();
    expect(clients).toHaveLength(1);
    expect(clients[0].id).toBe("nanoclaw");
  });

  it("detects only Hermes when only ~/.hermes exists", () => {
    // hermesHome() resolves to %LOCALAPPDATA%/hermes on win32 by default; pin
    // HERMES_HOME so the adapter checks ~/.hermes on every platform.
    const savedHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = path.join(HOME, ".hermes");
    try {
      existsFor(path.join(HOME, ".hermes"));
      const clients = detectClients();
      expect(clients).toHaveLength(1);
      expect(clients[0].id).toBe("hermes");
    } finally {
      if (savedHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = savedHermesHome;
    }
  });

  it("returns empty when nothing installed", () => {
    expect(detectClients()).toHaveLength(0);
  });
});
