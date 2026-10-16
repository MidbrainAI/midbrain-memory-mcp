/**
 * Issue #75: Hermes Agent history reader (SQLite).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSqlite } from "../shared/history-import/readers/common.mjs";
import {
  hermesHome,
  listHermesDatabases,
  listHermesSessions,
  readHermesSession,
} from "../shared/history-import/readers/hermes.mjs";

const sqlite = loadSqlite();

let home;

const SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model_config TEXT, cwd TEXT, parent_session_id TEXT,
  started_at REAL, ended_at REAL, last_activity_at REAL, hidden INTEGER DEFAULT 0, end_reason TEXT);
CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, api_content TEXT,
  tool_calls TEXT, timestamp REAL, display_kind TEXT, active INTEGER DEFAULT 1, _compressed_summary INTEGER DEFAULT 0);
`;

const T = Date.parse("2026-10-06T09:00:00.000Z") / 1000;
const iso = (seconds) => new Date(seconds * 1000).toISOString();

function makeDb(dir = home) {
  const file = path.join(dir, "state.db");
  fs.mkdirSync(dir, { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(SCHEMA);
  return { db, file };
}

function addSession(db, id, { source = "cli", config = null, hidden = 0 } = {}) {
  db.prepare("INSERT INTO sessions (id, source, model_config, cwd, started_at, last_activity_at, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, source, config, "/work/hermes", T, T + 60, hidden);
}

function addMessage(db, sessionId, role, content, at, extra = {}) {
  db.prepare("INSERT INTO messages (session_id, role, content, api_content, tool_calls, timestamp, display_kind, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(sessionId, role, content, extra.api_content ?? null, extra.tool_calls ?? null, at, extra.display_kind ?? null, extra.active ?? 1);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-import-hermes-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!sqlite)("readHermesSession", () => {
  it("keeps typed prompts and each turn's final reply, never the added context", async () => {
    const { db, file } = makeDb();
    addSession(db, "h1");
    addMessage(db, "h1", "user", "hermes prompt one", T + 1, { api_content: "hermes prompt one\n\n## Agent persona\nadded" });
    addMessage(db, "h1", "assistant", "Checking.", T + 2, { tool_calls: JSON.stringify([{ id: "c1" }]) });
    addMessage(db, "h1", "tool", "tool output", T + 3);
    addMessage(db, "h1", "assistant", "hermes answer one", T + 4);
    addMessage(db, "h1", "user", "continue", T + 5, { display_kind: "auto_continue" });
    addMessage(db, "h1", "assistant", "more work", T + 6);
    addMessage(db, "h1", "user", "rewound prompt", T + 7, { active: 0 });
    addMessage(db, "h1", "user", `\u0000json:${JSON.stringify([{ type: "text", text: "hermes prompt two" }, { type: "image_url" }])}`, T + 8);
    addMessage(db, "h1", "assistant", "failed", T + 9, { display_kind: "failed_turn" });
    db.close();

    const session = await readHermesSession(`${file}#h1`);
    expect(session).toMatchObject({ client: "hermes", sessionId: "h1", cwd: "/work/hermes", skip: null, automated: false });
    expect(session.lastWrittenMs).toBe((T + 60) * 1000);
    expect(session.entries).toEqual([
      { role: "user", text: "hermes prompt one", occurredAt: iso(T + 1), cwd: "/work/hermes" },
      { role: "assistant", text: "hermes answer one", occurredAt: iso(T + 4), cwd: "/work/hermes" },
      { role: "user", text: "hermes prompt two", occurredAt: iso(T + 8), cwd: "/work/hermes" },
    ]);
  });

  it("ends a turn at an image-only prompt, so its reply is not filed under the previous one", async () => {
    const { db, file } = makeDb();
    addSession(db, "img");
    addMessage(db, "img", "user", "text prompt", T + 1);
    addMessage(db, "img", "assistant", "text answer", T + 2);
    addMessage(db, "img", "user", `\u0000json:${JSON.stringify([{ type: "image_url" }])}`, T + 3);
    addMessage(db, "img", "assistant", "image answer", T + 4);
    db.close();

    const session = await readHermesSession(`${file}#img`);
    expect(session.entries.map((entry) => entry.text)).toEqual(["text prompt", "text answer"]);
  });

  it("skips the parent's tail a session continued after compression starts with", async () => {
    const { db, file } = makeDb();
    addSession(db, "parent");
    db.prepare("UPDATE sessions SET end_reason = 'compression' WHERE id = 'parent'").run();
    addMessage(db, "parent", "user", "before compression", T + 1);
    addMessage(db, "parent", "assistant", "early answer", T + 2);
    addSession(db, "child");
    db.prepare("UPDATE sessions SET parent_session_id = 'parent' WHERE id = 'child'").run();
    addMessage(db, "child", "user", "before compression", T + 10);
    addMessage(db, "child", "assistant", "early answer", T + 11);
    addMessage(db, "child", "user", "after compression", T + 20);
    addMessage(db, "child", "assistant", "late answer", T + 21);
    db.close();

    const session = await readHermesSession(`${file}#child`);
    expect(session.entries.map((entry) => entry.text)).toEqual(["after compression", "late answer"]);
  });

  it("reads an older state.db without the newer message columns", async () => {
    const file = path.join(home, "state.db");
    const db = new sqlite.DatabaseSync(file);
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model_config TEXT, cwd TEXT, parent_session_id TEXT,
      started_at REAL, ended_at REAL, last_activity_at REAL, hidden INTEGER DEFAULT 0);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL);`);
    addSession(db, "old");
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)").run("old", "user", "old prompt", T + 1);
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)").run("old", "assistant", "old answer", T + 2);
    db.close();

    const session = await readHermesSession(`${file}#old`);
    expect(session.entries.map((entry) => entry.text)).toEqual(["old prompt", "old answer"]);
  });

  it("marks one-shot and cron runs automated, and skips delegated and hidden sessions", async () => {
    const { db, file } = makeDb();
    addSession(db, "oneshot", { source: "oneshot" });
    addSession(db, "cron", { source: "cron" });
    addSession(db, "child", { config: JSON.stringify({ _delegate_from: "h1" }) });
    addSession(db, "sub", { source: "subagent" });
    addSession(db, "api", { source: "api_server" });
    addSession(db, "hidden", { hidden: 1 });
    db.close();

    const read = async (id) => readHermesSession(`${file}#${id}`);
    expect((await read("oneshot")).automated).toBe(true);
    expect((await read("cron")).automated).toBe(true);
    expect((await read("child")).skip).toBe("subagent session");
    expect((await read("sub")).skip).toBe("subagent session");
    expect((await read("api")).automated).toBe(true);
    expect((await read("hidden")).skip).toBe("hidden in Hermes");
  });

  it("lists the main and profile databases", () => {
    const main = makeDb();
    addSession(main.db, "a");
    main.db.close();
    const profile = makeDb(path.join(home, "profiles", "work"));
    addSession(profile.db, "b");
    profile.db.close();

    expect(listHermesDatabases(home)).toEqual([main.file, profile.file]);
    expect(listHermesSessions([main.file, profile.file])).toEqual([`${main.file}#a`, `${profile.file}#b`]);
    expect(hermesHome({ HERMES_HOME: "/h" })).toBe("/h");
  });
});
