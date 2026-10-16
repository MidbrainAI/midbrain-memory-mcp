/**
 * Cursor history reader (issue #75).
 *
 * Two stores, one session each:
 *
 * - The desktop app keeps every conversation ("composer") in its global
 *   `state.vscdb` (SQLite, table `cursorDiskKV`): `composerData:<id>` lists
 *   the conversation's messages in order (`fullConversationHeadersOnly`) and
 *   each message is `bubbleId:<id>:<bubble>` (type 1 user, 2 assistant). The
 *   composer id is the `conversation_id` the Cursor hooks capture with.
 * - Agent transcripts, `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`,
 *   cover CLI runs (`agent`, `agent -p`) that have no desktop composer. They
 *   have no per-message times, so entries take the file's time, kept in order.
 *
 * A turn is the user's query (Cursor's `<timestamp>`/`<user_query>` wrapper
 * removed, as the hooks do) and the last assistant text before the next one:
 * tool calls and thinking are left out. Subagent and best-of-N composers are
 * skipped; background-agent composers, and CLI runs from a temp directory,
 * count as automated.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { userQuery } from "../../../plugins/cursor/common.mjs";
import {
  databaseSource, jsonRows, loadSqlite, parseDatabaseSource, regularFiles, withReadOnlyDatabase,
} from "./common.mjs";

const DATABASE_NAME = "state.vscdb";
const USER = 1;
const ASSISTANT = 2;
// Assistant bubbles that are not the reply: tool calls (15) and thinking (30).
const NON_REPLY_CAPABILITIES = new Set([15, 30]);
// User rows Cursor writes itself: background-task notices and injected context.
const INJECTED_PROMPT = /^\s*<(?:system_notification|mcp_meta_tools|available_subagent_types|git_status|dynamic_tools|user_info|rules|attached_files)[\s>]/;
const TEMP_DIRS = ["/tmp/", "/private/tmp/", "/private/var/folders/", "/var/folders/"];

/** Cursor's `User` dir for this platform. */
export function cursorUserDir(env = process.env, platform = process.platform) {
  if (env.CURSOR_USER_DATA_DIR?.trim()) return path.join(env.CURSOR_USER_DATA_DIR.trim(), "User");
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User");
  if (platform === "win32") return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Cursor", "User");
  return path.join(env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "Cursor", "User");
}

export function cursorHome(env = process.env) {
  return path.join(env.CURSOR_HOME?.trim() || os.homedir(), ".cursor");
}

function parseJson(value) {
  try {
    const text = value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : value;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function keyRange(db, prefix) {
  // A range on the key index; LIKE would scan the whole (multi-GB) table.
  return db.prepare("SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?").all(`${prefix}`, `${prefix}￿`);
}

function composerIds(db) {
  return db.prepare("SELECT key FROM cursorDiskKV WHERE key >= ? AND key < ?")
    .all("composerData:", "composerData;")
    .map((row) => row.key.slice("composerData:".length));
}

/** Transcript files: `<slug>/agent-transcripts/<id>/<id>.jsonl` (subagent files excluded). */
export function listCursorTranscripts(home = cursorHome()) {
  const projects = path.join(home, "projects");
  let slugs;
  try {
    slugs = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const root = path.join(projects, slug.name, "agent-transcripts");
    let ids;
    try {
      ids = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const id of ids) {
      if (id.isDirectory()) files.push(...regularFiles(path.join(root, id.name), (name) => name === `${id.name}.jsonl`));
      else if (id.isFile() && id.name.endsWith(".jsonl")) files.push(path.join(root, id.name));
    }
  }
  return files;
}

/**
 * Desktop composers as `<state.vscdb>#<id>`, then transcripts of sessions
 * the desktop store does not have. Without `node:sqlite` the database is
 * listed as is (unreadable) and every transcript is read.
 */
export function listCursorSessions({ userDir = cursorUserDir(), home = cursorHome() } = {}) {
  const [database] = regularFiles(path.join(userDir, "globalStorage"), (name) => name === DATABASE_NAME);
  const sources = [];
  let known = new Set();
  if (database && !loadSqlite()) sources.push(database);
  else if (database) {
    try {
      const ids = withReadOnlyDatabase(database, composerIds);
      known = new Set(ids);
      sources.push(...ids.map((id) => databaseSource(database, id)));
    } catch { /* unreadable: transcripts only */ }
  }
  for (const file of listCursorTranscripts(home)) {
    if (!known.has(path.basename(file, ".jsonl"))) sources.push(file);
  }
  return sources;
}

/** Plain text of a Lexical `richText` document, for bubbles without `text`. */
function richText(value) {
  const doc = typeof value === "string" ? parseJson(value) : value;
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.text === "string") out.push(node.text);
    if (Array.isArray(node.children)) {
      node.children.forEach(walk);
      if (node.type === "paragraph") out.push("\n");
    }
  };
  walk(doc?.root);
  return out.join("").trim();
}

