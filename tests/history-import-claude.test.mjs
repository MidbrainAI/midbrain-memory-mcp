/**
 * Issue #75: Claude Code history reader.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listClaudeSessionFiles, readClaudeSession } from "../shared/history-import/readers/claude.mjs";
import { ACTIVE_SESSION_MS } from "../shared/history-import/plan.mjs";
import { runImportCli } from "../shared/history-import/cli.mjs";

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-import-claude-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

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

describe("import CLI with Claude Code history", () => {
  it("previews a transcript without uploading", async () => {
    let errText = "";
    const err = { write: (chunk) => { errText += chunk; return true; } };
    const file = writeClaude(claudeRows());
    const old = new Date(Date.now() - ACTIVE_SESSION_MS * 2);
    fs.utimesSync(file, old, old);
    const readers = { claude: { list: () => [file], read: readClaudeSession } };
    const posts = [];
    const api = {
      effectiveApiBase: "https://example.test",
      keyFingerprint: "k1",
      listEpisodicForSession: async () => [],
      postImportedEpisodic: async (...args) => { posts.push(args); return "ok"; },
    };
    expect(await runImportCli(["--client", "claude"], { readers, err, apiFor: async () => api })).toBe(0);
    expect(errText).toContain("claude: 1 session(s), 2 prompt(s) + 2 reply(ies) = 4 entries");
    expect(posts).toEqual([]);
  });
});
