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

const { detectClients } = await import("../shared/clients/registry.mjs");

const HOME = os.homedir();

const PATHS = {
  opencodeConfig: path.join(HOME, ".config", "opencode", "opencode.json"),
  claudeJson:     path.join(HOME, ".claude.json"),
};

describe("detectClients", () => {
  beforeEach(resetMocks);

  it("detects both when both installed", () => {
    existsFor(PATHS.opencodeConfig, PATHS.claudeJson);
    const clients = detectClients();
    expect(clients).toHaveLength(2);
    expect(clients.map((c) => c.id).sort()).toEqual(["claude", "opencode"]);
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

  it("returns empty when nothing installed", () => {
    expect(detectClients()).toHaveLength(0);
  });
});
