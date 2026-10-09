/**
 * Unit + spawned-wrapper tests for plugins/cursor (capture runtime).
 *
 * Unit tests stub the MidBrain API through injected deps. Wrapper tests spawn
 * the real hook scripts under a makeTestEnv() sandbox HOME with a fetch
 * preload that records every request — no network, no real key.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "fs";
import net from "node:net";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CONTINUE,
  STORE_TIME_LIMIT_MS,
  captureAssistant,
  captureSessionEnd,
  captureToolUse,
  captureUser,
  finishHook,
  lastTranscriptTurn,
  runBackgroundStore,
  storeTranscriptJob,
  storeUserJob,
  toCodexInput,
  transcriptStoreJob,
} from "../plugins/cursor/common.mjs";
import { _setCachePath, readAndClearCache } from "../shared/episodic-cache.mjs";
import { makeTestEnv } from "./helpers/test-env.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const EMAIL = "someone@example.com";
const IS_WIN = process.platform === "win32";
const STORE_ENTRY = path.join(REPO_ROOT, "plugins", "cursor", "store-user.mjs");
const NEVER = () => new Promise(() => {});

/** Fake ChildProcess: emits "spawn" (or "error") on the next tick. */
function fakeSpawn({ error } = {}) {
  const calls = [];
  const fn = vi.fn((command, args, options) => {
    const child = new EventEmitter();
    child.unref = vi.fn();
    calls.push({ command, args, options, child });
    process.nextTick(() => (error ? child.emit("error", error) : child.emit("spawn")));
    return child;
  });
  fn.calls = calls;
  return fn;
}

async function waitFor(check, { timeoutMs = 10_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Common fields Cursor sends on every hook (docs: cursor.com/docs/agent/hooks).
function common(event, extra = {}) {
  return {
    conversation_id: "conv-1",
    generation_id: "gen-1",
    model: "some-model",
    hook_event_name: event,
    cursor_version: "9.9.9",
    workspace_roots: ["/repo"],
    user_email: EMAIL,
    transcript_path: null,
    ...extra,
  };
}

function makeDeps() {
  const api = { storeEpisodic: vi.fn().mockResolvedValue(true) };
  return {
    api,
    client: "cursor",
    createApi: vi.fn(async () => api),
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    assistantBufferDir: fs.mkdtempSync(path.join(os.tmpdir(), "cursor-assistant-")),
    toolBufferDir: fs.mkdtempSync(path.join(os.tmpdir(), "cursor-tools-")),
    storeJobDir: fs.mkdtempSync(path.join(os.tmpdir(), "cursor-jobs-")),
    liveSessionDir: fs.mkdtempSync(path.join(os.tmpdir(), "cursor-live-")),
    transcriptRoot: fs.mkdtempSync(path.join(os.tmpdir(), "cursor-projects-")),
  };
}

const parseRows = (raw) => raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));

