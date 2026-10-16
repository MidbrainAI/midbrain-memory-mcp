/**
 * Issue #75: Prime Agent history reader.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listPrimeAgentSessionFiles,
  readPrimeAgentSession,
} from "../shared/history-import/readers/prime-agent.mjs";
import { planImport } from "../shared/history-import/plan.mjs";

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-import-prime-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeLog(name, rows) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return file;
}

const header = (extra = {}) => ({
  type: "session", version: 3, id: "prime-1", timestamp: "2026-10-12T09:00:00.000Z", cwd: "/work/prime", rlmDepth: 0, ...extra,
});
const message = (timestamp, msg) => ({ type: "message", id: timestamp, timestamp, message: msg });

function rows() {
  return [
    header(),
    { type: "model_change", timestamp: "2026-10-12T09:00:00.100Z" },
    { type: "custom_message", timestamp: "2026-10-12T09:00:00.200Z", customType: "harness_digest", content: "injected", display: false },
    message("2026-10-12T09:00:01.000Z", { role: "user", content: [{ type: "text", text: "prime prompt one" }] }),
    message("2026-10-12T09:00:02.000Z", { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Checking." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] }),
    message("2026-10-12T09:00:03.000Z", { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false }),
    message("2026-10-12T09:00:04.000Z", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "prime answer one" }] }),
    {
      type: "custom_message", timestamp: "2026-10-12T09:01:00.000Z", customType: "agent_message",
      details: { from: { clientId: "cli-1" }, message: "sent prompt" },
    },
    {
      type: "custom_message", timestamp: "2026-10-12T09:01:01.000Z", customType: "agent_message",
      details: { from: { sessionId: "other-session" }, message: "peer output" },
    },
    message("2026-10-12T09:01:05.000Z", { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "sent answer" }] }),
    message("2026-10-12T09:02:00.000Z", { role: "user", content: [{ type: "text", text: "aborted prompt" }] }),
    message("2026-10-12T09:02:01.000Z", { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] }),
  ];
}

describe("readPrimeAgentSession", () => {
  it("keeps prompts, sent prompts and final replies, without tool summaries", async () => {
    const session = await readPrimeAgentSession(writeLog("prime-1.jsonl", rows()));
    expect(session).toMatchObject({ client: "prime-agent", sessionId: "prime-1", cwd: "/work/prime", skip: null });
    expect(session.entries).toEqual([
      { role: "user", text: "prime prompt one", occurredAt: "2026-10-12T09:00:01.000Z", cwd: "/work/prime" },
      { role: "assistant", text: "prime answer one", occurredAt: "2026-10-12T09:00:04.000Z", cwd: "/work/prime" },
      { role: "user", text: "sent prompt", occurredAt: "2026-10-12T09:01:00.000Z", cwd: "/work/prime" },
      { role: "assistant", text: "sent answer", occurredAt: "2026-10-12T09:01:05.000Z", cwd: "/work/prime" },
      { role: "user", text: "aborted prompt", occurredAt: "2026-10-12T09:02:00.000Z", cwd: "/work/prime" },
    ]);
  });

  it("skips subagent sessions", async () => {
    const session = await readPrimeAgentSession(writeLog("sub.jsonl", [header({ rlmDepth: 1 }), ...rows().slice(1)]));
    expect(session.skip).toBe("subagent session");
    expect(session.entries).toEqual([]);
  });

  it("skips the parent history a fork starts with", async () => {
    const forked = [
      header({ timestamp: "2026-10-13T00:00:00.000Z", parentSession: "prime-0" }),
      message("2026-10-12T09:00:01.000Z", { role: "user", content: [{ type: "text", text: "parent prompt" }] }),
      {
        type: "custom_message", timestamp: "2026-10-12T09:00:02.000Z", customType: "agent_message",
        details: { from: { clientId: "cli-1" }, message: "parent sent prompt" },
      },
      message("2026-10-13T00:00:05.000Z", { role: "user", content: [{ type: "text", text: "fork prompt" }] }),
    ];
    const session = await readPrimeAgentSession(writeLog("fork.jsonl", forked));
    expect(session.entries.map((entry) => entry.text)).toEqual(["fork prompt"]);
  });

  it("lists session logs only, not other files or symlinks", async () => {
    const log = writeLog("prime-1.jsonl", rows());
    writeLog("notes.txt", []);
    fs.symlinkSync(log, path.join(dir, "link.jsonl"));
    fs.mkdirSync(path.join(dir, "session-artifacts"));
    await expect(listPrimeAgentSessionFiles(dir)).resolves.toEqual([log]);
  });

  it("plans from a reader whose list() is async", async () => {
    const log = writeLog("prime-1.jsonl", rows());
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(log, old, old);
    const [planned] = await planImport({
      readers: { "prime-agent": { list: async () => [log], read: readPrimeAgentSession } },
      clients: ["prime-agent"],
    });
    expect(planned).toMatchObject({ sessionId: "prime-1", skip: null });
    expect(planned.entries).toHaveLength(5);
  });
});
