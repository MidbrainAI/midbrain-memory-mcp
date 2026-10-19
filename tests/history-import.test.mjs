/**
 * Issue #75: opt-in import of existing local conversation history.
 * Readers, planning, server-side dedupe, upload and the CLI preview.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listClaudeSessionFiles, readClaudeSession } from "../shared/history-import/readers/claude.mjs";
import { listCodexSessionFiles, readCodexSession } from "../shared/history-import/readers/codex.mjs";
import {
  ACTIVE_SESSION_MS,
  IMPORT_ORIGIN,
  MAX_TEXT_CHARS,
  importId,
  planImport,
  prepareText,
  summarize,
  trimAgainstServer,
  uploadImport,
} from "../shared/history-import/plan.mjs";
import { parseImportArgs, runImportCli } from "../shared/history-import/cli.mjs";
import { redactSecrets } from "../shared/redact.mjs";

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-import-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return file;
}

const SID = "11111111-2222-4333-8444-555555555555";

function claudeRows({ promptSource = "typed", entrypoint = "cli" } = {}) {
  const base = { sessionId: SID, cwd: "/work/proj" };
  const human = { entrypoint, promptSource, origin: { kind: "human" } };
  return [
    { type: "mode", sessionId: SID, mode: "default" },
    { ...base, ...human, type: "user", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: "first prompt" } },
    { ...base, type: "assistant", timestamp: "2026-09-01T10:00:01.000Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Let me look." }] } },
    { ...base, type: "assistant", timestamp: "2026-09-01T10:00:02.000Z", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
    { ...base, type: "user", timestamp: "2026-09-01T10:00:03.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "out" }] } },
    { ...base, type: "assistant", timestamp: "2026-09-01T10:00:04.000Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Final part one." }] } },
    { ...base, type: "assistant", timestamp: "2026-09-01T10:00:05.000Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Final part two." }], stop_reason: "end_turn" } },
    { ...base, type: "user", isMeta: true, timestamp: "2026-09-01T10:01:00.000Z", message: { role: "user", content: "skill body" } },
    { ...base, type: "user", timestamp: "2026-09-01T10:01:01.000Z", message: { role: "user", content: "<command-name>/clear</command-name>" } },
    { ...base, type: "user", origin: { kind: "task-notification" }, timestamp: "2026-09-01T10:01:02.000Z", message: { role: "user", content: "<task-notification>done</task-notification>" } },
    { ...base, type: "user", isSidechain: true, timestamp: "2026-09-01T10:01:03.000Z", message: { role: "user", content: "subagent prompt" } },
    { ...base, type: "user", isCompactSummary: true, timestamp: "2026-09-01T10:01:04.000Z", message: { role: "user", content: "This session is being continued" } },
    { ...base, ...human, type: "user", timestamp: "2026-09-01T10:02:00.000Z", message: { role: "user", content: [{ type: "text", text: "second prompt" }] } },
    { ...base, type: "assistant", timestamp: "2026-09-01T10:02:01.000Z", message: { id: "m3", role: "assistant", content: [{ type: "text", text: "Second reply." }] } },
    "{torn line",
  ];
}

function writeClaude(rows, name = `${SID}.jsonl`) {
  const file = path.join(dir, "claude", "projects", "-work-proj", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n")}\n`);
  return file;
}

function codexRows({ subagent = false, source = "vscode" } = {}) {
  return [
    { type: "session_meta", timestamp: "2026-10-06T07:00:00.000Z", payload: { id: "codex-session", cwd: "/work/codex", source: subagent ? { subagent: { thread_spawn: {} } } : source } },
    { type: "response_item", timestamp: "2026-10-06T07:00:00.100Z", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "dev" }] } },
    { type: "event_msg", timestamp: "2026-10-06T07:00:01.000Z", payload: { type: "task_started", turn_id: "t1" } },
    { type: "response_item", timestamp: "2026-10-06T07:00:01.100Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /work/codex\n..." }] } },
    { type: "response_item", timestamp: "2026-10-06T07:00:01.200Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x</environment_context>" }] } },
    { type: "response_item", timestamp: "2026-10-06T07:00:01.300Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex prompt one" }] } },
    { type: "response_item", timestamp: "2026-10-06T07:00:02.000Z", payload: { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "working" }] } },
    { type: "response_item", timestamp: "2026-10-06T07:00:03.000Z", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "codex answer one" }] } },
    { type: "event_msg", timestamp: "2026-10-06T07:00:03.100Z", payload: { type: "task_complete", turn_id: "t1", last_agent_message: "codex answer one" } },
    { type: "turn_context", timestamp: "2026-10-06T07:01:00.000Z", payload: { cwd: "/work/codex/sub" } },
    { type: "event_msg", timestamp: "2026-10-06T07:01:00.100Z", payload: { type: "task_started", turn_id: "t2" } },
    { type: "response_item", timestamp: "2026-10-06T07:01:00.200Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex prompt two" }] } },
    { type: "event_msg", timestamp: "2026-10-06T07:01:05.000Z", payload: { type: "task_complete", turn_id: "t2", last_agent_message: "fallback answer two" } },
    // A goal continuation: Codex writes it as a user message; nobody typed it.
    { type: "event_msg", timestamp: "2026-10-06T07:02:00.000Z", payload: { type: "task_started", turn_id: "t3" } },
    { type: "response_item", timestamp: "2026-10-06T07:02:00.100Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<codex_internal_context source=\"goal\">Continue working toward the goal.</codex_internal_context>" }] } },
    { type: "event_msg", timestamp: "2026-10-06T07:02:09.000Z", payload: { type: "task_complete", turn_id: "t3", last_agent_message: "autonomous work" } },
  ];
}

describe("readClaudeSession", () => {
  it("keeps typed prompts and each turn's final reply, nothing else", async () => {
    const session = await readClaudeSession(writeClaude(claudeRows()));
    expect(session).toMatchObject({ client: "claude", sessionId: SID, cwd: "/work/proj", skip: null, automated: false });
    expect(session.entries).toEqual([
      { role: "user", text: "first prompt", occurredAt: "2026-09-01T10:00:00.000Z", cwd: "/work/proj" },
      { role: "assistant", text: "Final part one.\nFinal part two.", occurredAt: "2026-09-01T10:00:05.000Z", cwd: "/work/proj" },
      { role: "user", text: "second prompt", occurredAt: "2026-09-01T10:02:00.000Z", cwd: "/work/proj" },
      { role: "assistant", text: "Second reply.", occurredAt: "2026-09-01T10:02:01.000Z", cwd: "/work/proj" },
    ]);
  });

  it("does not give a slash command's or notification's reply to the prompt before it", async () => {
    const base = { sessionId: SID, cwd: "/work/proj" };
    const human = { entrypoint: "cli", promptSource: "typed", origin: { kind: "human" } };
    const rows = [
      { ...base, ...human, type: "user", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: "explain the parser" } },
      { ...base, type: "assistant", timestamp: "2026-09-01T10:00:01.000Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Reply A." }] } },
      { ...base, ...human, type: "user", timestamp: "2026-09-01T10:01:00.000Z", message: { role: "user", content: "<command-name>/review</command-name>" } },
      { ...base, type: "user", isMeta: true, timestamp: "2026-09-01T10:01:00.100Z", message: { role: "user", content: "Review the branch." } },
      { ...base, type: "assistant", timestamp: "2026-09-01T10:01:05.000Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Reply B." }] } },
      { ...base, type: "user", origin: { kind: "task-notification" }, timestamp: "2026-09-01T10:02:00.000Z", message: { role: "user", content: "<task-notification>done</task-notification>" } },
      { ...base, type: "assistant", timestamp: "2026-09-01T10:02:01.000Z", message: { id: "m3", role: "assistant", content: [{ type: "text", text: "Noted." }] } },
    ];
    const session = await readClaudeSession(writeClaude(rows));
    expect(session.entries.map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "explain the parser"],
      ["assistant", "Reply A."],
    ]);
  });

  it("keeps a turn open across a loaded skill or Stop-hook feedback", async () => {
    const base = { sessionId: SID, cwd: "/work/proj" };
    const human = { entrypoint: "cli", promptSource: "typed", origin: { kind: "human" } };
    const rows = [
      { ...base, ...human, type: "user", timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: "start" } },
      { ...base, type: "assistant", timestamp: "2026-09-01T10:00:01.000Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Starting." }] } },
      { ...base, type: "user", isMeta: true, timestamp: "2026-09-01T10:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /skills/x" }] } },
      { ...base, type: "assistant", timestamp: "2026-09-01T10:00:03.000Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Skill loaded." }] } },
      { ...base, type: "user", isMeta: true, timestamp: "2026-09-01T10:00:04.000Z", message: { role: "user", content: "Stop hook feedback:\nkeep going" } },
      { ...base, type: "assistant", timestamp: "2026-09-01T10:00:05.000Z", message: { id: "m3", role: "assistant", content: [{ type: "text", text: "Done." }] } },
    ];
    const session = await readClaudeSession(writeClaude(rows));
    expect(session.entries.map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "start"],
      ["assistant", "Done."],
    ]);
  });

  it("marks a session no person typed in as automated", async () => {
    const session = await readClaudeSession(writeClaude(claudeRows({ promptSource: "sdk", entrypoint: "sdk-py" })));
    expect(session.automated).toBe(true);
  });

  it("lists top-level transcripts only, not subagent folders or symlinks", () => {
    const main = writeClaude(claudeRows());
    writeClaude(claudeRows(), path.join(SID, "subagents", "agent-1.jsonl"));
    fs.symlinkSync(main, path.join(path.dirname(main), "link.jsonl"));
    expect(listClaudeSessionFiles(path.join(dir, "claude", "projects"))).toEqual([main]);
  });
});

describe("readCodexSession", () => {
  it("marks codex exec runs as automated", async () => {
    const file = writeJsonl(path.join(dir, "codex", "sessions", "rollout-exec.jsonl"), codexRows({ source: "exec" }));
    expect((await readCodexSession(file)).automated).toBe(true);
  });

  it("keeps the typed prompt and final answer per turn, without injected context or goal turns", async () => {
    const file = writeJsonl(path.join(dir, "codex", "sessions", "2026", "10", "06", "rollout-a.jsonl"), codexRows());
    const session = await readCodexSession(file);
    expect(session).toMatchObject({ client: "codex", sessionId: "codex-session", cwd: "/work/codex", skip: null, automated: false });
    expect(session.entries).toEqual([
      { role: "user", text: "codex prompt one", occurredAt: "2026-10-06T07:00:01.300Z", cwd: "/work/codex" },
      { role: "assistant", text: "codex answer one", occurredAt: "2026-10-06T07:00:03.000Z", cwd: "/work/codex" },
      { role: "user", text: "codex prompt two", occurredAt: "2026-10-06T07:01:00.200Z", cwd: "/work/codex/sub" },
      { role: "assistant", text: "fallback answer two", occurredAt: "2026-10-06T07:01:05.000Z", cwd: "/work/codex/sub" },
    ]);
  });

  it("skips threads spawned by another agent", async () => {
    const file = writeJsonl(path.join(dir, "rollout-sub.jsonl"), codexRows({ subagent: true }));
    expect((await readCodexSession(file)).skip).toBe("subagent session");
  });

  it("finds rollouts in dated and archived folders", () => {
    const dated = writeJsonl(path.join(dir, "codex", "sessions", "2026", "10", "06", "rollout-a.jsonl"), []);
    const archived = writeJsonl(path.join(dir, "codex", "archived_sessions", "rollout-b.jsonl"), []);
    writeJsonl(path.join(dir, "codex", "sessions", "2026", "10", "06", "other.jsonl"), []);
    const found = listCodexSessionFiles([path.join(dir, "codex", "sessions"), path.join(dir, "codex", "archived_sessions")]);
    expect(found.sort()).toEqual([archived, dated].sort());
  });
});

function fakeReaders(sessions) {
  return {
    fake: {
      list: () => sessions.map((_, index) => `file-${index}`),
      read: async (file) => JSON.parse(JSON.stringify(sessions[Number(file.split("-")[1])])),
    },
  };
}

function session(overrides = {}) {
  return {
    client: "fake",
    file: "f",
    sessionId: "s1",
    cwd: "/work/proj",
    skip: null,
    automated: false,
    entries: [
      { role: "user", text: "p1", occurredAt: "2026-09-01T10:00:00.000Z" },
      { role: "assistant", text: "r1", occurredAt: "2026-09-01T10:00:05.000Z" },
      { role: "user", text: "p2", occurredAt: "2026-09-02T10:00:00.000Z" },
      { role: "assistant", text: "r2", occurredAt: "2026-09-02T10:00:05.000Z" },
    ],
    ...overrides,
  };
}

describe("planImport", () => {
  const now = Date.parse("2026-10-13T00:00:00Z");
  const old = () => now - ACTIVE_SESSION_MS - 1;

  it("applies the date range per entry", async () => {
    const [planned] = await planImport({
      readers: fakeReaders([session()]), clients: ["fake"], now, mtimeMs: old,
      since: "2026-09-02T00:00:00.000Z",
    });
    expect(planned.entries.map((entry) => entry.text)).toEqual(["p2", "r2"]);
  });

  it("uses a session's own last-written time when the reader gives one", async () => {
    const planned = await planImport({
      readers: fakeReaders([
        session({ sessionId: "db-active", lastWrittenMs: now - 1000 }),
        session({ sessionId: "db-old", lastWrittenMs: old() }),
      ]),
      clients: ["fake"],
      now,
      mtimeMs: () => { throw new Error("not a file"); },
    });
    expect(planned.map((item) => [item.sessionId, item.skip])).toEqual([
      ["db-active", "active (written in the last 10 minutes)"],
      ["db-old", null],
    ]);
  });

  it("skips active, automated, out-of-project and empty sessions", async () => {
    const planned = await planImport({
      readers: fakeReaders([
        session({ sessionId: "active" }),
        session({ sessionId: "auto", automated: true }),
        session({ sessionId: "elsewhere", cwd: "/other" }),
        session({ sessionId: "inside", cwd: "/work/proj/sub" }),
        session({ sessionId: "old" }),
      ]),
      clients: ["fake"],
      now,
      project: "/work/proj",
      until: "2026-09-01T00:00:00.000Z",
      mtimeMs: (file) => (file === "file-0" ? now - 1000 : old()),
    });
    expect(planned.map((item) => [item.sessionId, item.skip])).toEqual([
      ["active", "active (written in the last 10 minutes)"],
      ["auto", "automated (started by a program, not typed)"],
      ["elsewhere", "outside --project"],
      ["inside", "no turns in range"],
      ["old", "no turns in range"],
    ]);
  });

  it("imports automated sessions when asked", async () => {
    const [planned] = await planImport({
      readers: fakeReaders([session({ automated: true })]), clients: ["fake"], now, mtimeMs: old, includeAutomated: true,
    });
    expect(planned.skip).toBeNull();
  });
});

describe("trimAgainstServer", () => {
  it("keeps only whole turns from before the first live capture", async () => {
    const [trimmed] = await trimAgainstServer([session()], async () => [
      { occurred_at: "2026-09-02T10:00:03", memory_metadata: { client: "fake", session_id: "s1" } },
    ]);
    expect(trimmed.entries.map((entry) => entry.text)).toEqual(["p1", "r1"]);
    expect(trimmed.capturedLive).toBe(2);
  });

  it("drops the reply when its prompt was captured live", async () => {
    const [trimmed] = await trimAgainstServer([session()], async () => [
      { occurred_at: "2026-09-02T10:00:04Z", memory_metadata: {} },
    ]);
    expect(trimmed.entries.map((entry) => entry.text)).toEqual(["p1", "r1"]);
  });

  it("skips entries an earlier import stored and resumes after them", async () => {
    const planned = session();
    const done = planned.entries.slice(0, 3).map((entry) => ({
      occurred_at: "2026-10-13T00:00:00",
      memory_metadata: { origin: IMPORT_ORIGIN, import_id: importId(planned, entry) },
    }));
    const [trimmed] = await trimAgainstServer([planned], async () => done);
    expect(trimmed.entries.map((entry) => entry.text)).toEqual(["r2"]);
    expect(trimmed.alreadyImported).toBe(3);

    const fresh = session();
    const [complete] = await trimAgainstServer([fresh], async () => fresh.entries.map((entry) => ({
      occurred_at: "2026-10-13T00:00:00",
      memory_metadata: { origin: IMPORT_ORIGIN, import_id: importId(fresh, entry) },
    })));
    expect(complete.skip).toBe("already imported");
  });

  it("cuts at a live capture of the same text even when it was stored after the turn", async () => {
    const planned = session({
      entries: [
        { role: "user", text: "first prompt here", occurredAt: "2026-09-01T10:00:00.000Z" },
        { role: "assistant", text: "first reply", occurredAt: "2026-09-01T10:00:05.000Z" },
        { role: "user", text: "Wake up, my friend!", occurredAt: "2026-09-02T10:00:00.000Z" },
        { role: "assistant", text: "Awake and ready to help.", occurredAt: "2026-09-02T10:00:05.000Z" },
      ],
    });
    const [trimmed] = await trimAgainstServer([planned], async () => [
      // Stored 2 s after the prompt, with the client's envelope added.
      { role: "user", text: "[Mon 2026-09-02 12:00 GMT+2] Wake up, my friend!", occurred_at: "2026-09-02T10:00:02" },
    ]);
    expect(trimmed.entries.map((entry) => entry.text)).toEqual(["first prompt here", "first reply"]);
    expect(trimmed.capturedLive).toBe(2);
  });

  it("keeps an earlier turn that repeats a live-captured prompt", async () => {
    const planned = session({
      entries: [
        { role: "user", text: "commit and push the branch", occurredAt: "2026-09-01T10:00:00.000Z" },
        { role: "assistant", text: "Pushed.", occurredAt: "2026-09-01T10:00:05.000Z" },
        { role: "user", text: "run the tests again", occurredAt: "2026-09-01T11:00:00.000Z" },
        { role: "assistant", text: "All pass.", occurredAt: "2026-09-01T11:00:05.000Z" },
      ],
    });
    const [trimmed] = await trimAgainstServer([planned], async () => [
      { role: "user", text: "commit and push the branch", occurred_at: "2026-09-01T14:00:00" },
    ]);
    expect(trimmed.entries).toHaveLength(4);
  });

  it("does not match short or other-role text", async () => {
    const planned = session();
    planned.entries[2].text = "a much longer user prompt text";
    const [trimmed] = await trimAgainstServer([planned], async () => [
      { role: "user", text: "p1", occurred_at: "2026-12-01T00:00:00" },
      { role: "assistant", text: "a much longer user prompt text", occurred_at: "2026-12-01T00:00:00" },
    ]);
    expect(trimmed.entries).toHaveLength(4);
  });

  it("skips a session it cannot check rather than risk duplicates", async () => {
    const [trimmed] = await trimAgainstServer([session()], async () => { throw new Error("API 500"); });
    expect(trimmed.skip).toBe("could not check MidBrain (API 500)");
  });

  it("skips a session live capture fully covered", async () => {
    const [trimmed] = await trimAgainstServer([session()], async () => [{ occurred_at: "2026-08-01T00:00:00", memory_metadata: {} }]);
    expect(trimmed.skip).toBe("already captured live");
  });
});

describe("uploadImport", () => {
  it("posts each entry once with its original time and import labels", async () => {
    const posts = [];
    const totals = await uploadImport({
      sessions: [session({ entries: [{ role: "user", text: "key sk-abcdefgh12345678", occurredAt: "2026-09-01T10:00:00.000Z", cwd: "/work/proj/sub" }] })],
      post: async (_session, entry, metadata) => { posts.push({ entry, metadata }); return "ok"; },
      spacingMs: 0,
      importedAt: "2026-10-13T00:00:00.000Z",
    });
    expect(totals).toMatchObject({ sent: 1, sessions: 1, redactions: 1, stopped: null });
    expect(posts[0].entry).toMatchObject({ role: "user", text: "key [redacted]", occurredAt: "2026-09-01T10:00:00.000Z" });
    expect(posts[0].metadata).toEqual({
      client: "fake",
      cwd: "/work/proj/sub",
      session_id: "s1",
      origin: "import",
      import_id: expect.stringMatching(/^[a-f0-9]{24}$/),
      imported_at: "2026-10-13T00:00:00.000Z",
    });
    expect(posts[0].metadata).not.toHaveProperty("source");
  });

  it("stops at once when the account is out of credits", async () => {
    const results = ["ok", "outOfCredits"];
    let calls = 0;
    const totals = await uploadImport({
      sessions: [session()],
      post: async () => { calls += 1; return results.shift() ?? "ok"; },
      spacingMs: 0,
      wait: async () => {},
    });
    expect(calls).toBe(2);
    expect(totals).toMatchObject({ sent: 1, stopped: "out of MidBrain credits" });
  });

  it("backs off on rate limits, retries a failed store, and stops when it keeps failing", async () => {
    const waits = [];
    const results = ["rateLimited", "ok", "failed", "ok", "failed", "failed", "failed"];
    const totals = await uploadImport({
      sessions: [session()],
      post: async () => results.shift() ?? "ok",
      spacingMs: 0,
      wait: async (ms) => { waits.push(ms); },
    });
    // entry 1: rate limited once; entry 2: one failure, then stored; entry 3: fails 3 times.
    expect(waits).toEqual([2000, 2000, 2000, 4000]);
    expect(totals).toMatchObject({ sent: 2, sessions: 0, stopped: "store failed" });
  });
});

describe("prepareText and redaction", () => {
  it("redacts common credential shapes", () => {
    const input = [
      "sk-ant-api03-abcdefghijkl",
      "Authorization: Bearer abcdefghijklmnop",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "AKIAABCDEFGHIJKLMNOP",
      "DB_PASSWORD=hunter2hunter2",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const { text, count } = redactSecrets(input);
    expect(count).toBe(6);
    expect(text).toContain("DB_PASSWORD=[redacted]");
    expect(text).not.toMatch(/abcdefghijkl|hunter2|AKIAABCD|BEGIN OPENSSH/);
  });

  it("redacts URL passwords, Stripe keys, JWTs and Basic credentials, but not counts", () => {
    const input = [
      "postgres://app:s3cretpass@db:5432/main",
      "sk_live_abcdefghij1234",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
      "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    ].join("\n");
    const { text, count } = redactSecrets(input);
    expect(count).toBe(4);
    expect(text).toContain("postgres://app:[redacted]@db:5432/main");
    expect(text).not.toMatch(/s3cretpass|abcdefghij1234|eyJzdWIi|dXNlcjpw/);
    for (const plain of ["max_tokens=4096", "token_count: 1234567", "tokenizer: cl100k_base_x", "https://example.com/a:b@c"]) {
      expect(redactSecrets(plain)).toEqual({ text: plain, count: 0 });
    }
  });

  it("strips injected MidBrain context and caps length", () => {
    const long = prepareText("x".repeat(MAX_TEXT_CHARS + 10));
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(MAX_TEXT_CHARS);
  });
});

describe("summarize", () => {
  it("counts entries and skip reasons per client", () => {
    const summary = summarize([session(), session({ skip: "already imported" })]);
    expect(summary.fake).toMatchObject({ sessions: 1, user: 2, assistant: 2, first: "2026-09-01T10:00:00.000Z", skipped: { "already imported": 1 } });
  });
});

describe("import CLI", () => {
  function capture() {
    let text = "";
    return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
  }

  it("parses and validates options", () => {
    expect(parseImportArgs(["--client", "claude", "--since", "2026-09-01", "--apply"])).toMatchObject({
      clients: ["claude"], since: "2026-09-01T00:00:00.000Z", apply: true, yes: false, dream: false,
    });
    expect(() => parseImportArgs(["--client", "nope"])).toThrow(/unsupported client/);
    expect(() => parseImportArgs(["--since", "yesterday"])).toThrow(/--since/);
  });

  it("accepts --flag=value and rejects unknown arguments, so no filter is dropped", () => {
    expect(parseImportArgs(["--since=2026-09-01", "--client=claude", "--apply"])).toMatchObject({
      clients: ["claude"], since: "2026-09-01T00:00:00.000Z", apply: true,
    });
    expect(() => parseImportArgs(["--sinse", "2026-09-01", "--apply"])).toThrow(/unknown argument: --sinse/);
    expect(() => parseImportArgs(["--since"])).toThrow(/--since requires a value/);
    expect(() => parseImportArgs(["--client=", "--apply"])).toThrow(/--client requires a value/);
  });

  it("previews offline without uploading", async () => {
    const err = capture();
    const out = capture();
    const file = writeClaude(claudeRows());
    const old = new Date(Date.now() - ACTIVE_SESSION_MS * 2);
    fs.utimesSync(file, old, old);
    const readers = { claude: { list: () => [file], read: readClaudeSession } };
    const code = await runImportCli(["--client", "claude", "--offline"], { readers, err, out });
    expect(code).toBe(0);
    expect(err.text).toContain("claude: 1 session(s), 2 prompt(s) + 2 reply(ies) = 4 entries");
    expect(err.text).toContain("Preview only");
    expect(out.text).toBe("");
  });

  function applyFixture() {
    const file = writeClaude(claudeRows());
    const old = new Date(Date.now() - ACTIVE_SESSION_MS * 2);
    fs.utimesSync(file, old, old);
    return { claude: { list: () => [file], read: readClaudeSession } };
  }

  function fakeApi(results) {
    const posts = [];
    const api = {
      keyScope: "client",
      listEpisodicForSession: async () => [],
      postEpisodicResult: async (text, role) => { posts.push({ text, role }); return results.shift() ?? "ok"; },
    };
    return { apiFor: async () => api, posts, api };
  }

  it("refuses --apply without a terminal or --yes, and stops when declined", async () => {
    const { apiFor, posts } = fakeApi([]);
    const err = capture();
    expect(await runImportCli(["--client", "claude", "--apply"], { readers: applyFixture(), err, out: capture(), apiFor, isTTY: false })).toBe(2);
    expect(err.text).toContain("needs confirmation");
    const declined = capture();
    expect(await runImportCli(["--client", "claude", "--apply"], {
      readers: applyFixture(), err: declined, out: capture(), apiFor, isTTY: true, confirmFn: async () => false,
    })).toBe(1);
    expect(declined.text).toContain("Nothing was uploaded");
    expect(posts).toEqual([]);
  });

  it("uploads with --yes and reports the credits it needs", async () => {
    const { apiFor, posts } = fakeApi([]);
    const err = capture();
    const code = await runImportCli(["--client", "claude", "--apply", "--yes"], { readers: applyFixture(), err, out: capture(), apiFor, wait: async () => {} });
    expect(code).toBe(0);
    expect(err.text).toContain("this import needs 4 credits");
    expect(err.text).toContain("Imported 4 entries from 1 session(s)");
    expect(posts.map((post) => post.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("stops at once with exit 1 and how to resume when credits run out", async () => {
    const { apiFor, posts } = fakeApi(["ok", "outOfCredits"]);
    const err = capture();
    const code = await runImportCli(["--client", "claude", "--apply", "--yes"], { readers: applyFixture(), err, out: capture(), apiFor, wait: async () => {} });
    expect(code).toBe(1);
    expect(posts).toHaveLength(2);
    expect(err.text).toContain("out of credits");
    expect(err.text).toContain("run the same command again to continue");
  });

  it("retries a rate-limited check, and skips a session it still cannot check", async () => {
    const { apiFor, api } = fakeApi([]);
    const waits = [];
    let calls = 0;
    api.listEpisodicForSession = async () => { calls += 1; throw new Error("API 429 listing session memories"); };
    const err = capture();
    await runImportCli(["--client", "claude"], { readers: applyFixture(), err, out: capture(), apiFor, wait: async (ms) => { waits.push(ms); } });
    expect(calls).toBe(3);
    expect(waits).toEqual([2000, 4000]);
    expect(err.text).toContain("could not check MidBrain (API 429");
  });

  it("refuses --apply with --offline", async () => {
    const err = capture();
    expect(await runImportCli(["--apply", "--offline"], { err, out: capture() })).toBe(2);
    expect(err.text).toContain("drop --offline");
  });
});
