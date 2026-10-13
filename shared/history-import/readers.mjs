/**
 * Readers for local conversation history (issue #75: opt-in import).
 *
 * Each reader turns one client session file into the same entries live
 * capture would have stored for it: the user's prompts and the reply that
 * ended each turn, with the time each was written. Tool calls, tool output,
 * injected context, subagent threads and harness-generated messages are left
 * out, so an imported session looks like a captured one.
 *
 * Readers only read. They never follow symlinks out of the client's history
 * directory and never touch the network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

/**
 * @typedef {object} ImportEntry
 * @property {"user"|"assistant"} role
 * @property {string} text
 * @property {string} occurredAt ISO timestamp of the original message.
 * @property {string} [cwd] Working directory of the turn.
 *
 * @typedef {object} ImportSession
 * @property {string} client      Client label (`claude`, `codex`).
 * @property {string} file        Absolute path of the session file.
 * @property {string|null} sessionId
 * @property {string|null} cwd    Working directory the session started in.
 * @property {ImportEntry[]} entries
 * @property {string|null} skip   Why the whole session is skipped, if it is.
 * @property {boolean} [automated] Every prompt came from a program (an SDK
 *   or orchestrator), none from a person at the client's own interface.
 */

export function claudeProjectsDir(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return path.join(configDir, "projects");
}

export function codexSessionDirs(env = process.env) {
  const home = env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return [path.join(home, "sessions"), path.join(home, "archived_sessions")];
}

/** Regular files (no symlinks) directly inside `dir` matching `test`. */
function regularFiles(dir, test) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((entry) => entry.isFile() && test(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

/**
 * Claude Code keeps one JSONL transcript per session in
 * `projects/<encoded-project>/<session-id>.jsonl`. Subagent transcripts live
 * in subdirectories and are not listed.
 */
export function listClaudeSessionFiles(root = claudeProjectsDir()) {
  let projects;
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return projects
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => regularFiles(path.join(root, entry.name), (name) => name.endsWith(".jsonl")));
}

/** Codex keeps `sessions/YYYY/MM/DD/rollout-*.jsonl` (and the same under `archived_sessions`, flat). */
export function listCodexSessionFiles(dirs = codexSessionDirs()) {
  const isRollout = (name) => name.startsWith("rollout-") && name.endsWith(".jsonl");
  const files = [];
  const walk = (dir, depth) => {
    files.push(...regularFiles(dir, isRollout));
    if (depth === 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth - 1);
    }
  };
  for (const dir of dirs) walk(dir, 3);
  return files;
}

