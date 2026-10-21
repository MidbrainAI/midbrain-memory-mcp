/**
 * Prime Agent history reader (issue #75).
 *
 * Prime Agent appends each session to `<sessions dir>/<id>.jsonl`. The live
 * capture watcher already turns those entries into captures
 * (`applyEntry`); the reader reuses it, so an imported session matches what
 * live capture stores: user prompts, `prime-agent send` prompts, and final
 * replies. Subagent sessions (`rlmDepth` > 0) and the parent history a fork
 * starts with are skipped by `applyEntry`. The live tool summary is left out,
 * as for the other clients.
 *
 * Prime Agent v0.10.0 moves sessions older than 30 days, or beyond the 200
 * most recent, to `<agent dir>/sessions-archive` (same file names; moved
 * back when resumed), so that folder is read too.
 */

import path from "node:path";

import { primeAgentDir, primeSessionsDir } from "../../clients/prime-agent.mjs";
import { applyEntry, messageText, newSessionState } from "../../../plugins/prime-agent/common.mjs";
import { CORRUPT_ROW, jsonRows, regularFiles, validTimestamp } from "./common.mjs";

/** The sessions dir, then the archive Prime Agent moves old sessions to. */
export async function primeHistoryDirs(env = process.env) {
  return [await primeSessionsDir(env), path.join(primeAgentDir(env), "sessions-archive")];
}

/**
 * Session logs directly in each history dir. A file in both (mid-move) is
 * read once, from the sessions dir.
 */
export async function listPrimeAgentSessionFiles(dirs) {
  const roots = dirs ? [dirs].flat() : await primeHistoryDirs();
  const seen = new Set();
  const files = [];
  for (const root of roots) {
    for (const file of regularFiles(root, (name) => name.endsWith(".jsonl"))) {
      if (seen.has(path.basename(file))) continue;
      seen.add(path.basename(file));
      files.push(file);
    }
  }
  return files;
}

/** @returns {Promise<import("../plan.mjs").ImportSession>} */
export async function readPrimeAgentSession(file, dirs) {
  const roots = dirs ? [dirs].flat() : await primeHistoryDirs();
  const root = roots.find((dir) => path.dirname(file) === path.resolve(dir)) ?? roots[0];
  const session = {
    client: "prime-agent",
    file,
    sessionId: null,
    cwd: null,
    entries: [],
    skip: null,
  };
  const state = newSessionState();
  // After a corrupt line, a reply may answer a prompt that was lost with it:
  // replies are left out until the next prompt.
  let gap = false;
  for await (const entry of jsonRows(file, root)) {
    if (entry === CORRUPT_ROW) {
      gap = true;
      continue;
    }
    const captures = applyEntry(state, entry);
    if (entry.type === "session") {
      session.sessionId = state.sessionId ?? null;
      session.cwd = state.cwd ?? null;
      if (state.depth > 0) {
        session.skip = "subagent session";
        return session;
      }
      continue;
    }
    const at = validTimestamp(entry.timestamp);
    if (!at) continue;
    for (const capture of captures) {
      // The reply is the message's own text; anything else is the tool summary.
      if (capture.role === "assistant" && capture.text !== messageText(entry.message)) continue;
      if (capture.role === "user") gap = false;
      else if (gap) continue;
      session.entries.push({ role: capture.role, text: capture.text, occurredAt: at, cwd: session.cwd ?? undefined });
    }
  }
  if (!session.sessionId) session.skip = "no session id";
  return session;
}
