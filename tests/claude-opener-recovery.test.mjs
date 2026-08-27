import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deliveredNanoclawMessage,
  readClaudeTranscript,
  recoverLegacyOpener,
} from "../shared/claude-transcript.mjs";
import {
  claimLegacyOpenerRecovery,
  legacyOpenerReceiptPath,
} from "../shared/claude-opener-recovery.mjs";
import { historicalShimPath, shellQuote } from "../shared/clients/shim.mjs";

const IS_WIN = process.platform === "win32";
const SESSION = "11111111-1111-4111-8111-111111111111";
const USER_UUID = "22222222-2222-4222-8222-222222222222";
const FAILURE_UUID = "33333333-3333-4333-8333-333333333333";
const ASSISTANT_UUID = "44444444-4444-4444-8444-444444444444";
const CWD = "/workspace/agent";

let home;
let oldHome;
let oldUserProfile;
let oldClaudeConfigDir;

function transcriptRows(overrides = {}) {
  const command = overrides.command ?? `${historicalShimPath("claude")} user`;
  return [
    {
      type: "user",
      uuid: USER_UUID,
      sessionId: overrides.userSessionId ?? SESSION,
      cwd: overrides.userCwd ?? CWD,
      message: { role: "user", content: overrides.userText ?? "first cold opener" },
    },
    {
      type: "attachment",
      uuid: FAILURE_UUID,
      parentUuid: overrides.failureParentUuid ?? USER_UUID,
      sessionId: overrides.failureSessionId ?? SESSION,
      cwd: overrides.failureCwd ?? CWD,
      attachment: {
        type: overrides.failureType ?? "hook_non_blocking_error",
        hookName: overrides.hookName ?? "UserPromptSubmit",
        hookEvent: overrides.hookEvent ?? "UserPromptSubmit",
        exitCode: overrides.exitCode ?? 127,
        command,
      },
    },
    {
      type: "assistant",
      uuid: ASSISTANT_UUID,
      parentUuid: overrides.assistantParentUuid ?? FAILURE_UUID,
      sessionId: overrides.assistantSessionId ?? SESSION,
      cwd: overrides.assistantCwd ?? CWD,
      message: {
        role: "assistant",
        content: overrides.assistantContent ?? [{ type: "text", text: "first cold reply" }],
      },
    },
  ];
}

function recoveryInput(overrides = {}) {
  return {
    sessionId: SESSION,
    cwd: CWD,
    hookEventName: "Stop",
    lastAssistantMessage: "first cold reply",
    ...overrides,
  };
}

