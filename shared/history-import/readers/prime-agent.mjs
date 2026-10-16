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
 */

import { primeSessionsDir } from "../../clients/prime-agent.mjs";
import { applyEntry, messageText, newSessionState } from "../../../plugins/prime-agent/common.mjs";
import { jsonRows, regularFiles, validTimestamp } from "./common.mjs";

/** Session logs directly in the sessions dir. */
export async function listPrimeAgentSessionFiles(dir) {
  const root = dir ?? await primeSessionsDir();
  return regularFiles(root, (name) => name.endsWith(".jsonl"));
}

/** @returns {Promise<import("../plan.mjs").ImportSession>} */
export async function readPrimeAgentSession(file) {
  const session = {
    client: "prime-agent",
    file,
    sessionId: null,
    cwd: null,
    entries: [],
    skip: null,
  };
  const state = newSessionState();
  for await (const entry of jsonRows(file)) {
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
      session.entries.push({ role: capture.role, text: capture.text, occurredAt: at, cwd: session.cwd ?? undefined });
    }
  }
  if (!session.sessionId) session.skip = "no session id";
  return session;
}
