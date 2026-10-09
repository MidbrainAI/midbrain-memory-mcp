/**
 * AC-9 (PRD-034): end-to-end capture through the real claude-hook shim file.
 *
 * Spawns /bin/sh on the actual installed shim in a sandbox home. The shim body
 * is the dev variant (pointing at this checkout) so the chain is fully
 * hermetic: sh shim -> node index.js hook claude <role> -> capture script ->
 * MidbrainApi -> fetch (stubbed via NODE_OPTIONS --import, logged to a file).
 *
 * Asserts: hook fires, capture script resolves, episodic POST observed,
 * exit 0, stdout EMPTY with PK off, stderr free of unexpected lines (a
 * project key is seeded so no key-fallthrough warning fires).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "fs/promises";
import path from "path";
import { pathToFileURL } from "node:url";

import { makeTestEnv } from "./helpers/test-env.mjs";
import { installShim, stableShimPath, isDevShimContent } from "../shared/clients/shim.mjs";
import { cursorCapturesTurn, isCursorPayload } from "../plugins/claude-code/common.mjs";

const IS_WIN = process.platform === "win32";

let env;
let projectDir;
let fetchLog;

beforeEach(async () => {
  env = await makeTestEnv();
  projectDir = path.join(env.home, "project");
  await fs.mkdir(path.join(projectDir, ".midbrain"), { recursive: true });
  await fs.writeFile(path.join(projectDir, ".midbrain", ".midbrain-key"), "test-key-claude-e2e\n", { mode: 0o600 });
  fetchLog = path.join(env.tmp, "fetch-log.ndjson");

  const preload = path.join(env.tmp, "fetch-preload.mjs");
  await fs.writeFile(preload, `
    import fs from "node:fs";
    globalThis.fetch = async (url, opts = {}) => {
      const headers = opts.headers || {};
      const record = {
        url: String(url),
        hasAuth: typeof headers.Authorization === "string" && headers.Authorization.length > 0,
        body: opts.body ? JSON.parse(opts.body) : undefined,
      };
      fs.appendFileSync(process.env.MIDBRAIN_TEST_FETCH_LOG, JSON.stringify(record) + "\\n");
      if (String(url).includes("/memories/episodic")) {
        return { ok: true, status: 201, text: async () => "", json: async () => ({}) };
      }
      return { ok: false, status: 404, text: async () => "not found", json: async () => ({}) };
    };
  `);
  env.preloadUrl = pathToFileURL(preload).href;

  await installShim("claude", { mode: "install", isDev: true });
});

afterEach(async () => {
  await env.restore();
});

async function readFetchLog() {
  try {
    return (await fs.readFile(fetchLog, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}

function runShim(role, input) {
  return spawnSync("/bin/sh", [stableShimPath("claude"), role], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 30_000,
    env: env.childEnv({
      NODE_OPTIONS: `--import ${env.preloadUrl}`,
      MIDBRAIN_TEST_FETCH_LOG: fetchLog,
    }),
  });
}

function unexpectedStderrLines(result) {
  return (result.stderr || "").split("\n").filter((l) =>
    /WARN|falling through|Error|EACCES/i.test(l) &&
    // The one whitelisted line (PRD-034 AC-9): the documented project->global
    // key-fallthrough warning from BaseClient.resolveKey.
    !/no project key found .* falling through to global key/.test(l));
}

describe.skipIf(IS_WIN)("AC-9 — claude-hook shim end-to-end (sandboxed)", () => {
  it("user role: captures the prompt via episodic POST; stdout empty; exit 0", async () => {
    const shimBody = await fs.readFile(stableShimPath("claude"), "utf8");
    expect(isDevShimContent(shimBody)).toBe(true); // hermetic dev body

    const result = runShim("user", { prompt: "e2e marker prompt PRD-034", cwd: projectDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(unexpectedStderrLines(result)).toEqual([]);

    const episodic = (await readFetchLog()).filter((r) => r.url.includes("/memories/episodic"));
    expect(episodic).toHaveLength(1);
    expect(episodic[0].hasAuth).toBe(true);
    expect(JSON.stringify(episodic[0].body)).toContain("e2e marker prompt PRD-034");
    expect(JSON.stringify(episodic[0].body)).toContain("claude");
  });

  it("assistant role: captures the final message; stdout empty; exit 0", async () => {
    const result = runShim("assistant", {
      last_assistant_message: "e2e assistant marker PRD-034",
      cwd: projectDir,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(unexpectedStderrLines(result)).toEqual([]);

    const episodic = (await readFetchLog()).filter((r) => r.url.includes("/memories/episodic"));
    expect(episodic).toHaveLength(1);
    expect(JSON.stringify(episodic[0].body)).toContain("e2e assistant marker PRD-034");
  });

  it("shim exits 0 even when the hook cannot resolve a key (fail-open)", async () => {
    await fs.rm(path.join(projectDir, ".midbrain", ".midbrain-key"));

    const result = runShim("user", { prompt: "no key present", cwd: projectDir });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    // "NO KEY" goes to the log file, not stderr; stderr must stay clean here too
    expect(unexpectedStderrLines(result)).toEqual([]);
    expect(await readFetchLog()).toEqual([]); // no capture without a key
  });
});

// Cursor's payload when its Third-Party Imports runs ~/.claude/settings.json
// hooks (cursor-agent 2026.10.01, probed live for #100).
function cursorPayload(cwd, extra = {}) {
  return {
    conversation_id: "1b926779-37f8-43df-bdbd-e625bed14721",
    generation_id: "f1a3e70c-83d7-4b77-aab0-504afb464b12",
    session_id: "1b926779-37f8-43df-bdbd-e625bed14721",
    model: "default",
    hook_event_name: "beforeSubmitPrompt",
    cursor_version: "2026.10.01-e373342",
    workspace_roots: [cwd],
    transcript_path: null,
    attachments: [],
    ...extra,
  };
}

async function episodicPosts() {
  return (await readFetchLog()).filter((r) => r.url.includes("/memories/episodic"));
}

async function installCursorHooks() {
  const hooks = path.join(env.home, ".cursor", "hooks.json");
  await fs.mkdir(path.dirname(hooks), { recursive: true });
  await fs.writeFile(hooks, JSON.stringify({
    version: 1,
    hooks: { beforeSubmitPrompt: [{ command: `'${stableShimPath("cursor")}' user`, timeout: 10 }] },
  }));
}

describe("Cursor-hosted Claude hook payloads (#100)", () => {
  it("detects Cursor payloads and never a Claude Code payload", () => {
    expect(isCursorPayload(cursorPayload("/repo"))).toBe(true);
    expect(isCursorPayload({ hook_event_name: "stop" })).toBe(true);
    expect(isCursorPayload({ hook_event_name: "UserPromptSubmit", prompt: "x", session_id: "s", cwd: "/repo" })).toBe(false);
    expect(isCursorPayload({ hook_event_name: "Stop", last_assistant_message: "x" })).toBe(false);
    expect(isCursorPayload(null)).toBe(false);
  });

  it("defers only when the MidBrain Cursor hooks are installed, and fails open", async () => {
    const cursor = cursorPayload("/repo");
    await expect(cursorCapturesTurn(cursor, { hasCursorHooks: async () => true })).resolves.toBe(true);
    await expect(cursorCapturesTurn(cursor, { hasCursorHooks: async () => false })).resolves.toBe(false);
    await expect(cursorCapturesTurn(cursor, { hasCursorHooks: async () => { throw new Error("boom"); } })).resolves.toBe(false);
    const hasCursorHooks = async () => { throw new Error("never asked for a Claude payload"); };
    await expect(cursorCapturesTurn({ hook_event_name: "UserPromptSubmit" }, { hasCursorHooks })).resolves.toBe(false);
  });
});

describe.skipIf(IS_WIN)("Cursor-hosted runs through the claude-hook shim (#100)", () => {
  it("user role: a Cursor prompt is left to the installed Cursor hooks; nothing is posted", async () => {
    await installCursorHooks();

    const result = runShim("user", cursorPayload(projectDir, { prompt: "cursor-hosted prompt #100", cwd: projectDir }));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(await episodicPosts()).toEqual([]);
  });

  it("assistant role: a Cursor stop payload is left to the installed Cursor hooks", async () => {
    await installCursorHooks();

    const result = runShim("assistant", cursorPayload(projectDir, {
      hook_event_name: "stop",
      status: "completed",
      loop_count: 0,
      last_assistant_message: "cursor-hosted reply #100",
      cwd: projectDir,
    }));

    expect(result.status).toBe(0);
    expect(await episodicPosts()).toEqual([]);
  });

  it("without the MidBrain Cursor hooks, a Cursor prompt is still captured here", async () => {
    const result = runShim("user", cursorPayload(projectDir, { prompt: "cursor-hosted prompt, no cursor hooks", cwd: projectDir }));

    expect(result.status).toBe(0);
    const episodic = (await readFetchLog()).filter((r) => r.url.includes("/memories/episodic"));
    expect(episodic).toHaveLength(1);
    expect(JSON.stringify(episodic[0].body)).toContain("cursor-hosted prompt, no cursor hooks");
  });

  it("a Claude Code prompt is still captured when the Cursor hooks are installed", async () => {
    await installCursorHooks();

    const result = runShim("user", { hook_event_name: "UserPromptSubmit", prompt: "claude prompt #100", session_id: "s1", cwd: projectDir });

    expect(result.status).toBe(0);
    const episodic = (await readFetchLog()).filter((r) => r.url.includes("/memories/episodic"));
    expect(episodic).toHaveLength(1);
    expect(JSON.stringify(episodic[0].body)).toContain("claude prompt #100");
  });
});
