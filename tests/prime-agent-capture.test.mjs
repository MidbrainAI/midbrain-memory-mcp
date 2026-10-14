/**
 * Tests for the Prime Agent capture runtime (plugins/prime-agent/common.mjs)
 * and the kernel skill that launches it, against a throwaway home: session
 * logs, cursors and locks all live in the sandbox, and the API is a stub.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";

import { makeTestEnv } from "./helpers/test-env.mjs";
import {
  applyEntry, newSessionState, messageText, parseLogChunk, formatToolSummary,
  syncLog, syncAll, watch, acquireLock, isAlive,
} from "../plugins/prime-agent/common.mjs";
import { primeCaptureStateDir } from "../shared/clients/prime-agent.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const IS_WIN = process.platform === "win32";
const HAS_PYTHON = !IS_WIN && (process.env.PATH || "").split(path.delimiter)
  .some((dir) => dir && fs.existsSync(path.join(dir, "python3")));
const T0 = Date.parse("2026-10-12T12:00:00.000Z");

let env;
let sessionsDir;
let stored;
let deps;

beforeEach(async () => {
  env = await makeTestEnv();
  sessionsDir = path.join(env.root, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  stored = [];
  deps = {
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    seen: new Map(),
    sessionsDir,
    enabledAt: T0,
    pollMs: 5,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    apiFor: vi.fn(async (cwd) => ({
      storeEpisodic: async (text, role, _logger, metadata) => { stored.push({ text, role, metadata, cwd }); return true; },
    })),
  };
});

afterEach(async () => {
  await env.restore();
});

const header = (id, timestamp = "2026-10-12T12:30:00.000Z", extra = {}) => ({
  type: "session", version: 3, id, timestamp, cwd: "/work/repo", rlmDepth: 0, ...extra,
});
const user = (text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const toolCall = (id, code, text = "") => ({
  type: "message",
  message: {
    role: "assistant",
    stopReason: "toolUse",
    content: [...(text ? [{ type: "text", text }] : []), { type: "toolCall", id, name: "ipython", arguments: { code } }],
  },
});
const toolResult = (id, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: id, isError, content: [] } });
const answer = (text, stopReason = "stop") => ({ type: "message", message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });

function writeLog(name, entries, { partial = "" } = {}) {
  const file = path.join(sessionsDir, name);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e) + "\n").join("") + partial, "utf8");
  return file;
}
function appendLog(file, entries, raw = "") {
  fs.appendFileSync(file, entries.map((e) => JSON.stringify(e) + "\n").join("") + raw, "utf8");
  // A same-millisecond append keeps mtime; move it so the mtime check sees the change.
  const later = new Date(fs.statSync(file).mtimeMs + 1000);
  fs.utimesSync(file, later, later);
}

describe("applyEntry", () => {
  it("captures the user text, then the final answer and a tool summary", () => {
    const state = newSessionState();
    expect(applyEntry(state, header("s1"))).toEqual([]);
    expect(applyEntry(state, user("fix the build"))).toEqual([{ role: "user", text: "fix the build" }]);
    expect(applyEntry(state, toolCall("t1", "run('npm test')\nmore", "Running tests"))).toEqual([]);
    expect(applyEntry(state, toolResult("t1", true))).toEqual([]);
    expect(applyEntry(state, toolCall("t2", "edit('a.js')"))).toEqual([]);
    expect(applyEntry(state, toolResult("t2"))).toEqual([]);
    const captures = applyEntry(state, answer("Fixed it."));
    expect(captures[0]).toEqual({ role: "assistant", text: "Fixed it." });
    expect(captures[1].text).toBe([
      "Tool activity summary",
      "Tools: ipython x2",
      "Notable:",
      "- ipython: run('npm test') | more -> error",
      "- ipython: edit('a.js') -> success",
    ].join("\n"));
    expect(state.tools).toEqual([]);
  });

  it("skips empty text, non-text blocks, errors, aborts and subagent sessions", () => {
    const state = newSessionState();
    applyEntry(state, header("s1"));
    expect(applyEntry(state, { type: "message", message: { role: "user", content: [{ type: "image", data: "x" }] } })).toEqual([]);
    applyEntry(state, toolCall("t1", "x"));
    expect(applyEntry(state, answer("partial", "aborted"))).toEqual([]);
    expect(state.tools).toEqual([]);
    expect(applyEntry(state, { type: "custom_message", content: "[harness-digest]" })).toEqual([]);
    expect(applyEntry(state, { type: "compaction", summary: "..." })).toEqual([]);

    const child = newSessionState();
    applyEntry(child, header("s2", undefined, { rlmDepth: 1 }));
    expect(applyEntry(child, user("subtask"))).toEqual([]);
    expect(applyEntry(child, answer("done"))).toEqual([]);
  });

  it("captures a message a person sent with prime-agent send, not one from another agent", () => {
    const state = newSessionState();
    applyEntry(state, header("s1"));
    const sent = (from, message = "deploy it") => ({
      type: "custom_message",
      customType: "agent_message",
      content: `[agent-message from x]\n\n${message}`,
      details: { message, from, target: { sessionId: "s1" } },
    });
    expect(applyEntry(state, sent({ clientId: "daemon-client:abc" }))).toEqual([{ role: "user", text: "deploy it" }]);
    expect(applyEntry(state, sent({ sessionId: "child", activeSessionId: "c1" }))).toEqual([]);
    expect(applyEntry(state, sent({ activeSessionId: "c1", clientId: "x" }))).toEqual([]);
    expect(applyEntry(state, sent(undefined))).toEqual([]);
    expect(applyEntry(state, sent({ clientId: "daemon-client:abc" }, "  "))).toEqual([]);
    expect(applyEntry(state, { type: "custom_message", customType: "heartbeat_prompt", content: "wake up" })).toEqual([]);
  });

  it("skips the parent history a forked session starts with", () => {
    const state = newSessionState();
    applyEntry(state, header("fork", "2026-10-12T12:53:05.000Z", { parentSession: "/s/parent.jsonl" }));
    expect(applyEntry(state, { ...user("copied"), timestamp: "2026-10-12T12:48:56.000Z" })).toEqual([]);
    expect(applyEntry(state, { ...answer("copied reply"), timestamp: "2026-10-12T12:48:58.000Z" })).toEqual([]);
    expect(applyEntry(state, { ...user("new"), timestamp: "2026-10-12T12:53:05.100Z" })).toEqual([{ role: "user", text: "new" }]);
  });

  it("keeps an answer whose length ran out, and string content", () => {
    const state = newSessionState();
    expect(applyEntry(state, answer("long answer", "length"))).toEqual([{ role: "assistant", text: "long answer" }]);
    expect(messageText({ content: "  plain  " })).toBe("plain");
  });

  it("redacts secrets and bounds the tool summary", () => {
    const tools = Array.from({ length: 12 }, (_, i) => ({ name: "ipython", detail: `cell ${i}`, ok: true }));
    const summary = formatToolSummary(tools);
    expect(summary).toContain("Tools: ipython x12");
    expect(summary).toContain("Omitted: 2 lower-signal tool calls");

    const state = newSessionState();
    applyEntry(state, toolCall("t1", "key = 'sk-abcdefghijklmnop'"));
    const [, toolSummary] = applyEntry(state, answer("done"));
    expect(toolSummary.text).toContain("[redacted]");
    expect(toolSummary.text).not.toContain("sk-abcdefghijklmnop");
  });
});

describe("parseLogChunk", () => {
  it("leaves a trailing partial line and skips corrupt lines", () => {
    const text = '{"a":1}\nnot json\n{"b":2}\n{"c":';
    const { entries, consumed } = parseLogChunk(Buffer.from(text));
    expect(entries).toEqual([{ a: 1 }, { b: 2 }]);
    expect(consumed).toBe(text.lastIndexOf("\n") + 1);
    expect(parseLogChunk(Buffer.from('{"c":'))).toEqual({ entries: [], consumed: 0 });
  });
});

describe("syncLog", () => {
  it("stores a new session's turns once with client, cwd and session metadata", async () => {
    const file = writeLog("s1.jsonl", [header("s1"), user("hello"), answer("hi there")]);
    expect(await syncLog(file, deps)).toBe(2);
    expect(stored).toEqual([
      { text: "hello", role: "user", metadata: { client: "prime-agent", cwd: "/work/repo", session_id: "s1" }, cwd: "/work/repo" },
      { text: "hi there", role: "assistant", metadata: { client: "prime-agent", cwd: "/work/repo", session_id: "s1" }, cwd: "/work/repo" },
    ]);
    expect(await syncLog(file, deps)).toBe(0);

    appendLog(file, [user("next"), toolCall("t1", "x")]);
    expect(await syncLog(file, deps)).toBe(1);
    appendLog(file, [toolResult("t1"), answer("done")]);
    expect(await syncLog(file, deps)).toBe(2);
    expect(stored.map((s) => s.text)).toEqual([
      "hello", "hi there", "next", "done",
      "Tool activity summary\nTools: ipython x1\nNotable:\n- ipython: x -> success",
    ]);
  });

  it("waits for a partial line to complete", async () => {
    const file = writeLog("s1.jsonl", [header("s1")], { partial: '{"type":"message","message":{"role":"user","content":"half' });
    expect(await syncLog(file, deps)).toBe(0);
    appendLog(file, [], ' done"}}\n');
    expect(await syncLog(file, deps)).toBe(1);
    expect(stored[0].text).toBe("half done");
  });

  it("reads a session that started before capture was enabled only from its end", async () => {
    const file = writeLog("old.jsonl", [header("old", "2026-10-12T11:00:00.000Z"), user("old history"), answer("old reply")]);
    expect(await syncLog(file, deps)).toBe(0);
    appendLog(file, [user("new turn")]);
    expect(await syncLog(file, deps)).toBe(1);
    expect(stored.map((s) => [s.text, s.metadata.session_id])).toEqual([["new turn", "old"]]);
  });

  it("resumes at the end of a log that shrank", async () => {
    const file = writeLog("s1.jsonl", [header("s1"), user("one"), answer("two")]);
    await syncLog(file, deps);
    writeLog("s1.jsonl", [header("s1")]);
    expect(await syncLog(file, deps)).toBe(0);
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/PRIME LOG SHRANK/));
  });

  it("leaves a log to a live lock holder and takes over a dead one's lock", async () => {
    const file = writeLog("s1.jsonl", [header("s1"), user("hello")]);
    const lock = path.join(primeCaptureStateDir(), "locks", "s1.jsonl.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, String(process.ppid));
    expect(await syncLog(file, deps)).toBe(0);

    fs.writeFileSync(lock, "999999999");
    expect(await syncLog(file, deps)).toBe(1);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("logs a failed store and keeps going", async () => {
    deps.apiFor = vi.fn(async () => { throw new Error("no key"); });
    const file = writeLog("s1.jsonl", [header("s1"), user("a"), answer("b")]);
    expect(await syncLog(file, deps)).toBe(0);
    expect(deps.logger.error).toHaveBeenCalledWith("PRIME CAPTURE ERROR (user): no key");
    expect(await syncLog(file, deps)).toBe(0);
  });
});

describe("syncAll and watch", () => {
  it("reads only top-level .jsonl logs, and tolerates a missing sessions dir", async () => {
    writeLog("s1.jsonl", [header("s1"), user("a")]);
    writeLog("notes.txt", [user("not a log")]);
    fs.mkdirSync(path.join(sessionsDir, "children"));
    fs.writeFileSync(path.join(sessionsDir, "children", "c.jsonl"), JSON.stringify(user("child")) + "\n");
    expect(await syncAll(deps)).toBe(1);
    expect(await syncAll(deps)).toBe(0);

    expect(await syncAll({ ...deps, sessionsDir: path.join(env.root, "missing") })).toBe(0);
    expect(deps.logger.error).not.toHaveBeenCalled();
  });

  it("polls while the owner runs, then makes a final pass", async () => {
    const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 400)"], { stdio: "ignore", env: env.childEnv() });
    const file = writeLog("s1.jsonl", [header("s1"), user("first")]);
    setTimeout(() => appendLog(file, [answer("second")]), 100);
    const stopped = new Promise((resolve) => owner.on("exit", resolve));
    expect(await watch({ ...deps, ownerPid: owner.pid })).toBe(2);
    await stopped;
    expect(stored.map((s) => s.text)).toEqual(["first", "second"]);
    expect(fs.readdirSync(path.join(primeCaptureStateDir(), "owners"))).toEqual([]);
  });

  it("exits at once when another watcher serves the same owner", async () => {
    const ownerLock = path.join(primeCaptureStateDir(), "owners", `${process.ppid}.lock`);
    fs.mkdirSync(path.dirname(ownerLock), { recursive: true });
    fs.writeFileSync(ownerLock, String(process.ppid));
    writeLog("s1.jsonl", [header("s1"), user("a")]);
    expect(await watch({ ...deps, ownerPid: process.ppid })).toBe(0);
    expect(stored).toEqual([]);
  });

  it("makes one pass without an owner", async () => {
    writeLog("s1.jsonl", [header("s1"), user("a")]);
    expect(await watch({ ...deps, ownerPid: undefined })).toBe(1);
  });

  it("isAlive and acquireLock basics", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(999999999)).toBe(false);
    expect(isAlive(0)).toBe(false);
    const lock = path.join(env.root, "x.lock");
    const release = acquireLock(lock);
    expect(release).toBeTypeOf("function");
    expect(acquireLock(lock)).toBeTypeOf("function"); // our own pid: re-entrant takeover
    release();
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe("hook prime-agent CLI", () => {
  it("sync exits 0 with no sessions and records when capture was enabled", () => {
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "index.js"), "hook", "prime-agent", "sync"], {
      env: env.childEnv(),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(env.home, ".cache", "midbrain", "prime-agent", "enabled-at"))).toBe(true);
  });

  it("rejects an unknown prime-agent event", () => {
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "index.js"), "hook", "prime-agent", "user"], {
      env: env.childEnv(),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("hook prime-agent watch|sync");
  });
});

describe.skipIf(!HAS_PYTHON)("kernel skill", () => {
  const skillSrc = path.join(REPO_ROOT, "plugins", "prime-agent", "skill", "src");

  function importSkill(extraEnv) {
    return spawnSync("python3", ["-c", "import midbrain_memory"], {
      env: env.childEnv({ PYTHONPATH: skillSrc, PYTHONDONTWRITEBYTECODE: "1", ...extraEnv }),
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  function writeStubShim() {
    const record = path.join(env.root, "shim-calls.txt");
    fs.mkdirSync(env.paths.midbrainBin, { recursive: true });
    fs.writeFileSync(env.paths.primeShim, `#!/bin/sh\necho "$1 $PRIME_AGENT_KERNEL_OWNER_PID" >> '${record}'\n`, { mode: 0o755 });
    return record;
  }

  async function waitFor(file, ms = 5_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  it("launches the watcher through the stable shim when imported in a kernel", async () => {
    const record = writeStubShim();
    const result = importSkill({ PRIME_AGENT_KERNEL_OWNER_PID: "4242" });
    expect(result.status).toBe(0);
    expect(await waitFor(record)).toBe("watch 4242\n");
  });

  it("does nothing outside a kernel, when disabled, or without the shim", async () => {
    const record = writeStubShim();
    expect(importSkill({}).status).toBe(0);
    expect(importSkill({ PRIME_AGENT_KERNEL_OWNER_PID: "4242", MIDBRAIN_PRIME_CAPTURE: "0" }).status).toBe(0);
    fs.rmSync(env.paths.primeShim);
    expect(importSkill({ PRIME_AGENT_KERNEL_OWNER_PID: "4242" }).status).toBe(0);
    expect(await waitFor(record, 500)).toBeNull();
  });
});
