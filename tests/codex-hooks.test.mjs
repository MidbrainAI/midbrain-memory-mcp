/**
 * Unit tests for codex/common.mjs (PRD-008).
 *
 * Tests the pure-function seam: captureUser and captureAssistant with
 * dependency injection (loadApiKey, storeEpisodic, fetch, debugLog).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  captureUser,
  captureAssistant,
  makeDefaultDeps,
  CODEX_CONFIG_DIR,
  DEBUG_LOG,
} from "../codex/common.mjs";

import { KEY_FILENAME } from "../shared/midbrain-common.mjs";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function writeKey(filePath, content = "test-key-xyz") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content + "\n", "utf8");
  fs.chmodSync(filePath, 0o600);
}

function makeTestDeps(overrides = {}) {
  return {
    loadApiKey: vi.fn(() => ({ key: "fake-key", source: "test" })),
    storeEpisodic: vi.fn(),
    debugLog: vi.fn(),
    fetch: vi.fn(async () => ({ status: 200 })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("codex/common.mjs constants", () => {
  it("CODEX_CONFIG_DIR is ~/.config/codex", () => {
    expect(CODEX_CONFIG_DIR).toBe(path.join(os.homedir(), ".config", "codex"));
  });

  it("DEBUG_LOG is in user home", () => {
    expect(DEBUG_LOG).toBe(path.join(os.homedir(), "midbrain-codex-debug.log"));
  });
});

// ---------------------------------------------------------------------------
// makeDefaultDeps
// ---------------------------------------------------------------------------

describe("makeDefaultDeps", () => {
  it("returns object with loadApiKey, storeEpisodic, fetch, debugLog", () => {
    const deps = makeDefaultDeps();
    expect(typeof deps.loadApiKey).toBe("function");
    expect(typeof deps.storeEpisodic).toBe("function");
    expect(typeof deps.fetch).toBe("function");
    expect(typeof deps.debugLog).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// captureUser
// ---------------------------------------------------------------------------

describe("captureUser", () => {
  it("POSTs once with role=user when prompt is non-empty", async () => {
    const deps = makeTestDeps();
    await captureUser({ prompt: "hi", cwd: "/tmp/p" }, deps);
    expect(deps.storeEpisodic).toHaveBeenCalledTimes(1);
    const args = deps.storeEpisodic.mock.calls[0];
    expect(args[0]).toBe("fake-key");
    expect(args[1]).toBe("hi");
    expect(args[2]).toBe("user");
    expect(typeof args[3]).toBe("function");
    expect(args[4]).toBe("codex");
  });

  it("does NOT POST when prompt is empty string", async () => {
    const deps = makeTestDeps();
    await captureUser({ prompt: "", cwd: "/tmp/p" }, deps);
    expect(deps.storeEpisodic).not.toHaveBeenCalled();
  });

  it("does NOT POST when prompt is whitespace-only", async () => {
    const deps = makeTestDeps();
    await captureUser({ prompt: "   \n\t ", cwd: "/tmp/p" }, deps);
    expect(deps.storeEpisodic).not.toHaveBeenCalled();
  });

  it("does NOT POST when prompt is missing", async () => {
    const deps = makeTestDeps();
    await captureUser({ cwd: "/tmp/p" }, deps);
    expect(deps.storeEpisodic).not.toHaveBeenCalled();
  });

  it("does NOT POST when prompt is non-string", async () => {
    const deps = makeTestDeps();
    await captureUser({ prompt: 42, cwd: "/tmp/p" }, deps);
    expect(deps.storeEpisodic).not.toHaveBeenCalled();
  });

  it("silent failure when loadApiKey throws (debug log written)", async () => {
    const deps = makeTestDeps({
      loadApiKey: vi.fn(() => { throw new Error("no key file"); }),
    });
    await expect(
      captureUser({ prompt: "hi", cwd: "/tmp/p" }, deps),
    ).resolves.toBeUndefined();
    expect(deps.storeEpisodic).not.toHaveBeenCalled();
    expect(deps.debugLog).toHaveBeenCalled();
  });

  it("silent failure when storeEpisodic throws", async () => {
    const deps = makeTestDeps({
      storeEpisodic: vi.fn(() => { throw new Error("boom"); }),
    });
    await expect(
      captureUser({ prompt: "hi", cwd: "/tmp/p" }, deps),
    ).resolves.toBeUndefined();
    expect(deps.debugLog).toHaveBeenCalled();
  });

  it("forwards cwd as projectDir, CODEX_CONFIG_DIR as configDir", async () => {
    const deps = makeTestDeps();
    await captureUser({ prompt: "hi", cwd: "/tmp/abc" }, deps);
    expect(deps.loadApiKey).toHaveBeenCalledWith("/tmp/abc", CODEX_CONFIG_DIR);
  });

  it("passes undefined projectDir when cwd is missing", async () => {
    const deps = makeTestDeps();
    await captureUser({ prompt: "hi" }, deps);
    expect(deps.loadApiKey).toHaveBeenCalledWith(undefined, CODEX_CONFIG_DIR);
  });
});

// ---------------------------------------------------------------------------
// captureAssistant
// ---------------------------------------------------------------------------

describe("captureAssistant", () => {
  it("POSTs once with role=assistant on happy path", async () => {
    const deps = makeTestDeps();
    await captureAssistant(
      { last_assistant_message: "hello back", cwd: "/tmp/p" },
      deps,
    );
    expect(deps.storeEpisodic).toHaveBeenCalledTimes(1);
    const args = deps.storeEpisodic.mock.calls[0];
    expect(args[1]).toBe("hello back");
    expect(args[2]).toBe("assistant");
    expect(args[4]).toBe("codex");
  });

  it("does NOT POST when stop_hook_active is true", async () => {
    const deps = makeTestDeps();
    await captureAssistant(
      { stop_hook_active: true, last_assistant_message: "hi", cwd: "/tmp/p" },
      deps,
    );
    expect(deps.storeEpisodic).not.toHaveBeenCalled();
  });

  it("does NOT POST when last_assistant_message is empty", async () => {
    const deps = makeTestDeps();
    await captureAssistant({ last_assistant_message: "", cwd: "/tmp/p" }, deps);
    expect(deps.storeEpisodic).not.toHaveBeenCalled();
  });

  it("does NOT POST when last_assistant_message is whitespace", async () => {
    const deps = makeTestDeps();
    await captureAssistant(
      { last_assistant_message: "   \n", cwd: "/tmp/p" },
      deps,
    );
    expect(deps.storeEpisodic).not.toHaveBeenCalled();
  });

  it("does NOT POST when last_assistant_message is missing", async () => {
    const deps = makeTestDeps();
    await captureAssistant({ cwd: "/tmp/p" }, deps);
    expect(deps.storeEpisodic).not.toHaveBeenCalled();
  });

  it("silent failure on loadApiKey error (debug log written)", async () => {
    const deps = makeTestDeps({
      loadApiKey: vi.fn(() => { throw new Error("no key"); }),
    });
    await expect(
      captureAssistant(
        { last_assistant_message: "hi", cwd: "/tmp/p" },
        deps,
      ),
    ).resolves.toBeUndefined();
    expect(deps.debugLog).toHaveBeenCalled();
    expect(deps.storeEpisodic).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Project key resolution (real temp dir, real loadApiKey)
// ---------------------------------------------------------------------------

describe("captureAssistant project key resolution", () => {
  let tmpDir;
  const savedEnv = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-codex-test-"));
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves project key when <cwd>/.midbrain/.midbrain-key exists", async () => {
    const projDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projDir);
    writeKey(path.join(projDir, ".midbrain", KEY_FILENAME), "proj-codex-key");

    const { loadApiKey } = await import("../shared/midbrain-common.mjs");
    const storeEpisodic = vi.fn();
    const debugLog = vi.fn();
    await captureAssistant(
      { last_assistant_message: "hello", cwd: projDir },
      { loadApiKey, storeEpisodic, debugLog, fetch: globalThis.fetch },
    );

    expect(storeEpisodic).toHaveBeenCalledTimes(1);
    expect(storeEpisodic.mock.calls[0][0]).toBe("proj-codex-key");
  });
});

// ---------------------------------------------------------------------------
// Wrapper scripts: file-level contract
// ---------------------------------------------------------------------------

describe("Stop wrapper contract", () => {
  it("codex/capture-assistant.mjs writes literal '{}' to stdout", () => {
    const wrapperPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "codex",
      "capture-assistant.mjs",
    );
    const contents = fs.readFileSync(wrapperPath, "utf8");
    expect(contents).toMatch(/process\.stdout\.write\(["']\{\}["']\)/);
  });

  it("codex/capture-user.mjs exists with shebang and captureUser import", () => {
    const wrapperPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "codex",
      "capture-user.mjs",
    );
    const contents = fs.readFileSync(wrapperPath, "utf8");
    expect(contents).toMatch(/^#!/);
    expect(contents).toContain("captureUser");
  });
});
