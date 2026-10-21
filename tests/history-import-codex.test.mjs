/**
 * Issue #75: Codex history reader.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listCodexSessionFiles, readCodexSession } from "../shared/history-import/readers/codex.mjs";

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-import-codex-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const codexDirs = () => [path.join(dir, "codex", "sessions"), path.join(dir, "codex", "archived_sessions")];

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
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

describe("readCodexSession", () => {
  it("marks codex exec runs as automated", async () => {
    const file = writeJsonl(path.join(dir, "codex", "sessions", "rollout-exec.jsonl"), codexRows({ source: "exec" }));
    expect((await readCodexSession(file, codexDirs())).automated).toBe(true);
  });

  it("keeps the typed prompt and final answer per turn, without injected context or goal turns", async () => {
    const file = writeJsonl(path.join(dir, "codex", "sessions", "2026", "10", "06", "rollout-a.jsonl"), codexRows());
    const session = await readCodexSession(file, codexDirs());
    expect(session).toMatchObject({ client: "codex", sessionId: "codex-session", cwd: "/work/codex", skip: null, automated: false });
    expect(session.entries).toEqual([
      { role: "user", text: "codex prompt one", occurredAt: "2026-10-06T07:00:01.300Z", cwd: "/work/codex" },
      { role: "assistant", text: "codex answer one", occurredAt: "2026-10-06T07:00:03.000Z", cwd: "/work/codex" },
      { role: "user", text: "codex prompt two", occurredAt: "2026-10-06T07:01:00.200Z", cwd: "/work/codex/sub" },
      { role: "assistant", text: "fallback answer two", occurredAt: "2026-10-06T07:01:05.000Z", cwd: "/work/codex/sub" },
    ]);
  });

  it("skips threads spawned by another agent", async () => {
    const file = writeJsonl(path.join(dir, "codex", "sessions", "rollout-sub.jsonl"), codexRows({ subagent: true }));
    expect((await readCodexSession(file, codexDirs())).skip).toBe("subagent session");
  });

  it("ends the turn at a corrupt row and refuses a rollout outside the history folders", async () => {
    const rows = codexRows().slice(0, 7).map((row) => JSON.stringify(row));
    // The final answer row of turn one is lost; nothing may stand in for it.
    rows.push("{\"type\":\"response_item\",\"payload\":{\"type\":\"mess");
    rows.push(JSON.stringify(codexRows()[8]));
    const file = path.join(dir, "codex", "sessions", "rollout-c.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${rows.join("\n")}\n`);
    const session = await readCodexSession(file, codexDirs());
    // Commentary is never a reply, and nothing after the gap is trusted as one.
    expect(session.entries.map((entry) => [entry.role, entry.text])).toEqual([["user", "codex prompt one"]]);
    const outside = writeJsonl(path.join(dir, "rollout-out.jsonl"), codexRows());
    await expect(readCodexSession(outside, codexDirs())).rejects.toMatchObject({ code: "EUNSAFE" });
  });

  it("finds rollouts in dated and archived folders", () => {
    const dated = writeJsonl(path.join(dir, "codex", "sessions", "2026", "10", "06", "rollout-a.jsonl"), []);
    const archived = writeJsonl(path.join(dir, "codex", "archived_sessions", "rollout-b.jsonl"), []);
    writeJsonl(path.join(dir, "codex", "sessions", "2026", "10", "06", "other.jsonl"), []);
    const found = listCodexSessionFiles(codexDirs());
    expect(found.sort()).toEqual([archived, dated].sort());
  });
});