function prompt(text) {
  if (!text || INJECTED_PROMPT.test(text)) return "";
  const query = userQuery(text);
  // Background-task notices also arrive inside the <user_query> wrapper.
  return INJECTED_PROMPT.test(query) ? "" : query;
}

function toIso(value) {
  const ms = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function folderPath(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return null;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return null;
  }
}

function workspaceFolder(userDir, workspaceId) {
  if (!workspaceId || !/^[A-Za-z0-9_-]+$/.test(workspaceId)) return null;
  const data = parseJson(safeRead(path.join(userDir, "workspaceStorage", workspaceId, "workspace.json")));
  return folderPath(data?.folder);
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

const workspaceMaps = new Map();

/**
 * Composer id -> workspace folder, from each workspace's own state.vscdb
 * (`composer.composerData.allComposers`). Older composers have no header row
 * with their workspace; this is where Cursor records it. Read once per run.
 */
export function composerWorkspaces(userDir) {
  if (workspaceMaps.has(userDir)) return workspaceMaps.get(userDir);
  const map = new Map();
  workspaceMaps.set(userDir, map);
  if (!loadSqlite()) return map;
  const root = path.join(userDir, "workspaceStorage");
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const folder = workspaceFolder(userDir, dir.name);
    const [database] = folder ? regularFiles(path.join(root, dir.name), (name) => name === DATABASE_NAME) : [];
    if (!database) continue;
    try {
      const data = withReadOnlyDatabase(database, (db) => parseJson(
        db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get()?.value,
      ));
      for (const composer of Array.isArray(data?.allComposers) ? data.allComposers : []) {
        if (typeof composer?.composerId === "string") map.set(composer.composerId, folder);
      }
    } catch { /* unreadable workspace: skip it */ }
  }
  return map;
}

/**
 * A tool-call bubble names its tool. Older composers (schema 9 and 10) put an
 * empty `toolFormerData: { additionalData }` on plain replies too.
 */
function isToolCall(bubble) {
  const tool = bubble.toolFormerData;
  return Boolean(tool && (tool.name || tool.tool || tool.toolCallId));
}

function headerRow(db, id) {
  try {
    return db.prepare("SELECT * FROM composerHeaders WHERE composerId = ?").get(id) ?? null;
  } catch {
    return null; // older Cursor: no composerHeaders table
  }
}

function isTemp(cwd) {
  return typeof cwd === "string" && [...TEMP_DIRS, `${os.tmpdir()}/`].some((dir) => `${cwd}/`.startsWith(dir));
}

/** Push the turn's entries; times stay in order and distinct. */
function pushTurn(session, turn, cwd) {
  if (!turn?.prompt || !turn.at) return;
  session.entries.push({ role: "user", text: turn.prompt, occurredAt: turn.at, cwd });
  if (turn.reply && turn.replyAt) session.entries.push({ role: "assistant", text: turn.reply, occurredAt: turn.replyAt, cwd });
}

function readComposer(file, id, userDir) {
  const session = { client: "cursor", file: databaseSource(file, id), sessionId: id, cwd: null, entries: [], skip: null, automated: false };
  withReadOnlyDatabase(file, (db) => {
    const data = parseJson(db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(`composerData:${id}`)?.value);
    if (!data) {
      session.skip = "no session id";
      return;
    }
    const header = headerRow(db, id);
    const headerValue = parseJson(header?.value);
    if (data.subagentInfo || data.isBestOfNSubcomposer || header?.isSubagent) {
      session.skip = "subagent session";
      return;
    }
    session.automated = Boolean(data.createdFromBackgroundAgent);
    session.lastWrittenMs = Math.max(
      ...[data.lastUpdatedAt, header?.lastUpdatedAt, data.createdAt].map(Number).filter(Number.isFinite),
      0,
    );
    const order = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : [];
    if (order.length === 0) {
      session.skip = "empty (never sent)";
      return;
    }

    const bubbles = new Map();
    for (const row of keyRange(db, `bubbleId:${id}:`)) {
      const bubble = parseJson(row.value);
      if (bubble) bubbles.set(row.key.slice(`bubbleId:${id}:`.length), bubble);
    }
    session.cwd = folderPath(headerValue?.workspaceIdentifier?.uri?.external)
      || headerValue?.workspaceIdentifier?.uri?.fsPath
      || workspaceFolder(userDir, header?.workspaceId)
      || composerWorkspaces(userDir).get(id)
      || null;

    let turn = null;
    let last = toIso(data.createdAt);
    const stamp = (value) => {
      // Older composers lack bubble times: fall back to the last known time.
      const at = toIso(value) ?? last;
      if (at && (!last || at >= last)) last = at;
      return last;
    };
    for (const item of order) {
      const bubble = bubbles.get(item?.bubbleId);
      if (!bubble) continue;
      const text = (typeof bubble.text === "string" && bubble.text.trim()) ? bubble.text.trim() : richText(bubble.richText);
      if (bubble.type === USER) {
        const query = prompt(text);
        if (!query) {
          // A notice ends the turn: what answers it is not the earlier reply.
          if (text) {
            pushTurn(session, turn, session.cwd ?? undefined);
            turn = null;
          }
          continue;
        }
        pushTurn(session, turn, session.cwd ?? undefined);
        if (!session.cwd) session.cwd = folderPath(bubble.workspaceUris?.[0]) || null;
        turn = { prompt: query, at: stamp(bubble.createdAt ?? item.createdAt), reply: "", replyAt: null };
      } else if (bubble.type === ASSISTANT && turn && text && !bubble.thinking && !isToolCall(bubble)
        && !NON_REPLY_CAPABILITIES.has(bubble.capabilityType)) {
        turn.reply = text;
        turn.replyAt = stamp(bubble.createdAt ?? item.createdAt);
      }
    }
    pushTurn(session, turn, session.cwd ?? undefined);
  });
  return session;
}