// Shape of a headless `cursor-agent -p` transcript (cursor-agent 2026.10.01).
function transcriptLines(prompt = "read notes.txt", reply = "**hl-97**\n\nprobe file hello") {
  return [
    { role: "user", message: { content: [{ type: "text", text: `<timestamp>Friday, Oct 9, 2026, 12:58 PM (UTC+2)</timestamp>\n<user_query>\n${prompt}\n</user_query>` }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "I'll read `notes.txt`." }, { type: "tool_use", name: "Read", input: { path: "/repo/notes.txt" } }] } },
    { role: "assistant", message: { content: [{ type: "text", text: reply }] } },
    { type: "turn_ended", status: "success" },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

// Headless sessionEnd: generation_id is the conversation id (no per-turn id).
function sessionEnd(transcriptPath, extra = {}) {
  return common("sessionEnd", {
    generation_id: "conv-1",
    reason: "completed",
    duration_ms: 19_000,
    final_status: "completed",
    is_background_agent: false,
    transcript_path: transcriptPath,
    ...extra,
  });
}

describe("Cursor payload mapping", () => {
  it("maps conversation/generation/workspace ids and never carries user_email", () => {
    const mapped = toCodexInput(common("afterAgentResponse", { text: "hi" }));
    expect(mapped).toEqual({
      cwd: "/repo",
      session_id: "conv-1",
      turn_id: "gen-1",
      last_assistant_message: "hi",
    });
    expect(JSON.stringify(mapped)).not.toContain(EMAIL);
  });

  it("falls back to the payload cwd when workspace_roots is empty", () => {
    expect(toCodexInput({ workspace_roots: [], cwd: "/other" }).cwd).toBe("/other");
  });

  it("parses Cursor's JSON-string tool_output into a structured response", () => {
    const mapped = toCodexInput(common("postToolUse", {
      tool_name: "Shell",
      tool_use_id: "t1",
      tool_input: { command: "npm test" },
      tool_output: '{"exitCode":1,"stderr":"boom"}',
    }));
    expect(mapped.tool_response).toEqual({ exitCode: 1, stderr: "boom" });
  });
});

describe("Cursor hook capture", () => {
  let deps;
  beforeEach(() => { deps = makeDeps(); });
  afterEach(() => {
    fs.rmSync(deps.assistantBufferDir, { recursive: true, force: true });
    fs.rmSync(deps.toolBufferDir, { recursive: true, force: true });
    fs.rmSync(deps.storeJobDir, { recursive: true, force: true });
    fs.rmSync(deps.liveSessionDir, { recursive: true, force: true });
    fs.rmSync(deps.transcriptRoot, { recursive: true, force: true });
  });

  it("captureUser hands the store to a detached child and never awaits it", async () => {
    deps.spawn = fakeSpawn();
    deps.api.storeEpisodic.mockImplementation(NEVER);

    const out = await captureUser(common("beforeSubmitPrompt", {
      prompt: "  remember this  ",
      attachments: [{ type: "file", file_path: "/repo/a.js" }],
    }), deps);

    expect(out).toEqual(CONTINUE);
    expect(deps.createApi).not.toHaveBeenCalled();
    expect(deps.spawn).toHaveBeenCalledOnce();
    const [{ command, args, options, child }] = deps.spawn.calls;
    expect(command).toBe(process.execPath);
    expect(args.at(-2)).toBe(STORE_ENTRY);
    expect(options).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true });
    expect(options.shell).toBeUndefined();
    expect(child.unref).toHaveBeenCalledOnce();

    const jobFile = args.at(-1);
    expect(path.dirname(jobFile)).toBe(deps.storeJobDir);
    const raw = fs.readFileSync(jobFile, "utf8");
    expect(JSON.parse(raw)).toEqual({ prompt: "remember this", cwd: "/repo", session_id: "conv-1" });
    expect(raw).not.toContain(EMAIL);
    if (!IS_WIN) expect(fs.statSync(jobFile).mode & 0o777).toBe(0o600);
  });

  it("captureUser continues without spawning or an API call on an empty prompt", async () => {
    deps.spawn = fakeSpawn();
    await expect(captureUser(common("beforeSubmitPrompt", { prompt: "  " }), deps))
      .resolves.toEqual(CONTINUE);
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(deps.createApi).not.toHaveBeenCalled();
  });

  it("the background child stores the prompt with cursor metadata and deletes the job file", async () => {
    deps.spawn = fakeSpawn();
    await captureUser(common("beforeSubmitPrompt", { prompt: "ship it" }), deps);
    const jobFile = deps.spawn.calls[0].args.at(-1);

    await runBackgroundStore(jobFile, deps);

    expect(deps.createApi).toHaveBeenCalledWith("/repo");
    expect(deps.api.storeEpisodic.mock.calls).toEqual([[
      "ship it",
      "user",
      deps.logger,
      { client: "cursor", cwd: "/repo", session_id: "conv-1" },
    ]]);
    expect(JSON.stringify(deps.api.storeEpisodic.mock.calls)).not.toContain(EMAIL);
    expect(fs.existsSync(jobFile)).toBe(false);
  });

  it("the background child logs when a non-project key answers for the prompt's cwd (#92)", async () => {
    deps.api.projectFallbackNote = "no project key covers the project directory; captures from it use the global key";
    deps.api.requestedProjectDir = "/repo";
    await expect(storeUserJob({ prompt: "hi", cwd: "/repo" }, deps)).resolves.toBe("stored");
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/^SCOPE: no project key covers/));
  });

  it("the background child is fail-open when key resolution fails", async () => {
    deps.createApi.mockRejectedValueOnce(new Error("no key"));
    await expect(storeUserJob({ prompt: "hi", cwd: "/repo" }, deps)).resolves.toBe("failed");
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("CURSOR CAPTURE ERROR (user)"));
  });

  it("the background child's hard time limit caches the entry under the API cache scope", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-cache-"));
    const scope = "ab".repeat(32);
    _setCachePath(cacheDir);
    try {
      deps.api.cacheScope = scope;
      deps.api.storeEpisodic.mockImplementation(NEVER);
      deps.storeTimeLimitMs = 30;

      await expect(storeUserJob({ prompt: "slow", cwd: "/repo", session_id: "conv-1" }, deps))
        .resolves.toBe("timeout");

      expect(readAndClearCache(scope)).toEqual([expect.objectContaining({
        text: "slow",
        role: "user",
        memory_metadata: { client: "cursor", cwd: "/repo", session_id: "conv-1" },
      })]);
      expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("CURSOR CAPTURE TIMEOUT (user)"));
    } finally {
      _setCachePath(null);
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("the default hard time limit is 20 seconds", () => {
    expect(STORE_TIME_LIMIT_MS).toBe(20_000);
  });

  it.each([
    ["emits an error event", () => fakeSpawn({ error: new Error("ENOENT") })],
    ["throws synchronously", () => vi.fn(() => { throw new Error("EAGAIN"); })],
  ])("spawn failure (%s) falls back to an inline store and still continues", async (_label, makeSpawn) => {
    deps.spawn = makeSpawn();

    await expect(captureUser(common("beforeSubmitPrompt", { prompt: "inline" }), deps))
      .resolves.toEqual(CONTINUE);

    expect(deps.api.storeEpisodic).toHaveBeenCalledWith(
      "inline", "user", deps.logger, { client: "cursor", cwd: "/repo", session_id: "conv-1" },
    );
    expect(fs.readdirSync(deps.storeJobDir)).toEqual([]);
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("storing inline"));
  });

  it("the inline fallback keeps the hard time limit and caches on expiry", async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-cache-"));
    const scope = "cd".repeat(32);
    _setCachePath(cacheDir);
    try {
      deps.spawn = vi.fn(() => { throw new Error("EAGAIN"); });
      deps.api.cacheScope = scope;
      deps.api.storeEpisodic.mockImplementation(NEVER);
      deps.storeTimeLimitMs = 30;
      await expect(captureUser(common("beforeSubmitPrompt", { prompt: "hi" }), deps))
        .resolves.toEqual(CONTINUE);
      expect(readAndClearCache(scope).map((entry) => entry.text)).toEqual(["hi"]);
    } finally {
      _setCachePath(null);
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("captureAssistant stores the response text with cursor metadata", async () => {
    await captureAssistant(common("afterAgentResponse", { text: "done" }), deps);

    expect(deps.api.storeEpisodic.mock.calls).toEqual([[
      "done",
      "assistant",
      deps.logger,
      { client: "cursor", cwd: "/repo", session_id: "conv-1" },
    ]]);
  });

  it("postToolUse events are buffered per generation and summarized with the response", async () => {
    await captureToolUse(common("postToolUse", {
      tool_name: "Shell",
      tool_use_id: "t1",
      tool_input: { command: "npm test" },
      tool_output: '{"exitCode":1,"stderr":"2 failed"}',
      cwd: "/repo",
    }), deps);
    await captureToolUse(common("postToolUse", {
      tool_name: "Read",
      tool_use_id: "t2",
      tool_input: { path: "/repo/a.js", token: "sk-1234567890abcdef" },
      tool_output: "file body",
    }), deps);
    expect(deps.api.storeEpisodic).not.toHaveBeenCalled();

    await captureAssistant(common("afterAgentResponse", { text: "fixed" }), deps);

    expect(deps.api.storeEpisodic).toHaveBeenCalledTimes(2);
    const [summary, role, , metadata] = deps.api.storeEpisodic.mock.calls[1];
    expect(role).toBe("assistant");
    expect(metadata).toEqual({ client: "cursor", cwd: "/repo", session_id: "conv-1" });
    expect(summary).toContain("Tools: Shell x1, Read x1");
    expect(summary).toContain("Shell: npm test -> exit 1: 2 failed");
    expect(summary).not.toContain("sk-1234567890abcdef");
    expect(summary).not.toContain(EMAIL);

    // buffer is cleared once stored: the next response carries no summary
    deps.api.storeEpisodic.mockClear();
    await captureAssistant(common("afterAgentResponse", { text: "again" }), deps);
    expect(deps.api.storeEpisodic).toHaveBeenCalledOnce();
  });

  it("tool events from another generation are not attached to this response", async () => {
    await captureToolUse(common("postToolUse", {
      generation_id: "gen-other",
      tool_name: "Shell",
      tool_input: { command: "ls" },
      tool_output: '{"exitCode":0}',
    }), deps);

    await captureAssistant(common("afterAgentResponse", { text: "done" }), deps);
    expect(deps.api.storeEpisodic).toHaveBeenCalledOnce();
  });

  it("captureAssistant is fail-open when the API is unavailable", async () => {
    deps.createApi.mockRejectedValue(new Error("no key"));
    await expect(captureAssistant(common("afterAgentResponse", { text: "x" }), deps))
      .resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("CURSOR CAPTURE ERROR (assistant)"));
  });
});

