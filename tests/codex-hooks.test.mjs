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
import { formatPkContext } from "../shared/pk-inject.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const PK_ENV = "MIDBRAIN_ENABLE_PK_INJECTION";

function makeDeps() {
  const api = {
    storeEpisodic: vi.fn(),
    searchProcedural: vi.fn().mockResolvedValue([]),
  };
  return {
    api,
    createApi: vi.fn(async () => api),
    debugLog: vi.fn(),
    assistantBufferDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-assistant-")),
    toolBufferDir: fs.mkdtempSync(path.join(os.tmpdir(), "codex-hooks-")),
  };
}

function cleanupDeps(deps) {
  try { fs.rmSync(deps.toolBufferDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(deps.assistantBufferDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function firstStore(deps) {
  expect(deps.api.storeEpisodic).toHaveBeenCalled();
  return deps.api.storeEpisodic.mock.calls[0];
}

describe("Codex hook capture", () => {
  let deps;
  let originalPkEnv;

  beforeEach(() => {
    originalPkEnv = process.env[PK_ENV];
    delete process.env[PK_ENV];
    deps = makeDeps();
  });

  afterEach(() => {
    cleanupDeps(deps);
    if (originalPkEnv === undefined) delete process.env[PK_ENV];
    else process.env[PK_ENV] = originalPkEnv;
  });

  it("captureUser stores a non-empty prompt with Codex metadata", async () => {
    await captureUser({ prompt: "remember this", cwd: "/repo" }, deps);

    expect(deps.createApi).toHaveBeenCalledOnce();
    expect(deps.createApi).toHaveBeenCalledWith("/repo");
    expect(firstStore(deps)).toEqual([
      "remember this",
      "user",
      deps.debugLog,
      { client: "codex" },
    ]);
  });

  it("captureUser resolves the API key once and skips PK search by default", async () => {
    deps.api.searchProcedural.mockResolvedValueOnce([
      { id: 1, title: "Git", content: "squash before merge" },
    ]);

    await captureUser({ prompt: "git workflow", cwd: "/repo" }, deps);

    expect(deps.createApi).toHaveBeenCalledOnce();
    expect(deps.api.storeEpisodic).toHaveBeenCalledOnce();
    expect(deps.api.searchProcedural).not.toHaveBeenCalled();
  });

  it("captureUser returns PK context payload when entries are found and PK injection is opted in", async () => {
    process.env[PK_ENV] = "1";
    deps.api.searchProcedural.mockResolvedValueOnce([
      { id: 2, title: "Python", content: "use ruff" },
    ]);

    const result = await captureUser({ prompt: "python linting", cwd: "/repo" }, deps);

    expect(result).toBeDefined();
    expect(result.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(result.hookSpecificOutput.additionalContext).toContain("<!-- mb:ctx-start -->");
    expect(result.hookSpecificOutput.additionalContext).toContain("Python");
    expect(result.hookSpecificOutput.additionalContext).toContain("<!-- mb:pk 2 -->");
  });

  it("captureUser returns undefined when no PK entries match", async () => {
    process.env[PK_ENV] = "1";
    // searchProcedural already returns [] by default from makeDeps
    const result = await captureUser({ prompt: "unrelated query", cwd: "/repo" }, deps);
    expect(result).toBeUndefined();
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

  it("captureAssistant scrubs echoed injected PK blocks before storage", async () => {
    const block = formatPkContext([{ id: 8, title: "Secret Workflow", content: "Do the hidden step" }]);

    await captureAssistant({ last_assistant_message: `${block}\n\nFinal answer`, cwd: "/repo" }, deps);

    const [stored] = firstStore(deps);
    expect(stored).toBe("Final answer");
    expect(stored).not.toContain("Secret Workflow");
    expect(stored).not.toContain("<!-- mb:pk 8 -->");
  });

  it("captureAssistant skips recursive Stop hook turns", async () => {
    await captureAssistant({ last_assistant_message: "again", stop_hook_active: true }, deps);

    expect(deps.api.storeEpisodic).not.toHaveBeenCalled();
  });

  it("captureAssistant stores plain answer and separate reasoning/commentary summary", async () => {
    const transcript = path.join(deps.toolBufferDir, "history.jsonl");
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ text: "checking files" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ text: "checked files" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ text: "done" }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t2" } }),
    ].join("\n"));

    await captureAssistant({ transcript_path: transcript, turn_id: "t1" }, deps);

    expect(deps.api.storeEpisodic).toHaveBeenCalledTimes(2);
    expect(deps.api.storeEpisodic.mock.calls[0]).toEqual([
      "done",
      "assistant",
      deps.debugLog,
      { client: "codex" },
    ]);
    expect(deps.api.storeEpisodic.mock.calls[0][0]).not.toMatch(/final|response|answer/i);
    const [summary, role, , metadata] = deps.api.storeEpisodic.mock.calls[1];
    expect(role).toBe("assistant");
    expect(metadata).toEqual({ client: "codex" });
    expect(summary).toContain("Assistant reasoning/commentary summary");
    expect(summary).toContain("[commentary] checking files");
    expect(summary).toContain("[reasoning] checked files");
  });

  it("buffers interim reasoning/commentary until the final answer arrives", async () => {
    const transcript = path.join(deps.toolBufferDir, "history.jsonl");
    const lines = [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ text: "checking files" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ text: "checked files" }] } }),
    ];
    fs.writeFileSync(transcript, lines.join("\n"));

    await captureAssistant({ transcript_path: transcript, session_id: "s1", turn_id: "t1" }, deps);

    expect(deps.api.storeEpisodic).not.toHaveBeenCalled();

    lines.push(
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ text: "checking files" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ text: "done" }] } }),
    );
    fs.writeFileSync(transcript, lines.join("\n"));

    await captureAssistant({ transcript_path: transcript, session_id: "s1", turn_id: "t1" }, deps);
    await captureAssistant({ transcript_path: transcript, session_id: "s1", turn_id: "t1" }, deps);

    expect(deps.api.storeEpisodic).toHaveBeenCalledTimes(2);
    expect(deps.api.storeEpisodic.mock.calls[0][0]).toBe("done");
    const summary = deps.api.storeEpisodic.mock.calls[1][0];
    expect(summary.match(/\[commentary\] checking files/g)).toHaveLength(1);
    expect(summary).toContain("[reasoning] checked files");
  });

  it("does not mark a final assistant turn stored when storage fails", async () => {
    const transcript = path.join(deps.toolBufferDir, "history.jsonl");
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ text: "done" }] } }),
    ].join("\n"));
    deps.api.storeEpisodic.mockRejectedValueOnce(new Error("network down"));

    await captureAssistant({ transcript_path: transcript, session_id: "s1", turn_id: "t1" }, deps);
    deps.api.storeEpisodic.mockClear();
    await captureAssistant({ transcript_path: transcript, session_id: "s1", turn_id: "t1" }, deps);

    expect(deps.api.storeEpisodic).toHaveBeenCalledTimes(1);
    expect(deps.api.storeEpisodic.mock.calls[0][0]).toBe("done");
  });

  it("does not mark a final assistant turn stored when storage reports false", async () => {
    const transcript = path.join(deps.toolBufferDir, "history.jsonl");
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ text: "done" }] } }),
    ].join("\n"));
    deps.api.storeEpisodic.mockResolvedValueOnce(false);

    await captureAssistant({ transcript_path: transcript, session_id: "s1", turn_id: "t1" }, deps);
    deps.api.storeEpisodic.mockClear();
    await captureAssistant({ transcript_path: transcript, session_id: "s1", turn_id: "t1" }, deps);

    expect(deps.api.storeEpisodic).toHaveBeenCalledTimes(1);
    expect(deps.api.storeEpisodic.mock.calls[0][0]).toBe("done");
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

  it("keeps tool summaries separate from answer and reasoning/commentary entries", async () => {
    const transcript = path.join(deps.toolBufferDir, "history.jsonl");
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ text: "done" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ text: "checked files" }] } }),
    ].join("\n"));
    await captureToolUse({
      session_id: "s1",
      turn_id: "t1",
      tool_name: "Bash",
      tool_input: { cmd: "npm test" },
      tool_response: { exit_code: 0 },
    }, deps);

    await captureAssistant({ transcript_path: transcript, session_id: "s1", turn_id: "t1" }, deps);

    expect(deps.api.storeEpisodic).toHaveBeenCalledTimes(3);
    expect(deps.api.storeEpisodic.mock.calls[0][0]).toBe("done");
    expect(deps.api.storeEpisodic.mock.calls[1][0]).toContain("Assistant reasoning/commentary summary");
    expect(deps.api.storeEpisodic.mock.calls[2][0]).toContain("Tool activity summary");
  });

  it("keeps tool buffers retryable when summary storage fails", async () => {
    await captureToolUse({
      session_id: "s1",
      turn_id: "t1",
      tool_name: "Bash",
      tool_input: { cmd: "npm test" },
      tool_response: { exit_code: 0 },
    }, deps);
    deps.api.storeEpisodic.mockResolvedValueOnce(false);

    await captureAssistant({ session_id: "s1", turn_id: "t1" }, deps);
    deps.api.storeEpisodic.mockClear();
    await captureAssistant({ session_id: "s1", turn_id: "t1" }, deps);

    expect(deps.api.storeEpisodic).toHaveBeenCalledTimes(1);
    expect(deps.api.storeEpisodic.mock.calls[0][0]).toContain("Tool activity summary");
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

    expect(deps.debugLog).toHaveBeenCalledWith(expect.stringContaining("CODEX CAPTURE ERROR (user)"));
  });
});

