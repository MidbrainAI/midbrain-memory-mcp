/**
 * Issue #75: OpenCode history reader (SQLite).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSqlite } from "../shared/history-import/readers/common.mjs";
import {
  listOpenCodeSessions,
  openCodeDatabase,
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

function makeDb() {
  dbFile = path.join(dir, "opencode", "opencode.db");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec(SCHEMA);
  return db;
}

function addSession(db, id, { parent = null, permission = null, archived = null } = {}) {
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, parent, "/work/oc", permission, T, T + 60_000, archived);
}

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

    expect(listOpenCodeSessions(dbFile)).toEqual([`${dbFile}#ses_1`, `${dbFile}#ses_old`]);
    expect(listOpenCodeSessions(path.join(dir, "none", "opencode.db"))).toEqual([]);
    expect(openCodeDatabase({ XDG_DATA_HOME: "/data" })).toBe(path.join("/data", "opencode", "opencode.db"));
  });
});
