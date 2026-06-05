/**
 * Unit tests for plugins/codex hook runtime.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";

import {
  captureAssistant,
  captureToolUse,
  captureUser,
} from "../plugins/codex/common.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");

function makeDeps() {
  const api = { storeEpisodic: vi.fn() };
  return {
    api,
    createApi: vi.fn(async () => api),
    debugLog: vi.fn(),
    toolBufferDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-hooks-")),
  };
}

function cleanupDeps(deps) {
  try { fs.rmSync(deps.toolBufferDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function firstStore(deps) {
  expect(deps.api.storeEpisodic).toHaveBeenCalled();
  return deps.api.storeEpisodic.mock.calls[0];
}

describe("Codex hook capture", () => {
  let deps;

  beforeEach(() => {
    deps = makeDeps();
  });

  afterEach(() => {
    cleanupDeps(deps);
  });

  it("captureUser stores a non-empty prompt with Codex metadata", async () => {
    await captureUser({ prompt: "remember this", cwd: "/repo" }, deps);

    expect(deps.createApi).toHaveBeenCalledWith("/repo");
    expect(firstStore(deps)).toEqual([
      "remember this",
      "user",
      deps.debugLog,
      { client: "codex" },
    ]);
  });

  it("captureUser skips empty prompts", async () => {
    await captureUser({ prompt: "   ", cwd: "/repo" }, deps);

    expect(deps.createApi).not.toHaveBeenCalled();
    expect(deps.api.storeEpisodic).not.toHaveBeenCalled();
  });

  it("captureAssistant stores the last assistant message", async () => {
    await captureAssistant({ last_assistant_message: "done", cwd: "/repo" }, deps);

    expect(firstStore(deps)).toEqual([
      "done",
      "assistant",
      deps.debugLog,
      { client: "codex" },
    ]);
  });

  it("captureAssistant skips recursive Stop hook turns", async () => {
    await captureAssistant({ last_assistant_message: "again", stop_hook_active: true }, deps);

    expect(deps.api.storeEpisodic).not.toHaveBeenCalled();
  });

  it("captureAssistant stores transcript assistant text and reasoning summaries", async () => {
    const transcript = path.join(deps.toolBufferDir, "history.jsonl");
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "hello" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ text: "checked files" }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t2" } }),
    ].join("\n"));

    await captureAssistant({ transcript_path: transcript, turn_id: "t1" }, deps);

    expect(deps.api.storeEpisodic).toHaveBeenCalledTimes(2);
    expect(deps.api.storeEpisodic.mock.calls[0][0]).toBe("hello");
    expect(deps.api.storeEpisodic.mock.calls[1][0]).toBe("Reasoning summary:\nchecked files");
  });

  it("captureToolUse buffers events and Stop emits one summary per turn", async () => {
    await captureToolUse({
      session_id: "s1",
      turn_id: "t1",
      tool_name: "Bash",
      tool_use_id: "u1",
      tool_input: { cmd: "npm test" },
      tool_response: { exit_code: 0 },
    }, deps);
    await captureToolUse({
      session_id: "s1",
      turn_id: "t1",
      tool_name: "apply_patch",
      tool_use_id: "u2",
      tool_input: { path: "file.js" },
      tool_response: { exit_code: 1, stderr: "patch failed" },
    }, deps);

    await captureAssistant({ session_id: "s1", turn_id: "t1" }, deps);
    await captureAssistant({ session_id: "s1", turn_id: "t1" }, deps);

    expect(deps.api.storeEpisodic).toHaveBeenCalledTimes(1);
    const [summary, role, , metadata] = firstStore(deps);
    expect(role).toBe("assistant");
    expect(metadata).toEqual({ client: "codex" });
    expect(summary).toContain("Tool activity summary");
    expect(summary).toContain("Bash x1");
    expect(summary).toContain("apply_patch x1");
    expect(summary).toContain("patch failed");
  });

  it("tool summaries redact secrets and truncate large payloads", async () => {
    await captureToolUse({
      session_id: "s2",
      turn_id: "t2",
      tool_name: "web_fetch",
      tool_use_id: "secret",
      tool_input: { api_key: "sk-1234567890abcdef", query: "Bearer abcdef1234567890" },
      tool_response: { exit_code: 1, stderr: "x".repeat(6000) },
    }, deps);

    await captureAssistant({ session_id: "s2", turn_id: "t2" }, deps);

    const [summary] = firstStore(deps);
    expect(summary).toContain("[redacted]");
    expect(summary).not.toContain("sk-1234567890abcdef");
    expect(summary).not.toContain("Bearer abcdef1234567890");
    expect(summary.length).toBeLessThanOrEqual(4100);
  });

  it("capture failures are fail-open", async () => {
    deps.createApi.mockRejectedValueOnce(new Error("no key"));

    await expect(captureUser({ prompt: "hi", cwd: "/repo" }, deps)).resolves.toBeUndefined();

    expect(deps.debugLog).toHaveBeenCalledWith(expect.stringContaining("CODEX CAPTURE ERROR"));
  });
});

describe("Codex hook wrappers", () => {
  it("Stop wrapper exits zero and writes JSON stdout", () => {
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "plugins", "codex", "capture-assistant.mjs")], {
      input: JSON.stringify({ last_assistant_message: "hi" }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("{}");
  });

  it("PostToolUse wrapper exits zero and writes JSON stdout", () => {
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "plugins", "codex", "capture-tool.mjs")], {
      input: JSON.stringify({ tool_name: "Bash" }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("{}");
  });
});
