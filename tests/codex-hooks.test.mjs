/**
 * Unit tests for codex/common.mjs (PRD-008).
 *
 * Tests the pure-function seam: captureUser, captureAssistant, and captureToolUse with
 * dependency injection (loadApiKey, storeEpisodic, fetch, debugLog).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  captureUser,
  captureAssistant,
  captureToolUse,
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

function writeJsonl(filePath, items) {
  fs.writeFileSync(
    filePath,
    items.map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8",
  );
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

  it("awaits storeEpisodic before resolving", async () => {
    let releaseStore;
    let resolved = false;
    const deps = makeTestDeps({
      storeEpisodic: vi.fn(() => new Promise((resolve) => {
        releaseStore = resolve;
      })),
    });

    const capture = captureUser({ prompt: "hi", cwd: "/tmp/p" }, deps)
      .then(() => { resolved = true; });
    await Promise.resolve();

    expect(deps.storeEpisodic).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);

    releaseStore();
    await capture;
    expect(resolved).toBe(true);
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

  it("stores all assistant messages and reasoning summaries for the active Codex turn", async () => {
    const deps = makeTestDeps();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-codex-transcript-"));
    const transcriptPath = path.join(tmpDir, "session.jsonl");
    writeJsonl(transcriptPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "working update" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ text: "checked the hook schema" }],
          encrypted_content: "opaque",
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "final answer" }],
        },
      },
    ]);

    try {
      await captureAssistant(
        {
          transcript_path: transcriptPath,
          turn_id: "turn-1",
          last_assistant_message: "final answer",
          cwd: "/tmp/p",
        },
        deps,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    expect(deps.storeEpisodic).toHaveBeenCalledTimes(3);
    expect(deps.storeEpisodic.mock.calls.map((call) => call[1])).toEqual([
      "working update",
      "Reasoning summary:\nchecked the hook schema",
      "final answer",
    ]);
    expect(deps.storeEpisodic.mock.calls.every((call) => call[2] === "assistant")).toBe(true);
  });

  it("falls back to last_assistant_message when transcript cannot be read", async () => {
    const deps = makeTestDeps();
    await captureAssistant(
      {
        transcript_path: "/no/such/transcript.jsonl",
        turn_id: "turn-1",
        last_assistant_message: "fallback final",
        cwd: "/tmp/p",
      },
      deps,
    );

    expect(deps.storeEpisodic).toHaveBeenCalledTimes(1);
    expect(deps.storeEpisodic.mock.calls[0][1]).toBe("fallback final");
    expect(deps.debugLog).toHaveBeenCalled();
  });

  it("does not store encrypted reasoning without a plaintext summary", async () => {
    const deps = makeTestDeps();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-codex-transcript-"));
    const transcriptPath = path.join(tmpDir, "session.jsonl");
    writeJsonl(transcriptPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [],
          encrypted_content: "opaque",
        },
      },
    ]);

    try {
      await captureAssistant(
        { transcript_path: transcriptPath, turn_id: "turn-1", cwd: "/tmp/p" },
        deps,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    expect(deps.storeEpisodic).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// captureToolUse
// ---------------------------------------------------------------------------

describe("captureToolUse", () => {
  it("stores a completed PostToolUse event as assistant memory", async () => {
    const deps = makeTestDeps();

    await captureToolUse(
      {
        tool_name: "shell",
        tool_use_id: "call-123",
        tool_input: { cmd: "npm test" },
        tool_response: { exit_code: 0, output: "pass" },
        cwd: "/tmp/p",
      },
      deps,
    );

    expect(deps.storeEpisodic).toHaveBeenCalledTimes(1);
    const [, text, role, , source] = deps.storeEpisodic.mock.calls[0];
    expect(role).toBe("assistant");
    expect(source).toBe("codex");
    expect(text).toContain("Tool call completed");
    expect(text).toContain("Name: shell");
    expect(text).toContain("ID: call-123");
    expect(text).toContain('"cmd": "npm test"');
    expect(text).toContain('"output": "pass"');
  });

  it("does not store when tool_name is missing", async () => {
    const deps = makeTestDeps();

    await captureToolUse({ tool_input: { cmd: "npm test" }, cwd: "/tmp/p" }, deps);

    expect(deps.storeEpisodic).not.toHaveBeenCalled();
  });

  it("truncates oversized tool payloads", async () => {
    const deps = makeTestDeps();

    await captureToolUse(
      {
        tool_name: "shell",
        tool_use_id: "call-big",
        tool_input: { cmd: "yes" },
        tool_response: { output: "x".repeat(20_000) },
        cwd: "/tmp/p",
      },
      deps,
    );

    const text = deps.storeEpisodic.mock.calls[0][1];
    expect(text.length).toBeLessThan(13_000);
    expect(text).toContain("[truncated");
  });

  it("redacts obvious secrets from tool input and response", async () => {
    const deps = makeTestDeps();

    await captureToolUse(
      {
        tool_name: "shell",
        tool_use_id: "call-secret",
        tool_input: {
          api_key: "sk-testsecret123456",
          nested: { Authorization: "Bearer abcdefghijklmnop" },
        },
        tool_response: {
          output: "logged token sk-anothersecret123456 and continued",
          safe: "visible",
        },
        cwd: "/tmp/p",
      },
      deps,
    );

    const text = deps.storeEpisodic.mock.calls[0][1];
    expect(text).toContain('"api_key": "[redacted]"');
    expect(text).toContain('"Authorization": "[redacted]"');
    expect(text).toContain("logged token [redacted] and continued");
    expect(text).toContain('"safe": "visible"');
    expect(text).not.toContain("sk-testsecret123456");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("sk-anothersecret123456");
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

  it("codex/capture-tool.mjs writes literal '{}' to stdout", () => {
    const wrapperPath = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "codex",
      "capture-tool.mjs",
    );
    const contents = fs.readFileSync(wrapperPath, "utf8");
    expect(contents).toMatch(/^#!/);
    expect(contents).toContain("captureToolUse");
    expect(contents).toMatch(/process\.stdout\.write\(["']\{\}["']\)/);
  });
});