function transcriptText(row) {
  const content = row?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** `<timestamp>Friday, October 16, 2026, 9:05 AM (UTC-5)</timestamp>` as ISO, or null. */
export function transcriptTimestamp(text) {
  const match = /<timestamp>\s*\w+,\s*(\w+)\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*\(UTC([+-]\d{1,2})?(?::(\d{2}))?\)/i.exec(text);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  if (month < 0) return null;
  let hour = Number(match[4]) % 12;
  if (match[6].toUpperCase() === "PM") hour += 12;
  const offsetHours = Number(match[7] ?? 0);
  const offsetMinutes = Math.sign(offsetHours || 1) * Number(match[8] ?? 0);
  const utc = Date.UTC(Number(match[3]), month, Number(match[2]), hour, Number(match[5])) - (offsetHours * 60 + offsetMinutes) * 60_000;
  return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
}

function chatCwd(home, id) {
  let groups;
  try {
    groups = fs.readdirSync(path.join(home, "chats"), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const meta = parseJson(safeRead(path.join(home, "chats", group.name, id, "meta.json")));
    if (typeof meta?.cwd === "string" && meta.cwd) return meta.cwd;
  }
  return null;
}

async function readTranscript(file, home) {
  const id = path.basename(file, ".jsonl");
  const session = { client: "cursor", file, sessionId: id, cwd: chatCwd(home, id), entries: [], skip: null, automated: false };
  session.automated = isTemp(session.cwd);
  const turns = [];
  let turn = null;
  for await (const row of jsonRows(file)) {
    const text = transcriptText(row);
    if (!text) continue;
    if (row.role === "user") {
      const query = prompt(text);
      if (!query) {
        turn = null; // injected context or a notice: what follows answers it
        continue;
      }
      turn = { prompt: query, at: transcriptTimestamp(text), reply: "" };
      turns.push(turn);
    } else if (row.role === "assistant" && turn) {
      turn.reply = text;
    }
  }
  // No per-message times. An entry with a <timestamp> uses it; one without
  // follows the last known time by 1 ms, or, before any, sits just before the
  // file's time. Times stay in order and distinct, and so do the import ids.
  let mtime;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    mtime = Date.now();
  }
  let last = null;
  const next = (iso) => {
    const own = iso ? Date.parse(iso) : NaN;
    let at;
    if (Number.isFinite(own)) at = last === null ? own : Math.max(own, last + 1);
    else at = last === null ? Math.floor(mtime) - 2 * turns.length : last + 1;
    last = at;
    return new Date(at).toISOString();
  };
  for (const item of turns) {
    const at = next(item.at);
    pushTurn(session, { prompt: item.prompt, at, reply: item.reply, replyAt: item.reply ? next(null) : null }, session.cwd ?? undefined);
  }
  return session;
}

/** @returns {Promise<import("../plan.mjs").ImportSession>} */
export async function readCursorSession(source, { userDir = cursorUserDir(), home = cursorHome() } = {}) {
  const { file, id } = parseDatabaseSource(source);
  if (path.basename(file) !== DATABASE_NAME) return readTranscript(source, home);
  if (!id) withReadOnlyDatabase(file, () => {}); // listed without node:sqlite: report it unreadable
  return readComposer(file, id, userDir);
}
