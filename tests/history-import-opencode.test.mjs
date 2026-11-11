/**
 * Issue #75: OpenCode history reader (SQLite).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSqlite } from "../shared/history-import/readers/common.mjs";
import {
  listOpenCodeDatabases,
  listOpenCodeSessions,
  openCodeDataDir,
  readOpenCodeSession,
} from "../shared/history-import/readers/opencode.mjs";

const sqlite = loadSqlite();

let dir;
let dbFile;

const SCHEMA = `
CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, permission TEXT,
  time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_updated INTEGER, data TEXT);
`;

const T = Date.parse("2026-10-06T08:00:00.000Z");
const RUN_PERMISSION = JSON.stringify([
  { permission: "question", pattern: "*", action: "deny" },
  { permission: "plan_enter", pattern: "*", action: "deny" },
]);

function makeDb(file = path.join(dir, "opencode", "opencode.db")) {
  dbFile = file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

function addSession(db, id, { parent = null, permission = null, archived = null, updated = T + 60_000 } = {}) {
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, parent, "/work/oc", permission, T, updated, archived);
}

const user = (id, at, parts) => [id, { role: "user", time: { created: T + at } }, parts];
const reply = (id, parentID, at, text) => [id, {
  role: "assistant", parentID, finish: "stop", time: { created: T + at, completed: T + at + 500 },
}, [{ type: "text", text }]];
const summary = (id, parentID, at) => [id, {
  role: "assistant", parentID, summary: true, finish: "stop", time: { created: T + at, completed: T + at + 500 },
}, [{ type: "text", text: "summary of the work so far" }]];

let seq = 0;
function addMessage(db, sessionId, id, data, parts) {
  db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(id, sessionId, data.time.created, data.time.completed ?? data.time.created, JSON.stringify(data));
  for (const part of parts) {
    seq += 1;
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?)").run(`prt_${String(seq).padStart(4, "0")}`, id, sessionId, T, JSON.stringify(part));
  }
}

function addTurn(db, sessionId) {
  addMessage(db, sessionId, "msg_u1", { role: "user", time: { created: T + 1_000 } }, [
    { type: "text", text: "opencode prompt one" },
    { type: "text", text: "<system-reminder>added by a plugin</system-reminder>", synthetic: true },
  ]);
  addMessage(db, sessionId, "msg_a1", {
    role: "assistant", parentID: "msg_u1", finish: "tool-calls", path: { cwd: "/work/oc/pkg" }, time: { created: T + 2_000, completed: T + 3_000 },
  }, [{ type: "text", text: "Let me check." }, { type: "tool", tool: "bash" }]);
  addMessage(db, sessionId, "msg_a2", {
    role: "assistant", parentID: "msg_u1", finish: "stop", path: { cwd: "/work/oc/pkg" }, time: { created: T + 4_000, completed: T + 5_000 },
  }, [
    { type: "reasoning", text: "thinking" },
    { type: "text", text: "interim", metadata: { openai: { phase: "commentary" } } },
    { type: "text", text: "opencode answer one", metadata: { openai: { phase: "final_answer" } } },
  ]);
  addMessage(db, sessionId, "msg_u2", { role: "user", time: { created: T + 10_000 } }, [{ type: "text", text: "unanswered prompt" }]);
  addMessage(db, sessionId, "msg_a3", {
    role: "assistant", parentID: "msg_u2", error: { name: "APIError" }, time: { created: T + 11_000, completed: T + 12_000 },
  }, [{ type: "text", text: "partial" }]);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-import-opencode-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!sqlite)("readOpenCodeSession", () => {
  it("keeps typed prompts and the final reply of each turn", async () => {
    const db = makeDb();
    addSession(db, "ses_1");
    addTurn(db, "ses_1");
    db.close();

    const session = await readOpenCodeSession(`${dbFile}#ses_1`);
    expect(session).toMatchObject({ client: "opencode", sessionId: "ses_1", cwd: "/work/oc", skip: null, automated: false });
    expect(session.lastWrittenMs).toBe(T + 60_000);
    expect(session.entries).toEqual([
      { role: "user", text: "opencode prompt one", occurredAt: new Date(T + 1_000).toISOString(), cwd: "/work/oc/pkg" },
      { role: "assistant", text: "opencode answer one", occurredAt: new Date(T + 5_000).toISOString(), cwd: "/work/oc/pkg" },
      { role: "user", text: "unanswered prompt", occurredAt: new Date(T + 10_000).toISOString(), cwd: "/work/oc" },
    ]);
  });

  it("ends a turn that continues after compaction with its final reply, and keeps an interrupted reply", async () => {
    const db = makeDb();
    addSession(db, "ses_c");
    addMessage(db, "ses_c", "msg_u1", { role: "user", time: { created: T + 1_000 } }, [{ type: "text", text: "long task prompt" }]);
    addMessage(db, "ses_c", "msg_a1", {
      role: "assistant", parentID: "msg_u1", finish: "tool-calls", time: { created: T + 2_000, completed: T + 3_000 },
    }, [{ type: "tool", tool: "bash" }]);
    addMessage(db, "ses_c", "msg_u2", { role: "user", time: { created: T + 4_000 } }, [{ type: "compaction", auto: true }]);
    addMessage(db, "ses_c", "msg_a2", {
      role: "assistant", parentID: "msg_u2", summary: true, finish: "stop", time: { created: T + 5_000, completed: T + 6_000 },
    }, [{ type: "text", text: "summary of the work so far" }]);
    addMessage(db, "ses_c", "msg_u3", { role: "user", time: { created: T + 7_000 } }, [{ type: "text", text: "Continue if you have next steps", synthetic: true }]);
    addMessage(db, "ses_c", "msg_a3", {
      role: "assistant", parentID: "msg_u3", finish: "stop", time: { created: T + 8_000, completed: T + 9_000 },
    }, [{ type: "text", text: "task done" }]);
    addMessage(db, "ses_c", "msg_u4", { role: "user", time: { created: T + 10_000 } }, [{ type: "text", text: "second prompt" }]);
    addMessage(db, "ses_c", "msg_a4", {
      role: "assistant", parentID: "msg_u4", error: { name: "MessageAbortedError" }, time: { created: T + 11_000 },
    }, [{ type: "text", text: "partial answer" }]);
    db.close();

    const session = await readOpenCodeSession(`${dbFile}#ses_c`);
    expect(session.entries.map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "long task prompt"],
      ["assistant", "task done"],
      ["user", "second prompt"],
      ["assistant", "partial answer"],
    ]);
  });

  it("keeps a prompt replayed after an overflow compaction once, with the final reply", async () => {
    const db = makeDb();
    addSession(db, "ses_o");
    for (const message of [
      user("msg_u1", 1_000, [{ type: "text", text: "describe this screenshot" }, { type: "file", mime: "image/png", filename: "x.png" }]),
      user("msg_u2", 2_000, [{ type: "compaction", auto: true, overflow: true }]),
      summary("msg_a2", "msg_u2", 3_000),
      // OpenCode's replay: the typed text copied, the image as a note.
      user("msg_u3", 4_000, [{ type: "text", text: "describe this screenshot" }, { type: "text", text: "[Attached image/png: x.png]" }]),
      reply("msg_a3", "msg_u3", 5_000, "a login form"),
    ]) addMessage(db, "ses_o", ...message);
    db.close();

    const session = await readOpenCodeSession(`${dbFile}#ses_o`);
    expect(session.entries.map((entry) => [entry.role, entry.text, entry.occurredAt])).toEqual([
      ["user", "describe this screenshot", new Date(T + 1_000).toISOString()],
      ["assistant", "a login form", new Date(T + 5_500).toISOString()],
    ]);
  });

  it("keeps a replayed prompt that was only an image with the prompt before it", async () => {
    const db = makeDb();
    addSession(db, "ses_i");
    for (const message of [
      user("msg_u1", 1_000, [{ type: "text", text: "compare these" }]),
      user("msg_u2", 2_000, [{ type: "file", mime: "image/png", filename: "b.png" }]),
      user("msg_u3", 3_000, [{ type: "compaction", auto: true, overflow: true }]),
      summary("msg_a3", "msg_u3", 4_000),
      user("msg_u4", 5_000, [{ type: "text", text: "[Attached image/png: b.png]" }]),
      reply("msg_a4", "msg_u4", 6_000, "they match"),
    ]) addMessage(db, "ses_i", ...message);
    db.close();

    const session = await readOpenCodeSession(`${dbFile}#ses_i`);
    expect(session.entries.map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "compare these"],
      ["assistant", "they match"],
    ]);
  });

  it("keeps a prompt typed again after a manual /compact", async () => {
    const db = makeDb();
    addSession(db, "ses_m");
    for (const message of [
      user("msg_u1", 1_000, [{ type: "text", text: "run the tests" }]),
      reply("msg_a1", "msg_u1", 2_000, "3 failed"),
      user("msg_u2", 3_000, [{ type: "compaction", auto: false }]),
      summary("msg_a2", "msg_u2", 4_000),
      user("msg_u3", 5_000, [{ type: "text", text: "run the tests" }]),
      reply("msg_a3", "msg_u3", 6_000, "all passed"),
    ]) addMessage(db, "ses_m", ...message);
    db.close();

    const session = await readOpenCodeSession(`${dbFile}#ses_m`);
    expect(session.entries.map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "run the tests"],
      ["assistant", "3 failed"],
      ["user", "run the tests"],
      ["assistant", "all passed"],
    ]);
  });

  it("takes the last write from the session, its messages or its parts", async () => {
    const db = makeDb();
    addSession(db, "ses_w");
    addMessage(db, "ses_w", ...reply("msg_a1", "msg_u1", 120_000, "late"));
    db.close();
    expect((await readOpenCodeSession(`${dbFile}#ses_w`)).lastWrittenMs).toBe(T + 120_500);
  });

  it("marks opencode run sessions automated and skips subagent sessions", async () => {
    const db = makeDb();
    addSession(db, "ses_run", { permission: RUN_PERMISSION });
    addSession(db, "ses_child", { parent: "ses_1" });
    db.close();

    expect((await readOpenCodeSession(`${dbFile}#ses_run`)).automated).toBe(true);
    expect((await readOpenCodeSession(`${dbFile}#ses_child`)).skip).toBe("subagent session");
  });

  it("lists every session, archived ones too, and nothing without a database", () => {
    const db = makeDb();
    addSession(db, "ses_1");
    addSession(db, "ses_old", { archived: T });
    db.close();

    expect(listOpenCodeSessions([dbFile])).toEqual([`${dbFile}#ses_1`, `${dbFile}#ses_old`]);
    expect(listOpenCodeDatabases({ XDG_DATA_HOME: path.join(dir, "none") })).toEqual([]);
    expect(openCodeDataDir({ XDG_DATA_HOME: "/data" })).toBe(path.join("/data", "opencode"));
    // An unreadable database is listed as is, so the preview reports it.
    const corrupt = path.join(dir, "corrupt.db");
    fs.writeFileSync(corrupt, "not a database");
    expect(listOpenCodeSessions([corrupt])).toEqual([corrupt]);
  });

  it("finds channel databases and OPENCODE_DB, absolute or relative to the data dir", () => {
    const dataDir = path.join(dir, "opencode");
    const main = path.join(dataDir, "opencode.db");
    const channel = path.join(dataDir, "opencode-dev.db");
    const relative = path.join(dataDir, "custom", "mine.sqlite");
    const absolute = path.join(dir, "elsewhere", "oc.sqlite");
    for (const file of [main, channel, relative, absolute]) makeDb(file).close();
    fs.writeFileSync(`${main}-wal`, "");
    fs.writeFileSync(path.join(dataDir, "opencode.db-shm"), "");
    const env = { XDG_DATA_HOME: dir };

    expect(listOpenCodeDatabases(env).sort()).toEqual([channel, main].sort());
    expect(listOpenCodeDatabases({ ...env, OPENCODE_DB: absolute })).toContain(absolute);
    expect(listOpenCodeDatabases({ ...env, OPENCODE_DB: path.join("custom", "mine.sqlite") })).toContain(relative);
    expect(listOpenCodeDatabases({ ...env, OPENCODE_DB: ":memory:" }).sort()).toEqual([channel, main].sort());
    expect(listOpenCodeDatabases({ ...env, OPENCODE_DB: "opencode.db" }).filter((file) => file === main)).toHaveLength(1);
  });

  it("lists a session found in two databases once, from the one that wrote it last", () => {
    const older = path.join(dir, "opencode", "opencode.db");
    const newer = path.join(dir, "copy", "opencode.db");
    let db = makeDb(older);
    addSession(db, "ses_1", { updated: T + 1_000 });
    addSession(db, "ses_2");
    db.close();
    db = makeDb(newer);
    addSession(db, "ses_1", { updated: T + 9_000 });
    db.close();

    expect(listOpenCodeSessions([older, newer])).toEqual([`${newer}#ses_1`, `${older}#ses_2`]);
  });
});
