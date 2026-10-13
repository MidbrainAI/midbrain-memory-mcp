/**
 * Issue #75: opt-in import of existing local conversation history.
 * Readers, planning, server-side dedupe, upload and the CLI preview.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listClaudeSessionFiles,
  listCodexSessionFiles,
  readClaudeSession,
  readCodexSession,
} from "../shared/history-import/readers.mjs";
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

function codexRows({ subagent = false } = {}) {
  return [
    { type: "session_meta", timestamp: "2026-10-06T07:00:00.000Z", payload: { id: "codex-session", cwd: "/work/codex", source: subagent ? { subagent: { thread_spawn: {} } } : "vscode" } },
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
  it("keeps the typed prompt and final answer per turn, without injected context", async () => {
    const file = writeJsonl(path.join(dir, "codex", "sessions", "2026", "10", "06", "rollout-a.jsonl"), codexRows());
    const session = await readCodexSession(file);
    expect(session).toMatchObject({ client: "codex", sessionId: "codex-session", cwd: "/work/codex", skip: null });
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

  it("backs off on rate limits and stops at a failure so a re-run resumes", async () => {
    const waits = [];
    const results = ["rateLimited", "ok", "failed"];
    const totals = await uploadImport({
      sessions: [session()],
      post: async () => results.shift() ?? "ok",
      spacingMs: 0,
      wait: async (ms) => { waits.push(ms); },
    });
    expect(waits).toEqual([2000]);
    expect(totals).toMatchObject({ sent: 1, sessions: 0, stopped: "store failed" });
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

  it("refuses --apply with --offline", async () => {
    const err = capture();
    expect(await runImportCli(["--apply", "--offline"], { err, out: capture() })).toBe(2);
    expect(err.text).toContain("drop --offline");
  });
});