describe("Cursor headless capture from sessionEnd (#97)", () => {
  let deps;
  let transcript;
  beforeEach(() => {
    deps = makeDeps();
    transcript = path.join(deps.transcriptRoot, "repo", "agent-transcripts", "conv-1", "conv-1.jsonl");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, transcriptLines());
  });
  afterEach(() => {
    for (const dir of [deps.assistantBufferDir, deps.toolBufferDir, deps.storeJobDir, deps.liveSessionDir, deps.transcriptRoot]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lastTranscriptTurn returns the unwrapped user query and the final assistant text", () => {
    expect(lastTranscriptTurn(parseRows(transcriptLines()))).toEqual({
      prompt: "read notes.txt",
      reply: "**hl-97**\n\nprobe file hello",
    });
  });

  it("lastTranscriptTurn returns only the last turn of a resumed conversation", () => {
    const raw = transcriptLines("first", "one") + transcriptLines("second", "two");
    expect(lastTranscriptTurn(parseRows(raw))).toEqual({ prompt: "second", reply: "two" });
  });

  it("lastTranscriptTurn keeps tags the user typed inside the prompt; only Cursor's wrapper is removed", () => {
    const prompt = "Explain this literal XML: <user_query>hello</user_query> and its closing tag.";
    expect(lastTranscriptTurn(parseRows(transcriptLines(prompt))).prompt).toBe(prompt);
    const unwrapped = "<timestamp>t</timestamp>\nkeep <user_query>x</user_query> tail";
    expect(lastTranscriptTurn([{ role: "user", message: { content: unwrapped } }]).prompt)
      .toBe("keep <user_query>x</user_query> tail");
  });

  it("lastTranscriptTurn keeps the prompt when the turn ended without a reply", () => {
    const rows = [{ role: "user", message: { content: [{ type: "text", text: "plain prompt" }] } }];
    expect(lastTranscriptTurn(rows)).toEqual({ prompt: "plain prompt", reply: "" });
    expect(lastTranscriptTurn([])).toEqual({ prompt: "", reply: "" });
    expect(lastTranscriptTurn([{ role: "assistant", message: { content: "orphan" } }])).toEqual({ prompt: "", reply: "" });
  });

  it("the job carries the transcript path and ids only, never content or user_email", () => {
    const job = transcriptStoreJob(sessionEnd(transcript), {});
    expect(job).toEqual({ kind: "transcript", transcript_path: transcript, cwd: "/repo", session_id: "conv-1", turn_id: "conv-1" });
  });

  it("the job falls back to CURSOR_TRANSCRIPT_PATH and is null without any transcript", () => {
    expect(transcriptStoreJob(sessionEnd(null), { CURSOR_TRANSCRIPT_PATH: transcript }).transcript_path).toBe(transcript);
    expect(transcriptStoreJob(sessionEnd(null), {})).toBeNull();
  });

  it("a headless session hands the transcript to the detached child", async () => {
    deps.spawn = fakeSpawn();
    await expect(captureSessionEnd(sessionEnd(transcript), deps)).resolves.toEqual({});

    expect(deps.spawn).toHaveBeenCalledOnce();
    const jobFile = deps.spawn.calls[0].args.at(-1);
    expect(JSON.parse(fs.readFileSync(jobFile, "utf8"))).toMatchObject({ kind: "transcript", transcript_path: transcript });
    expect(fs.readFileSync(jobFile, "utf8")).not.toContain(EMAIL);
    expect(deps.api.storeEpisodic).not.toHaveBeenCalled();
  });

  it("a session where the live prompt hook ran is skipped (desktop app and interactive CLI)", async () => {
    deps.spawn = fakeSpawn();
    await captureUser(common("beforeSubmitPrompt", { prompt: "hi" }), deps);
    deps.spawn.mockClear();

    await captureSessionEnd(sessionEnd(transcript), deps);

    expect(deps.spawn).not.toHaveBeenCalled();
    expect(fs.readdirSync(deps.liveSessionDir)).toEqual([]);
  });

  it("a session where only the live response hook ran is skipped", async () => {
    deps.spawn = fakeSpawn();
    await captureAssistant(common("afterAgentResponse", { text: "done" }), deps);

    await captureSessionEnd(sessionEnd(transcript), deps);
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it("a live marker from before this session started does not suppress capture", async () => {
    deps.spawn = fakeSpawn();
    await captureAssistant(common("afterAgentResponse", { text: "earlier" }), deps);
    deps.now = () => Date.now() + 60 * 60 * 1000;

    await captureSessionEnd(sessionEnd(transcript), deps);
    expect(deps.spawn).toHaveBeenCalledOnce();
  });

  it("live markers untouched for a day are removed when a live hook runs (desktop may never fire sessionEnd)", async () => {
    const stale = path.join(deps.liveSessionDir, "conv-old");
    fs.writeFileSync(stale, "");
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(stale, dayAgo, dayAgo);

    await captureAssistant(common("afterAgentResponse", { text: "done" }), deps);

    expect(fs.readdirSync(deps.liveSessionDir)).toEqual(["conv-1"]);
  });

  it("stores the prompt, then the reply and the turn's tool summary, with cursor metadata", async () => {
    await captureToolUse(common("postToolUse", {
      generation_id: "conv-1",
      tool_name: "Read",
      tool_use_id: "t1",
      tool_input: { file_path: "/repo/notes.txt" },
      tool_output: '{"content_length":17}',
    }), deps);

    await storeTranscriptJob(transcriptStoreJob(sessionEnd(transcript), {}), deps);

    const metadata = { client: "cursor", cwd: "/repo", session_id: "conv-1" };
    const calls = deps.api.storeEpisodic.mock.calls;
    expect(calls.map(([text, role, , meta]) => [text, role, meta])).toEqual([
      ["read notes.txt", "user", metadata],
      ["**hl-97**\n\nprobe file hello", "assistant", metadata],
      [expect.stringContaining("Tools: Read x1"), "assistant", metadata],
    ]);
  });

  it("the background child runs a transcript job and deletes the job file", async () => {
    const jobFile = path.join(deps.storeJobDir, "job.json");
    fs.writeFileSync(jobFile, JSON.stringify(transcriptStoreJob(sessionEnd(transcript), {})));

    await runBackgroundStore(jobFile, deps);

    expect(fs.existsSync(jobFile)).toBe(false);
    expect(deps.api.storeEpisodic.mock.calls.map(([text, role]) => [text, role])).toEqual([
      ["read notes.txt", "user"],
      ["**hl-97**\n\nprobe file hello", "assistant"],
    ]);
  });

  it.each([
    ["missing", (dir) => path.join(dir.transcriptRoot, "missing.jsonl")],
    ["outside the Cursor projects root", (dir) => {
      const outside = path.join(dir.storeJobDir, "conv-1.jsonl");
      fs.writeFileSync(outside, transcriptLines());
      return outside;
    }],
  ])("a %s transcript is logged and stores nothing", async (_label, makePath) => {
    await storeTranscriptJob({ kind: "transcript", transcript_path: makePath(deps) }, deps);
    expect(deps.api.storeEpisodic).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("CURSOR TRANSCRIPT READ ERROR"));
  });

  describe("hard time limit", () => {
    let cacheDir;
    const scope = "cd".repeat(32);
    beforeEach(async () => {
      cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-cache-"));
      _setCachePath(cacheDir);
      deps.api.cacheScope = scope;
      deps.storeTimeLimitMs = 40;
      await captureToolUse(common("postToolUse", {
        generation_id: "conv-1",
        tool_name: "Read",
        tool_use_id: "t1",
        tool_input: { file_path: "/repo/notes.txt" },
        tool_output: '{"content_length":17}',
      }), deps);
    });
    afterEach(() => {
      _setCachePath(null);
      fs.rmSync(cacheDir, { recursive: true, force: true });
    });

    const job = () => transcriptStoreJob(sessionEnd(transcript), {});
    const cached = () => readAndClearCache(scope).map((entry) => [entry.role, entry.text.split("\n")[0]]);

    it("a stalled reply store is cached and the tool summary still goes out within the limit", async () => {
      deps.api.storeEpisodic.mockImplementation(async (text, role) => (
        role === "assistant" && !text.startsWith("Tool activity summary") ? NEVER() : true
      ));
      const started = Date.now();

      await storeTranscriptJob(job(), deps);

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(cached()).toEqual([["assistant", "**hl-97**"]]);
      expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("CURSOR CAPTURE TIMEOUT (assistant)"));
      const texts = deps.api.storeEpisodic.mock.calls.map(([text]) => text.split("\n")[0]);
      expect(texts).toEqual(["read notes.txt", "**hl-97**", "Tool activity summary"]);
      expect(fs.existsSync(path.join(deps.toolBufferDir, "conv-1", "conv-1"))).toBe(false);
    });

    it("a stalled tool-summary store is cached and the job still finishes", async () => {
      deps.api.storeEpisodic.mockImplementation(async (text) => (
        text.startsWith("Tool activity summary") ? NEVER() : true
      ));

      await storeTranscriptJob(job(), deps);

      expect(deps.api.storeEpisodic).toHaveBeenCalledTimes(3);
      expect(cached()).toEqual([["assistant", "Tool activity summary"]]);
    });

    it("stalled key resolution drops the turn instead of hanging", async () => {
      deps.createApi.mockImplementation(NEVER);

      await storeTranscriptJob(job(), deps);

      expect(deps.api.storeEpisodic).not.toHaveBeenCalled();
      expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("CURSOR CAPTURE TIMEOUT (user)"));
      expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("CURSOR CAPTURE ERROR (assistant)"));
    });
  });
});