async function* jsonRows(file) {
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === "object") yield row;
      } catch {
        // A torn or corrupt line: skip it, keep the rest of the session.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

function validTimestamp(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

// ---------------------------------------------------------------- Claude Code

// User rows Claude Code writes on the user's behalf: slash-command echoes,
// `!` shell input and output, local command output, interrupt markers.
const CLAUDE_GENERATED_PROMPT =
  /^\s*(?:<command-name>|<command-message>|<command-args>|<bash-input>|<bash-stdout>|<bash-stderr>|<local-command-stdout>|<local-command-stderr>|<local-command-caveat>|\[Request interrupted)/;

function claudeText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * A user row starts a turn when a person wrote it: not a tool result, not a
 * meta/compaction row, not a notification or peer message (`origin.kind`
 * other than `human`), and not one of Claude Code's generated echoes.
 */
function claudePrompt(row) {
  if (row.isMeta || row.isCompactSummary) return null;
  const kind = row.origin?.kind;
  if (kind && kind !== "human") return null;
  const text = claudeText(row.message?.content).trim();
  if (!text || CLAUDE_GENERATED_PROMPT.test(text)) return null;
  return text;
}

/** @returns {Promise<ImportSession>} */
export async function readClaudeSession(file) {
  const session = {
    client: "claude",
    file,
    sessionId: null,
    cwd: null,
    entries: [],
    skip: null,
    automated: false,
  };
  let turn = null;
  let interactivePrompts = 0;
  const closeTurn = () => {
    if (!turn) return;
    session.entries.push({ role: "user", text: turn.prompt, occurredAt: turn.at, cwd: turn.cwd });
    const reply = turn.replyParts.join("\n").trim();
    if (reply) {
      session.entries.push({ role: "assistant", text: reply, occurredAt: turn.replyAt || turn.at, cwd: turn.cwd });
    }
    turn = null;
  };

  for await (const row of jsonRows(file)) {
    if (!session.sessionId && typeof row.sessionId === "string") session.sessionId = row.sessionId;
    if (row.isSidechain) continue;
    if (row.type === "user") {
      const prompt = claudePrompt(row);
      if (!prompt) continue;
      const at = validTimestamp(row.timestamp);
      if (!at) continue;
      closeTurn();
      // Agent SDK runs (`entrypoint: sdk-py`, `sdk-ts`, `sdk-cli`) mark their
      // prompts `promptSource: sdk`; a person's prompt is typed, queued, etc.
      const programmatic = row.promptSource === "sdk"
        || (typeof row.entrypoint === "string" && row.entrypoint.startsWith("sdk"));
      if (!programmatic) interactivePrompts += 1;
      const cwd = typeof row.cwd === "string" ? row.cwd : session.cwd;
      if (!session.cwd && cwd) session.cwd = cwd;
      turn = { prompt, at, cwd, replyId: null, replyParts: [], replyAt: null };
    } else if (row.type === "assistant" && turn) {
      const text = claudeText(row.message?.content).trim();
      if (!text) continue;
      // One API message is written as several rows that share message.id.
      // The turn's reply is the last message that has text.
      const id = row.message?.id ?? row.uuid ?? null;
      if (id !== turn.replyId) {
        turn.replyId = id;
        turn.replyParts = [];
      }
      turn.replyParts.push(text);
      turn.replyAt = validTimestamp(row.timestamp) || turn.replyAt;
    }
  }
  closeTurn();
  session.automated = session.entries.length > 0 && interactivePrompts === 0;
  if (!session.sessionId) session.skip = "no session id";
  return session;
}

// ---------------------------------------------------------------------- Codex

// Text Codex adds to the user's message: AGENTS.md and environment context.
const CODEX_INJECTED_PROMPT = /^\s*(?:# AGENTS\.md instructions|<environment_context>|<user_instructions>|<turn_aborted>)/;

function codexText(content, type) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === type && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** @returns {Promise<ImportSession>} */
export async function readCodexSession(file) {
  const session = {
    client: "codex",
    file,
    sessionId: null,
    cwd: null,
    entries: [],
    skip: null,
  };
  let turn = null;
  let cwd = null;
  const closeTurn = () => {
    if (!turn) return;
    if (turn.prompt) {
      session.entries.push({ role: "user", text: turn.prompt, occurredAt: turn.promptAt, cwd: turn.cwd });
      if (turn.reply) {
        session.entries.push({ role: "assistant", text: turn.reply, occurredAt: turn.replyAt || turn.promptAt, cwd: turn.cwd });
      }
    }
    turn = null;
  };
  const openTurn = () => {
    closeTurn();
    turn = { prompt: "", promptAt: null, reply: "", replyAt: null, cwd };
  };

  for await (const row of jsonRows(file)) {
    const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
    const at = validTimestamp(row.timestamp);
    if (row.type === "session_meta") {
      if (typeof payload.id === "string") session.sessionId = payload.id;
      if (typeof payload.cwd === "string") session.cwd = cwd = payload.cwd;
      // Threads spawned by another Codex agent are not the user's conversation.
      if (payload.source && typeof payload.source === "object" && payload.source.subagent) {
        session.skip = "subagent session";
        return session;
      }
    } else if (row.type === "turn_context") {
      if (typeof payload.cwd === "string") {
        cwd = payload.cwd;
        if (turn) turn.cwd = cwd;
      }
    } else if (row.type === "event_msg" && payload.type === "task_started") {
      openTurn();
    } else if (row.type === "event_msg" && payload.type === "task_complete") {
      if (turn && !turn.reply && typeof payload.last_agent_message === "string") {
        turn.reply = payload.last_agent_message.trim();
        turn.replyAt = at;
      }
      closeTurn();
    } else if (row.type === "response_item" && payload.type === "message") {
      if (payload.role === "user") {
        const text = codexText(payload.content, "input_text").trim();
        if (!text || CODEX_INJECTED_PROMPT.test(text) || !at) continue;
        if (!turn) openTurn();
        turn.prompt = turn.prompt ? `${turn.prompt}\n${text}` : text;
        if (!turn.promptAt) turn.promptAt = at;
      } else if (payload.role === "assistant" && payload.phase === "final_answer" && turn) {
        const text = codexText(payload.content, "output_text").trim();
        if (text) {
          turn.reply = text;
          turn.replyAt = at;
        }
      }
    }
  }
  closeTurn();
  if (!session.sessionId) session.skip = "no session id";
  return session;
}

export const READERS = {
  claude: { list: () => listClaudeSessionFiles(), read: readClaudeSession },
  codex: { list: () => listCodexSessionFiles(), read: readCodexSession },
};
