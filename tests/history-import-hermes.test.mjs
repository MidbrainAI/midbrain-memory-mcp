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
  started_at REAL, ended_at REAL, last_activity_at REAL, hidden INTEGER DEFAULT 0);
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
      { role: "assistant", text: "more work", occurredAt: iso(T + 6), cwd: "/work/hermes" },
      { role: "user", text: "hermes prompt two", occurredAt: iso(T + 8), cwd: "/work/hermes" },
    ]);
  });

  it("marks one-shot and cron runs automated, and skips delegated and hidden sessions", async () => {
    const { db, file } = makeDb();
    addSession(db, "oneshot", { source: "oneshot" });
    addSession(db, "cron", { source: "cron" });
    addSession(db, "child", { config: JSON.stringify({ _delegate_from: "h1" }) });
    addSession(db, "sub", { source: "subagent" });
    addSession(db, "hidden", { hidden: 1 });
    db.close();

    const read = async (id) => readHermesSession(`${file}#${id}`);
    expect((await read("oneshot")).automated).toBe(true);
    expect((await read("cron")).automated).toBe(true);
    expect((await read("child")).skip).toBe("subagent session");
    expect((await read("sub")).skip).toBe("subagent session");
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