describe("Cursor finishHook", () => {
  it("writes the response before one self-update, then exits 0", async () => {
    const order = [];
    await finishHook(CONTINUE, {
      write: (text) => order.push(`write:${text}`),
      update: async () => { order.push("update"); },
      exit: (code) => { order.push(`exit:${code}`); },
    });
    expect(order).toEqual(['write:{"continue":true}', "update", "exit:0"]);
  });

  it("writes {} and exits 0 when self-update throws", async () => {
    const writes = [];
    const exits = [];
    await finishHook(undefined, {
      write: (text) => writes.push(text),
      update: async () => { throw new Error("offline"); },
      exit: (code) => exits.push(code),
    });
    expect(writes).toEqual(["{}"]);
    expect(exits).toEqual([0]);
  });
});

describe("Cursor hook wrappers (spawned, sandboxed)", () => {
  let env;
  let preloadFile;
  let storePidDir;
  let fetchLog;
  let trackerDir;
  let trackerFile;

  // The prompt hook starts a detached store-user.mjs child and exits at once.
  // The child inherits the hook's execArgv, so this preload reaches it: it
  // records the child's pid under MIDBRAIN_TEST_STORE_PID_DIR and marks the
  // record done when the child exits. afterEach waits for that before it
  // removes the sandbox the child is still writing to (logs, self-update
  // state). One static file for the whole block; the directory comes from env.
  beforeAll(() => {
    trackerDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-store-tracker-"));
    trackerFile = path.join(trackerDir, "track-store-child.mjs");
    fs.writeFileSync(trackerFile, `
      import fs from "node:fs";
      import path from "node:path";
      const dir = process.env.MIDBRAIN_TEST_STORE_PID_DIR;
      if (dir && path.resolve(process.argv[1] || "") === ${JSON.stringify(STORE_ENTRY)}) {
        const record = path.join(dir, String(process.pid));
        fs.writeFileSync(record, "");
        process.on("exit", () => {
          try { fs.renameSync(record, record + ".done"); } catch { /* sandbox already gone */ }
        });
      }
    `);
  });

  afterAll(() => {
    fs.rmSync(trackerDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    env = await makeTestEnv({ clients: ["cursor"] });
    fs.mkdirSync(path.dirname(env.paths.globalKey), { recursive: true });
    fs.writeFileSync(env.paths.globalKey, "test-key\n", { mode: 0o600 });
    fetchLog = path.join(env.root, "fetch.ndjson");
    preloadFile = path.join(env.root, "fetch-preload.mjs");
    fs.writeFileSync(preloadFile, `
      import fs from "node:fs";
      globalThis.fetch = async (url, opts = {}) => {
        fs.appendFileSync(process.env.MIDBRAIN_TEST_FETCH_LOG, JSON.stringify({
          url: String(url),
          body: opts.body ? JSON.parse(opts.body) : undefined,
        }) + "\\n");
        if (process.env.MIDBRAIN_TEST_FETCH_MODE === "throw") throw new Error("network down");
        return { ok: true, status: 201, text: async () => "", json: async () => ({}) };
      };
    `);
    storePidDir = path.join(env.root, "store-pids");
    fs.mkdirSync(storePidDir);
  });

  afterEach(async () => {
    try {
      await waitFor(storeChildrenDone);
    } finally {
      await env.restore();
    }
  });

  /** Store children the tracker has seen: pids still running, pids that exited. */
  function storeChildren() {
    const names = fs.existsSync(storePidDir) ? fs.readdirSync(storePidDir) : [];
    return {
      running: names.filter((name) => !name.endsWith(".done")).map(Number),
      exited: names.filter((name) => name.endsWith(".done")).map((name) => Number(name.slice(0, -5))),
    };
  }

  /**
   * Re-evaluated on every tick. A child that has only just been started has
   * no record yet, but its job file exists from before the spawn until the
   * child has read it (after the tracker ran), so "no job file" means every
   * child has a record. A record is done when the child's exit handler marked
   * it; a bare record whose pid is gone is a child that died without one.
   */
  function storeChildrenDone() {
    return jobFiles().length === 0 && storeChildren().running.every((pid) => !isAlive(pid));
  }

  function isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // ESRCH: gone. EPERM: the pid belongs to another user now, so not our child.
      return false;
    }
  }

  function run(role, input, mode = "ok") {
    return spawnSync(process.execPath, [
      "--import", pathToFileURL(preloadFile).href,
      "--import", pathToFileURL(trackerFile).href,
      path.join(REPO_ROOT, "plugins", "cursor", `capture-${role}.mjs`),
    ], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 15000,
      env: env.childEnv({
        MIDBRAIN_TEST_FETCH_LOG: fetchLog,
        MIDBRAIN_TEST_FETCH_MODE: mode,
        MIDBRAIN_TEST_STORE_PID_DIR: storePidDir,
      }),
    });
  }

  function requests() {
    if (!fs.existsSync(fetchLog)) return [];
    return fs.readFileSync(fetchLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  function cachedText() {
    const cacheDir = path.join(env.home, ".cache", "midbrain");
    if (!fs.existsSync(cacheDir)) return "";
    return fs.readdirSync(cacheDir).filter((name) => name.endsWith(".ndjson"))
      .map((name) => fs.readFileSync(path.join(cacheDir, name), "utf8")).join("");
  }

  function jobFiles() {
    const dir = path.join(env.tmp, "midbrain-cursor-store-jobs");
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  }

  it("beforeSubmitPrompt answers continue and the background child posts the prompt", async () => {
    const project = path.join(env.home, "work", "repo");
    const result = run("user", common("beforeSubmitPrompt", {
      prompt: "ship it",
      workspace_roots: [project],
    }));

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
    const posts = await waitFor(() => {
      const found = requests().filter((r) => r.url.includes("/memories/episodic"));
      return found.length > 0 && jobFiles().length === 0 ? found : null;
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      text: "ship it",
      role: "user",
      memory_metadata: { client: "cursor", cwd: "~/work/repo", session_id: "conv-1" },
    });
    expect(JSON.stringify(requests())).not.toContain(EMAIL);

    // the tracker saw exactly one store child, and that child has exited; a
    // moved store entry or a broken preload would leave this list empty
    const children = await waitFor(() => {
      const seen = storeChildren();
      return seen.running.length === 0 && seen.exited.length === 1 ? seen : null;
    });
    expect(children.exited[0]).toBeGreaterThan(0);
  });

  it("beforeSubmitPrompt still answers continue when the API is unreachable", async () => {
    const result = run("user", common("beforeSubmitPrompt", { prompt: "offline" }), "throw");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });

    // the failed POST lands in the offline cache for the boot-time drain
    const cached = await waitFor(() => (cachedText().includes('"text":"offline"') ? cachedText() : null));
    expect(cached).toContain('"client":"cursor"');
    expect(cached).not.toContain(EMAIL);
  });

  it("beforeSubmitPrompt exits fast against an API that never replies; the entry is cached", async () => {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      // The child's connection is reset when it exits; on Windows that is an
      // ECONNRESET 'error' event, which must not surface as an uncaught error.
      socket.on("error", () => {});
    });
    server.on("error", () => {});
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const limitMs = 1500;
    try {
      const started = Date.now();
      const hook = spawn(process.execPath, [
        "--import", pathToFileURL(trackerFile).href,
        path.join(REPO_ROOT, "plugins", "cursor", "capture-user.mjs"),
      ], {
        env: env.childEnv({
          MIDBRAIN_API_URL: `http://127.0.0.1:${server.address().port}`,
          MIDBRAIN_CURSOR_STORE_TIMEOUT_MS: String(limitMs),
          MIDBRAIN_TEST_STORE_PID_DIR: storePidDir,
        }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      hook.stdout.on("data", (chunk) => { stdout += chunk; });
      hook.stdin.end(JSON.stringify(common("beforeSubmitPrompt", { prompt: "stalled" })));
      const code = await new Promise((resolve) => hook.on("close", resolve));
      const elapsed = Date.now() - started;

      expect(code).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ continue: true });
      expect(elapsed).toBeLessThan(2000);

      // the detached child reached the hanging server, then hit its time limit
      await waitFor(() => sockets.size > 0, { timeoutMs: 5000 });
      const cached = await waitFor(
        () => (cachedText().includes('"text":"stalled"') ? cachedText() : null),
        { timeoutMs: limitMs + 5000 },
      );
      expect(Date.now() - started).toBeLessThan(limitMs + 5000);
      expect(cached).toContain('"client":"cursor"');
      expect(cached).not.toContain(EMAIL);
      await waitFor(() => jobFiles().length === 0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("beforeSubmitPrompt answers continue on malformed stdin", () => {
    const result = spawnSync(process.execPath, [
      "--import", pathToFileURL(trackerFile).href,
      path.join(REPO_ROOT, "plugins", "cursor", "capture-user.mjs"),
    ], {
      input: "not json",
      encoding: "utf8",
      timeout: 15000,
      env: env.childEnv({ MIDBRAIN_TEST_STORE_PID_DIR: storePidDir }),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  });

  it("postToolUse + afterAgentResponse round-trip posts the answer and tool summary", () => {
    const tool = run("tool", common("postToolUse", {
      tool_name: "Shell",
      tool_use_id: "abc",
      tool_input: { command: "npm test" },
      tool_output: '{"exitCode":0,"stdout":"ok"}',
    }));
    expect(tool.status).toBe(0);
    expect(tool.stdout).toBe("{}");

    const assistant = run("assistant", common("afterAgentResponse", { text: "all green" }));
    expect(assistant.status).toBe(0);
    expect(assistant.stdout).toBe("{}");

    const texts = requests().filter((r) => r.url.includes("/memories/episodic")).map((r) => r.body.text);
    expect(texts[0]).toBe("all green");
    expect(texts[1]).toContain("Shell: npm test -> success");
    expect(JSON.stringify(requests())).not.toContain(EMAIL);
  });

  it("headless postToolUse + sessionEnd posts the prompt, the reply, and the tool summary (#97)", async () => {
    const transcript = path.join(env.home, ".cursor", "projects", "repo", "agent-transcripts", "conv-1", "conv-1.jsonl");
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, transcriptLines("headless prompt", "headless reply"));
    const tool = run("tool", common("postToolUse", {
      generation_id: "conv-1",
      tool_name: "Read",
      tool_use_id: "t1",
      tool_input: { file_path: "/repo/notes.txt" },
      tool_output: '{"content_length":17}',
    }));
    expect(tool.status).toBe(0);

    const end = run("session-end", sessionEnd(transcript));
    expect(end.status).toBe(0);
    expect(end.stdout).toBe("{}");

    const posts = await waitFor(() => {
      const found = requests().filter((r) => r.url.includes("/memories/episodic"));
      return found.length >= 3 && jobFiles().length === 0 ? found : null;
    });
    expect(posts.map((r) => [r.body.role, r.body.memory_metadata.client])).toEqual([
      ["user", "cursor"], ["assistant", "cursor"], ["assistant", "cursor"],
    ]);
    expect(posts[0].body.text).toBe("headless prompt");
    expect(posts[1].body.text).toBe("headless reply");
    expect(posts[2].body.text).toContain("Tools: Read x1");
    expect(JSON.stringify(requests())).not.toContain(EMAIL);
  });
});
