/**
 * Issue #75: OpenClaw history reader (SQLite transcripts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSqlite } from "../shared/history-import/readers/common.mjs";
import {
  listOpenClawDatabases,
  listOpenClawSessions,
  readOpenClawSession,
} from "../shared/history-import/readers/openclaw.mjs";

const sqlite = loadSqlite();

let stateDir;
let dbFile;

const SCHEMA = `
CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, created_via TEXT, created_actor_type TEXT, parent_session_key TEXT, spawned_by TEXT, entry_json TEXT);
CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT, reason TEXT, created_at INTEGER, updated_at INTEGER,
  transcript_updated_at INTEGER, acp_owned INTEGER, plugin_owner_id TEXT, hook_external_content_source TEXT, parent_session_key TEXT, spawned_by TEXT);
CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB, created_at INTEGER);
`;

function makeDb() {
  dbFile = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec(SCHEMA);
  return db;
}

function addSession(db, id, { key = `agent:main:explicit:${id}`, node = {}, window = {}, events = [] } = {}) {
  db.prepare("INSERT INTO session_nodes (session_key, created_via, created_actor_type, spawned_by, entry_json) VALUES (?, ?, ?, ?, ?)")
    .run(key, node.created_via ?? null, node.created_actor_type ?? null, node.spawned_by ?? null, node.entry_json ?? null);
  db.prepare("INSERT INTO session_windows (session_id, session_key, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, key, window.reason ?? null, 1_000, window.updated_at ?? 2_000);
  events.forEach((event, seq) => {
    const json = JSON.stringify(event);
    if (event.compress) {
      db.prepare("INSERT INTO transcript_events (session_id, seq, event_zstd, created_at) VALUES (?, ?, ?, ?)")
        .run(id, seq, zlib.zstdCompressSync(Buffer.from(json)), 1_500);
    } else {
      db.prepare("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)")
        .run(id, seq, json, 1_500);
    }
  });
}

const header = (timestamp = "2026-10-05T09:00:00.000Z") => ({ type: "session", version: 4, id: "x", timestamp, cwd: "/work/claw" });
const msg = (timestamp, role, content, extra = {}) => ({ type: "message", timestamp, message: { role, content, ...extra } });

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-import-openclaw-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe.skipIf(!sqlite || typeof zlib.zstdCompressSync !== "function")("readOpenClawSession", () => {
  it("keeps each prompt and the last reply text of its turn", async () => {
    const db = makeDb();
    addSession(db, "s1", {
      events: [
        header(),
        msg("2026-10-05T09:00:01.000Z", "user", "[Mon 2026-10-05 09:00 UTC] claw prompt one", { idempotencyKey: "k1" }),
        msg("2026-10-05T09:00:02.000Z", "assistant", [{ type: "text", text: "Looking." }, { type: "toolCall", id: "c1" }]),
        msg("2026-10-05T09:00:03.000Z", "toolResult", [{ type: "text", text: "tool output" }]),
        { ...msg("2026-10-05T09:00:04.000Z", "assistant", [{ type: "text", text: "claw answer one" }]), compress: true },
        msg("2026-10-05T09:00:05.000Z", "user", "claw prompt one", { idempotencyKey: "k1" }),
        msg("2026-10-05T09:01:00.000Z", "user", [{ type: "text", text: "claw prompt two" }], { idempotencyKey: "k2" }),
        msg("2026-10-05T09:01:01.000Z", "assistant", [{ type: "text", text: "NO_REPLY" }]),
      ],
    });
    db.close();

    const session = await readOpenClawSession(`${dbFile}#s1`);
    expect(session).toMatchObject({ client: "openclaw", sessionId: "s1", cwd: "/work/claw", skip: null, lastWrittenMs: 2_000 });
    expect(session.entries).toEqual([
      { role: "user", text: "claw prompt one", occurredAt: "2026-10-05T09:00:01.000Z", cwd: "/work/claw" },
      { role: "assistant", text: "claw answer one", occurredAt: "2026-10-05T09:00:04.000Z", cwd: "/work/claw" },
      { role: "user", text: "claw prompt two", occurredAt: "2026-10-05T09:01:00.000Z", cwd: "/work/claw" },
    ]);
  });

  it("skips cron, hook and spawned sessions", async () => {
    const db = makeDb();
    const events = [header(), msg("2026-10-05T09:00:01.000Z", "user", "tick")];
    addSession(db, "cron-run", { key: "agent:main:cron:daily", events });
    addSession(db, "via-cron", { node: { created_via: "cron" }, events });
    addSession(db, "spawned", { node: { spawned_by: "agent:main:main" }, events });
    db.close();

    const skips = [];
    for (const id of ["cron-run", "via-cron", "spawned"]) skips.push((await readOpenClawSession(`${dbFile}#${id}`)).skip);
    expect(skips).toEqual([
      "automated (cron, hook or plugin run)",
      "automated (cron, hook or plugin run)",
      "subagent session",
    ]);
  });

  it("links the Claude Code session a claude-cli backend ran", async () => {
    const db = makeDb();
    addSession(db, "cli", {
      node: { entry_json: JSON.stringify({ cliSessionIds: { "claude-cli": "c3c3ef58-claude" } }) },
      events: [header(), msg("2026-10-05T09:00:01.000Z", "user", "hello there")],
    });
    db.close();

    expect((await readOpenClawSession(`${dbFile}#cli`)).linkedSessionIds).toEqual(["c3c3ef58-claude"]);
  });

  it("links an unrecorded claude-cli backend session by prompt and time", async () => {
    const db = makeDb();
    addSession(db, "unlinked", { events: [header(), msg("2026-10-05T09:00:01.000Z", "user", "backend linked prompt")] });
    db.close();
    const projects = path.join(stateDir, "claude-projects");
    const dir = path.join(projects, "-work-claw");
    fs.mkdirSync(dir, { recursive: true });
    const row = (sessionId, at) => JSON.stringify({
      type: "user", sessionId, cwd: "/work/claw", timestamp: at, origin: { kind: "human" },
      message: { role: "user", content: "[Mon 2026-10-05 11:00 GMT+2] backend linked prompt" },
    });
    fs.writeFileSync(path.join(dir, "near.jsonl"), `${row("claude-near", "2026-10-05T09:00:03.000Z")}\n`);
    fs.writeFileSync(path.join(dir, "far.jsonl"), `${row("claude-far", "2026-10-05T12:00:00.000Z")}\n`);

    const session = await readOpenClawSession(`${dbFile}#unlinked`, { claudeProjects: projects });
    expect(session.linkedSessionIds).toEqual(["claude-near"]);
  });

  it("drops the parent history a fork starts with", async () => {
    const db = makeDb();
    addSession(db, "fork", {
      window: { reason: "fork" },
      events: [
        header("2026-10-06T00:00:00.000Z"),
        msg("2026-10-05T09:00:01.000Z", "user", "parent prompt"),
        msg("2026-10-06T00:00:01.000Z", "user", "fork prompt"),
      ],
    });
    db.close();

    const session = await readOpenClawSession(`${dbFile}#fork`);
    expect(session.entries.map((entry) => entry.text)).toEqual(["fork prompt"]);
  });

  it("lists one source per session in every agent database", () => {
    const db = makeDb();
    addSession(db, "a");
    addSession(db, "b");
    db.close();

    expect(listOpenClawDatabases(stateDir)).toEqual([dbFile]);
    expect(listOpenClawSessions([dbFile])).toEqual([`${dbFile}#a`, `${dbFile}#b`]);
    expect(listOpenClawSessions([path.join(stateDir, "missing.sqlite")])).toEqual([]);
  });
});