describe("Codex hook wrappers", () => {
  function tempHomeWithKey() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-user-home-"));
    const keyDir = path.join(home, ".config", "midbrain");
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(path.join(keyDir, ".midbrain-key"), "test-key\n", { mode: 0o600 });
    return home;
  }

  function preload(mode) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-user-preload-"));
    const file = path.join(dir, "fetch-preload.mjs");
    fs.writeFileSync(file, `
      globalThis.fetch = async (url) => {
        const text = String(url);
        if (${JSON.stringify(mode)} === "throw") throw new Error("network down");
        if (text.includes("/memories/episodic")) return { ok: true, status: 201 };
        if (text.includes("/memories/search/procedural")) {
          const body = ${JSON.stringify(mode)} === "match"
            ? [{ id: 55, title: "Codex Workflow", content: "Use spawned stdout" }]
            : [];
          return { ok: true, status: 200, json: async () => body };
        }
        return { ok: false, status: 404, text: async () => "not found" };
      };
    `);
    return { dir, file };
  }

  function runUserHook(input, mode = "empty", extraEnv = {}) {
    const home = tempHomeWithKey();
    const loaded = preload(mode);
    const result = spawnSync(process.execPath, [
      "--import", loaded.file,
      path.join(REPO_ROOT, "plugins", "codex", "capture-user.mjs"),
    ], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, HOME: home, [PK_ENV]: undefined, ...extraEnv },
    });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(loaded.dir, { recursive: true, force: true });
    return result;
  }

  function tempHomeWithNamedKey(key) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-scoped-home-"));
    writeHomeKey(home, key);
    return home;
  }

  function writeHomeKey(home, key) {
    const keyDir = path.join(home, ".config", "midbrain");
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(path.join(keyDir, ".midbrain-key"), `${key}\n`, { mode: 0o600 });
  }

  function preloadWithRequestLog() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-scoped-preload-"));
    const file = path.join(dir, "fetch-preload.mjs");
    fs.writeFileSync(file, `
      import fs from "node:fs";

      globalThis.fetch = async (url, opts = {}) => {
        const headers = opts.headers || {};
        const record = {
          url: String(url),
          authorization: headers.Authorization,
          body: opts.body ? JSON.parse(opts.body) : undefined,
        };
        fs.appendFileSync(process.env.MIDBRAIN_TEST_FETCH_LOG, JSON.stringify(record) + "\\n");
        if (process.env.MIDBRAIN_TEST_FETCH_MODE === "throw") throw new Error("network down");
        if (String(url).includes("/memories/episodic")) {
          return { ok: true, status: 201, text: async () => "", json: async () => ({}) };
        }
        if (String(url).includes("/memories/search/procedural")) {
          return { ok: true, status: 200, json: async () => [] };
        }
        return { ok: false, status: 404, text: async () => "not found" };
      };
    `);
    return { dir, file };
  }

  function runPersistentUserHook({ home, preloadFile, fetchLog, mode, prompt }) {
    return spawnSync(process.execPath, [
      "--import", preloadFile,
      path.join(REPO_ROOT, "plugins", "codex", "capture-user.mjs"),
    ], {
      input: JSON.stringify({ prompt, cwd: path.join(home, "project") }),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        [PK_ENV]: undefined,
        MIDBRAIN_TEST_FETCH_LOG: fetchLog,
        MIDBRAIN_TEST_FETCH_MODE: mode,
      },
    });
  }

  function readFetchLog(fetchLog) {
    if (!fs.existsSync(fetchLog)) return [];
    return fs.readFileSync(fetchLog, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function cachedTexts(home) {
    const cacheDir = path.join(home, ".cache", "midbrain");
    if (!fs.existsSync(cacheDir)) return [];
    return fs.readdirSync(cacheDir)
      .filter((name) => name.endsWith(".ndjson"))
      .flatMap((name) => fs.readFileSync(path.join(cacheDir, name), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line).text));
  }

  it("UserPromptSubmit wrapper exits zero with empty stdout on procedural match by default", () => {
    const result = runUserHook({ prompt: "codex workflow", cwd: "/repo" }, "match");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("UserPromptSubmit wrapper exits zero and writes context stdout on PK match when opted in", () => {
    const result = runUserHook(
      { prompt: "codex workflow", cwd: "/repo" },
      "match",
      { [PK_ENV]: "1" },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(payload.hookSpecificOutput.additionalContext).toContain("Codex Workflow");
  });

  it("UserPromptSubmit wrapper exits zero with empty stdout on no PK match", () => {
    const result = runUserHook({ prompt: "unrelated", cwd: "/repo" }, "empty");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("UserPromptSubmit wrapper exits zero with empty stdout on API failure", () => {
    const result = runUserHook({ prompt: "codex workflow", cwd: "/repo" }, "throw");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("UserPromptSubmit wrapper caches outage memory and only flushes it with the original key", () => {
    const home = tempHomeWithNamedKey("key-a");
    const loaded = preloadWithRequestLog();
    const fetchLog = path.join(home, "fetch-log.ndjson");

    try {
      const outage = runPersistentUserHook({
        home,
        preloadFile: loaded.file,
        fetchLog,
        mode: "throw",
        prompt: "outage prompt from key A",
      });
      expect(outage.status).toBe(0);
      expect(outage.stdout).toBe("");
      expect(cachedTexts(home)).toContain("outage prompt from key A");

      writeHomeKey(home, "key-b");
      const wrongKeyRecovery = runPersistentUserHook({
        home,
        preloadFile: loaded.file,
        fetchLog,
        mode: "ok",
        prompt: "fresh prompt from key B",
      });
      expect(wrongKeyRecovery.status).toBe(0);
      expect(cachedTexts(home)).toContain("outage prompt from key A");

      writeHomeKey(home, "key-a");
      const originalKeyRecovery = runPersistentUserHook({
        home,
        preloadFile: loaded.file,
        fetchLog,
        mode: "ok",
        prompt: "fresh prompt from key A",
      });
      expect(originalKeyRecovery.status).toBe(0);

      const posts = readFetchLog(fetchLog);
      expect(posts).not.toContainEqual(expect.objectContaining({
        authorization: "Bearer key-b",
        body: expect.objectContaining({ text: "outage prompt from key A" }),
      }));
      expect(posts).toContainEqual(expect.objectContaining({
        authorization: "Bearer key-a",
        body: expect.objectContaining({ text: "outage prompt from key A" }),
      }));
      expect(cachedTexts(home)).not.toContain("outage prompt from key A");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(loaded.dir, { recursive: true, force: true });
    }
  });

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