function writeTranscript(rows, { dir, name = `${SESSION}.jsonl`, prefix = "" } = {}) {
  const targetDir = dir ?? path.join(home, ".claude", "projects", "-workspace-agent");
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, name);
  fs.writeFileSync(target, `${prefix}${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return target;
}

beforeEach(() => {
  oldHome = process.env.HOME;
  oldUserProfile = process.env.USERPROFILE;
  oldClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-opener-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(path.join(home, ".claude"), { mode: 0o700 });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldUserProfile;
  if (oldClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = oldClaudeConfigDir;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("guarded Claude transcript recovery", () => {
  it.each([
    ["normalized attachment", () => `${historicalShimPath("claude")} user`],
    ["exact v0.4.8 quoted attachment", () => `${shellQuote(historicalShimPath("claude"))} user`],
  ])("attests the current Stop and owned opener failure from the %s", (_label, command) => {
    const file = writeTranscript(transcriptRows({ command: command() }));
    const rows = readClaudeTranscript(file);

    expect(recoverLegacyOpener(rows, recoveryInput())).toBe("first cold opener");
  });

  it.each([
    ["wrong hook name", { hookName: "Stop" }],
    ["wrong hook event", { hookEvent: "Stop" }],
    ["wrong exit", { exitCode: 1 }],
    ["direct v0.4.7 command", { command: "npx -y midbrain-memory-mcp@0.4.7 hook claude user" }],
    ["relocated shim", { command: "/home/node/.claude/.midbrain/bin/claude-hook user" }],
    ["foreign shim", { command: "/home/node/.midbrain/bin/foreign-hook user" }],
    ["near-name shim", { command: () => `${historicalShimPath("claude")}-wrapper user` }],
    ["extra argument", { command: () => `${historicalShimPath("claude")} user extra` }],
    ["trailing shell", { command: () => `${historicalShimPath("claude")} user; true` }],
    ["extra whitespace", { command: () => `${historicalShimPath("claude")}  user` }],
  ])("rejects %s", (_label, override) => {
    const resolved = { ...override };
    if (typeof resolved.command === "function") resolved.command = resolved.command();
    const rows = readClaudeTranscript(writeTranscript(transcriptRows(resolved)));

    expect(recoverLegacyOpener(rows, recoveryInput())).toBe("");
  });

  it.each([
    ["wrong Stop event", transcriptRows(), { hookEventName: "SubagentStop" }],
    ["wrong session", transcriptRows({ assistantSessionId: "55555555-5555-4555-8555-555555555555" }), {}],
    ["wrong cwd", transcriptRows({ assistantCwd: "/other" }), {}],
    ["wrong final response", transcriptRows(), { lastAssistantMessage: "later reply" }],
  ])("rejects a transcript not bound to the invoking %s", (_label, fixture, input) => {
    const rows = readClaudeTranscript(writeTranscript(fixture));
    expect(recoverLegacyOpener(rows, recoveryInput(input))).toBe("");
  });

  it("rejects when the transcript advances to a later assistant before the async Stop reads it", () => {
    const rows = transcriptRows();
    rows.push({
      type: "assistant",
      uuid: "55555555-5555-4555-8555-555555555555",
      parentUuid: ASSISTANT_UUID,
      sessionId: SESSION,
      cwd: CWD,
      message: { role: "assistant", content: [{ type: "text", text: "later reply" }] },
    });

    expect(recoverLegacyOpener(readClaudeTranscript(writeTranscript(rows)), recoveryInput())).toBe("");
  });

  it.each([
    ["duplicate UUID", (rows) => rows.push({ ...rows[1] })],
    ["invalid assistant UUID", (rows) => { rows[2].uuid = "not-a-uuid"; }],
    ["missing parent", (rows) => { rows[2].parentUuid = "55555555-5555-4555-8555-555555555555"; }],
    ["cycle", (rows) => { rows[1].parentUuid = ASSISTANT_UUID; }],
    ["tool-result user", (rows) => { rows[0].message.content = [{ type: "tool_result", content: "x" }]; }],
    ["multiple matching failures", (rows) => {
      rows.splice(2, 0, {
        ...rows[1],
        uuid: "55555555-5555-4555-8555-555555555555",
        parentUuid: FAILURE_UUID,
      });
      rows[3].parentUuid = "55555555-5555-4555-8555-555555555555";
    }],
  ])("fails closed on %s ancestry", (_label, mutate) => {
    const rows = transcriptRows();
    mutate(rows);
    expect(recoverLegacyOpener(readClaudeTranscript(writeTranscript(rows)), recoveryInput())).toBe("");
  });

  it("rejects ancestry beyond 256 hops", () => {
    const rows = transcriptRows();
    let parentUuid = FAILURE_UUID;
    for (let index = 0; index < 256; index += 1) {
      const uuid = `${String(index).padStart(8, "0")}-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`;
      rows.splice(rows.length - 1, 0, {
        type: "progress",
        uuid,
        parentUuid,
        sessionId: SESSION,
        cwd: CWD,
      });
      parentUuid = uuid;
    }
    rows.at(-1).parentUuid = parentUuid;

    expect(recoverLegacyOpener(readClaudeTranscript(writeTranscript(rows)), recoveryInput())).toBe("");
  });

  it("reads only complete lines from the final 4 MiB", () => {
    const prefix = `${"x".repeat(4 * 1024 * 1024)}\n`;
    const file = writeTranscript(transcriptRows(), { prefix });

    expect(recoverLegacyOpener(readClaudeTranscript(file), recoveryInput())).toBe("first cold opener");
  });

  it("rejects paths outside the active projects root", () => {
    const outside = writeTranscript(transcriptRows(), { dir: path.join(home, "outside") });
    expect(readClaudeTranscript(outside)).toBeNull();
  });

  it.runIf(!IS_WIN)("rejects a transcript symlink without reading its target", () => {
    const real = writeTranscript(transcriptRows());
    const link = path.join(path.dirname(real), "linked.jsonl");
    fs.symlinkSync(real, link);
    expect(readClaudeTranscript(link)).toBeNull();
  });

  it("preserves delivered-message last-human-turn semantics over guarded rows", () => {
    const rows = [
      { type: "user", message: { role: "user", content: "old" } },
      { type: "assistant", message: { role: "assistant", content: [
        { type: "tool_use", name: "mcp__nanoclaw__send_message", input: { text: "old reply" } },
      ] } },
      { type: "user", message: { role: "user", content: "current" } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } },
      { type: "assistant", message: { role: "assistant", content: [
        { type: "tool_use", name: "mcp__nanoclaw__send_message", input: { text: "current reply" } },
      ] } },
    ];
    expect(deliveredNanoclawMessage(readClaudeTranscript(writeTranscript(rows)))).toBe("current reply");
  });
});

describe("terminal legacy opener receipt", () => {
  it("creates one durable zero-byte private receipt and never claims it twice", () => {
    expect(claimLegacyOpenerRecovery()).toBe(true);
    const receipt = legacyOpenerReceiptPath();
    const stat = fs.statSync(receipt);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(0);
    if (!IS_WIN) {
      expect(stat.mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(receipt)).mode & 0o777).toBe(0o700);
    }
    expect(claimLegacyOpenerRecovery()).toBe(false);
  });

  it("leaves an existing hostile receipt untouched", () => {
    const receipt = legacyOpenerReceiptPath();
    fs.mkdirSync(path.dirname(receipt), { recursive: true, mode: 0o700 });
    fs.writeFileSync(receipt, "user-owned", { mode: 0o640 });
    const before = fs.statSync(receipt);

    expect(claimLegacyOpenerRecovery()).toBe(false);
    expect(fs.readFileSync(receipt, "utf8")).toBe("user-owned");
    expect(fs.statSync(receipt).mode).toBe(before.mode);
  });

  it.runIf(!IS_WIN)("does not follow an existing receipt symlink", () => {
    const receipt = legacyOpenerReceiptPath();
    const victim = path.join(home, "victim");
    fs.mkdirSync(path.dirname(receipt), { recursive: true, mode: 0o700 });
    fs.writeFileSync(victim, "safe");
    fs.symlinkSync(victim, receipt);

    expect(claimLegacyOpenerRecovery()).toBe(false);
    expect(fs.readFileSync(victim, "utf8")).toBe("safe");
    expect(fs.lstatSync(receipt).isSymbolicLink()).toBe(true);
  });

  it.runIf(!IS_WIN)("refuses an existing receipt directory with non-private mode without chmod", () => {
    const dir = path.dirname(legacyOpenerReceiptPath());
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });

    expect(claimLegacyOpenerRecovery()).toBe(false);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
  });

  it("leaves the receipt terminal and suppresses the POST claim when fsync fails", () => {
    vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("fsync failed"); });

    expect(claimLegacyOpenerRecovery()).toBe(false);
    expect(fs.lstatSync(legacyOpenerReceiptPath()).isFile()).toBe(true);
    vi.restoreAllMocks();
    expect(claimLegacyOpenerRecovery()).toBe(false);
  });
});
