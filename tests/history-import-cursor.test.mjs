/**
 * Issue #75: Cursor history reader (desktop state.vscdb + agent transcripts).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSqlite } from "../shared/history-import/readers/common.mjs";
import { importId } from "../shared/history-import/plan.mjs";
import {
  listCursorSessions,
  listCursorTranscripts,
  readCursorSession,
  transcriptTimestamp,
} from "../shared/history-import/readers/cursor.mjs";

const sqlite = loadSqlite();

let root;
let userDir;
let home;
let dbFile;

function makeGlobalDb() {
  dbFile = path.join(userDir, "globalStorage", "state.vscdb");
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new sqlite.DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
      isArchived INTEGER, isSubagent INTEGER, value TEXT);
  `);
  return db;
}

function put(db, key, value) {
  db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)").run(key, JSON.stringify(value));
}

function addComposer(db, id, bubbles, extra = {}) {
  put(db, `composerData:${id}`, {
    _v: 18,
    createdAt: Date.parse("2026-10-01T09:00:00.000Z"),
    lastUpdatedAt: Date.parse("2026-10-01T10:00:00.000Z"),
    fullConversationHeadersOnly: bubbles.map((bubble, index) => ({ bubbleId: `b${index}`, type: bubble.type })),
    ...extra,
  });
  bubbles.forEach((bubble, index) => put(db, `bubbleId:${id}:b${index}`, bubble));
}

function addWorkspace(id, folder, composerIds) {
  const dir = path.join(userDir, "workspaceStorage", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workspace.json"), JSON.stringify({ folder: `file://${folder}` }));
  const db = new sqlite.DatabaseSync(path.join(dir, "state.vscdb"));
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  db.prepare("INSERT INTO ItemTable VALUES ('composer.composerData', ?)")
    .run(JSON.stringify({ allComposers: composerIds.map((composerId) => ({ composerId })) }));
  db.close();
}

const user = (text, createdAt) => ({ type: 1, text, createdAt });
const reply = (text, createdAt, extra = {}) => ({ type: 2, text, createdAt, ...extra });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-import-cursor-"));
  userDir = path.join(root, "Cursor", "User");
  home = path.join(root, ".cursor");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!sqlite)("Cursor desktop composers", () => {
  it("keeps each query and the last reply text, without tool calls, thinking or notices", async () => {
    const db = makeGlobalDb();
    addComposer(db, "c1", [
      user("<timestamp>Thu</timestamp>\n<user_query>\ncursor prompt one\n</user_query>", "2026-10-01T09:00:01.000Z"),
      reply("thinking", "2026-10-01T09:00:02.000Z", { thinking: { text: "x" }, capabilityType: 30 }),
      reply("Let me look.", "2026-10-01T09:00:03.000Z", { toolFormerData: { name: "read_file", toolCallId: "t1" }, capabilityType: 15 }),
      reply("cursor answer one", "2026-10-01T09:00:04.000Z"),
      user("<user_query>\n<system_notification>\ntask done\n</system_notification>\n</user_query>", "2026-10-01T09:00:05.000Z"),
      reply("noted", "2026-10-01T09:00:06.000Z"),
      user("", "2026-10-01T09:00:07.000Z"),
      { type: 1, richText: JSON.stringify({ root: { children: [{ type: "paragraph", children: [{ text: "rich prompt" }] }] } }), createdAt: "2026-10-01T09:01:00.000Z" },
      // An older composer's plain reply carries an empty toolFormerData.
      reply("rich answer", "2026-10-01T09:01:01.000Z", { toolFormerData: { additionalData: {} } }),
    ]);
    db.prepare("INSERT INTO composerHeaders VALUES (?, ?, ?, ?, 0, 0, ?)")
      .run("c1", "ws1", 0, Date.parse("2026-10-01T11:00:00.000Z"), JSON.stringify({ workspaceIdentifier: { uri: { fsPath: "/work/cursor" } } }));
    db.close();

    const session = await readCursorSession(`${dbFile}#c1`, { userDir, home });
    expect(session).toMatchObject({ client: "cursor", sessionId: "c1", cwd: "/work/cursor", skip: null, automated: false });
    expect(session.lastWrittenMs).toBe(Date.parse("2026-10-01T11:00:00.000Z"));
    expect(session.entries).toEqual([
      { role: "user", text: "cursor prompt one", occurredAt: "2026-10-01T09:00:01.000Z", cwd: "/work/cursor" },
      { role: "assistant", text: "cursor answer one", occurredAt: "2026-10-01T09:00:04.000Z", cwd: "/work/cursor" },
      { role: "user", text: "rich prompt", occurredAt: "2026-10-01T09:01:00.000Z", cwd: "/work/cursor" },
      { role: "assistant", text: "rich answer", occurredAt: "2026-10-01T09:01:01.000Z", cwd: "/work/cursor" },
    ]);
  });

  it("finds an older composer's folder in its workspace and fills missing times in order", async () => {
    const db = makeGlobalDb();
    addComposer(db, "old", [user("old prompt"), reply("old answer")], { _v: 9, lastUpdatedAt: undefined });
    db.close();
    addWorkspace("ws-old", "/work/legacy", ["old"]);

    const session = await readCursorSession(`${dbFile}#old`, { userDir, home });
    expect(session.cwd).toBe("/work/legacy");
    expect(session.entries.map((entry) => [entry.role, entry.occurredAt])).toEqual([
      ["user", "2026-10-01T09:00:00.000Z"],
      ["assistant", "2026-10-01T09:00:00.001Z"],
    ]);
  });

  it("gives every entry of an untimed composer its own time and import id", async () => {
    const db = makeGlobalDb();
    addComposer(db, "untimed", [user("one"), reply("a1"), user("two"), reply("a2"), user("three"), reply("a3")], { _v: 10 });
    db.close();

    const session = await readCursorSession(`${dbFile}#untimed`, { userDir, home });
    const ids = session.entries.map((entry) => importId(session, entry));
    expect(new Set(ids).size).toBe(6);
    expect(session.entries.map((entry) => entry.occurredAt)).toEqual(
      [0, 1, 2, 3, 4, 5].map((ms) => new Date(Date.parse("2026-10-01T09:00:00.000Z") + ms).toISOString()),
    );
  });

  it("ends a turn at an image-only prompt and takes the query after attached context", async () => {
    const db = makeGlobalDb();
    addComposer(db, "c2", [
      user("first prompt", "2026-10-01T09:00:00.000Z"),
      reply("first answer", "2026-10-01T09:00:01.000Z"),
      user("", "2026-10-01T09:00:02.000Z"),
      reply("about the image", "2026-10-01T09:00:03.000Z"),
      user("<attached_files>\nfile.ts\n</attached_files>\n<user_query>\nexplain this file\n</user_query>", "2026-10-01T09:01:00.000Z"),
      reply("It parses.", "2026-10-01T09:01:01.000Z"),
    ]);
    db.close();

    const session = await readCursorSession(`${dbFile}#c2`, { userDir, home });
    expect(session.entries.map((entry) => entry.text)).toEqual(["first prompt", "first answer", "explain this file", "It parses."]);
  });

  it("skips subagent and never-sent composers, and marks background-agent ones automated", async () => {
    const db = makeGlobalDb();
    addComposer(db, "sub", [user("x")], { subagentInfo: { parentComposerId: "c1" } });
    addComposer(db, "draft", []);
    addComposer(db, "bg", [user("x")], { createdFromBackgroundAgent: { id: "bc-1" } });
    // Cursor's placeholder for a chat it opened but never wrote; a value that
    // is not JSON is damage, not an empty chat.
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, NULL)").run("composerData:placeholder");
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run("composerData:broken", "{not json");
    db.close();

    const read = (id) => readCursorSession(`${dbFile}#${id}`, { userDir, home });
    expect((await read("sub")).skip).toBe("subagent session");
    expect((await read("draft")).skip).toBe("empty (never sent)");
    expect((await read("placeholder")).skip).toBe("empty (never sent)");
    expect((await read("broken")).skip).toBe("unreadable composer data");
    expect((await read("bg")).automated).toBe(true);
  });
});

describe("Cursor agent transcripts", () => {
  function writeTranscript(slug, id, rows) {
    const file = path.join(home, "projects", slug, "agent-transcripts", id, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    return file;
  }

  const row = (role, text) => ({ role, message: { content: [{ type: "text", text }] } });

  it("reads CLI runs the desktop store lacks, in order, with the chat's folder", async () => {
    const file = writeTranscript("work-cli", "cli-1", [
      row("user", "<git_status>clean</git_status>"),
      row("user", "<timestamp>Friday, October 16, 2026, 9:05 AM (UTC-5)</timestamp>\n<user_query>\ncli prompt one\n</user_query>"),
      { role: "assistant", message: { content: [{ type: "tool_use", name: "Shell" }] } },
      row("assistant", "cli answer one"),
      { type: "turn_ended", status: "success" },
      row("user", "<user_query>\ncli prompt two\n</user_query>"),
      row("assistant", "cli answer two"),
    ]);
    fs.utimesSync(file, new Date("2026-10-16T15:00:00.000Z"), new Date("2026-10-16T15:00:00.000Z"));
    fs.mkdirSync(path.join(home, "chats", "hash", "cli-1"), { recursive: true });
    fs.writeFileSync(path.join(home, "chats", "hash", "cli-1", "meta.json"), JSON.stringify({ cwd: "/work/cli" }));
    writeTranscript("work-cli", path.join("cli-1", "subagents", "sub"), [row("user", "subagent")]);

    expect(listCursorTranscripts(home)).toEqual([file]);
    const session = await readCursorSession(file, { userDir, home });
    expect(session).toMatchObject({ client: "cursor", sessionId: "cli-1", cwd: "/work/cli", automated: false });
    expect(session.entries.map((entry) => [entry.role, entry.text, entry.occurredAt])).toEqual([
      ["user", "cli prompt one", "2026-10-16T14:05:00.000Z"],
      ["assistant", "cli answer one", "2026-10-16T14:05:00.001Z"],
      ["user", "cli prompt two", "2026-10-16T14:05:00.002Z"],
      ["assistant", "cli answer two", "2026-10-16T14:05:00.003Z"],
    ]);
  });

  it("ends the turn at a corrupt row and refuses a transcript outside the projects folder", async () => {
    const file = writeTranscript("p", "cli-c", [row("user", "<user_query>\nfirst\n</user_query>"), row("assistant", "one")]);
    // Prompt two is lost; its reply must not replace reply one.
    fs.appendFileSync(file, "{\"role\":\"us\n" + JSON.stringify(row("assistant", "answer to the lost prompt")) + "\n");
    const session = await readCursorSession(file, { userDir, home });
    expect(session.entries.map((entry) => entry.text)).toEqual(["first", "one"]);
    const outside = path.join(home, "cli-x.jsonl");
    fs.writeFileSync(outside, `${JSON.stringify(row("user", "<user_query>\nx\n</user_query>"))}\n`);
    await expect(readCursorSession(outside, { userDir, home })).rejects.toMatchObject({ code: "EUNSAFE" });
  });

  it("times a transcript without <timestamp> from the chat start, so ids do not move as it grows", async () => {
    const file = writeTranscript("p", "cli-2", [row("user", "<user_query>\nfirst\n</user_query>"), row("assistant", "one")]);
    fs.mkdirSync(path.join(home, "chats", "h", "cli-2"), { recursive: true });
    fs.writeFileSync(path.join(home, "chats", "h", "cli-2", "meta.json"), JSON.stringify({ cwd: "/work/cli", createdAtMs: Date.parse("2026-10-10T08:00:00.000Z") }));
    const before = await readCursorSession(file, { userDir, home });

    fs.appendFileSync(file, `${JSON.stringify(row("user", "<user_query>\nsecond\n</user_query>"))}\n`);
    fs.utimesSync(file, new Date(), new Date());
    const after = await readCursorSession(file, { userDir, home });

    expect(before.entries.map((entry) => entry.occurredAt)).toEqual(["2026-10-10T08:00:00.000Z", "2026-10-10T08:00:00.001Z"]);
    expect(after.entries.slice(0, 2).map((entry) => importId(after, entry))).toEqual(before.entries.map((entry) => importId(before, entry)));
  });

  it("marks a run from a temp directory automated", async () => {
    const file = writeTranscript("tmp", "cli-tmp", [row("user", "hi")]);
    fs.mkdirSync(path.join(home, "chats", "h", "cli-tmp"), { recursive: true });
    fs.writeFileSync(path.join(home, "chats", "h", "cli-tmp", "meta.json"), JSON.stringify({ cwd: "/private/tmp/run" }));
    expect((await readCursorSession(file, { userDir, home })).automated).toBe(true);
  });

  it.skipIf(!sqlite)("lists desktop composers, then only transcripts the desktop store lacks", () => {
    const db = makeGlobalDb();
    addComposer(db, "both", [user("x")]);
    db.close();
    writeTranscript("p", "both", [row("user", "x")]);
    const cliOnly = writeTranscript("p", "cli-only", [row("user", "x")]);

    expect(listCursorSessions({ userDir, home })).toEqual([`${dbFile}#both`, cliOnly]);
  });

  it.skipIf(!sqlite)("lists an unreadable desktop store alone, so its chats are not imported from transcripts", () => {
    fs.mkdirSync(path.join(userDir, "globalStorage"), { recursive: true });
    const broken = path.join(userDir, "globalStorage", "state.vscdb");
    fs.writeFileSync(broken, "not a database");
    writeTranscript("p", "desktop-chat", [row("user", "x")]);

    expect(listCursorSessions({ userDir, home })).toEqual([broken]);
  });

  it("parses Cursor's <timestamp> line", () => {
    expect(transcriptTimestamp("<timestamp>Monday, January 5, 2026, 12:30 PM (UTC+1)</timestamp>")).toBe("2026-01-05T11:30:00.000Z");
    expect(transcriptTimestamp("<timestamp>Monday, January 5, 2026, 12:10 AM (UTC)</timestamp>")).toBe("2026-01-05T00:10:00.000Z");
    expect(transcriptTimestamp("no time")).toBeNull();
  });
});
