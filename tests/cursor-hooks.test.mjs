/**
 * Unit + spawned-wrapper tests for plugins/cursor (capture runtime).
 *
 * Unit tests stub the MidBrain API through injected deps. Wrapper tests spawn
 * the real hook scripts under a makeTestEnv() sandbox HOME with a fetch
 * preload that records every request — no network, no real key.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CONTINUE,
  captureAssistant,
  captureToolUse,
  captureUser,
  finishHook,
  toCodexInput,
} from "../plugins/cursor/common.mjs";
import { makeTestEnv } from "./helpers/test-env.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const EMAIL = "someone@example.com";

// Common fields Cursor sends on every hook (docs: cursor.com/docs/agent/hooks).
function common(event, extra = {}) {
  return {
    conversation_id: "conv-1",
    generation_id: "gen-1",
    model: "some-model",
    hook_event_name: event,
    cursor_version: "9.9.9",
    workspace_roots: ["/repo"],
    user_email: EMAIL,
    transcript_path: null,
    ...extra,
  };
}

function makeDeps() {
  const api = { storeEpisodic: vi.fn().mockResolvedValue(true) };
  return {
    api,
    client: "cursor",
    createApi: vi.fn(async () => api),
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    assistantBufferDir: fs.mkdtempSync(path.join(os.tmpdir(), "cursor-assistant-")),
    toolBufferDir: fs.mkdtempSync(path.join(os.tmpdir(), "cursor-tools-")),
  };
}

describe("Cursor payload mapping", () => {
  it("maps conversation/generation/workspace ids and never carries user_email", () => {
    const mapped = toCodexInput(common("afterAgentResponse", { text: "hi" }));
    expect(mapped).toEqual({
      cwd: "/repo",
      session_id: "conv-1",
      turn_id: "gen-1",
      last_assistant_message: "hi",
    });
    expect(JSON.stringify(mapped)).not.toContain(EMAIL);
  });

  it("falls back to the payload cwd when workspace_roots is empty", () => {
    expect(toCodexInput({ workspace_roots: [], cwd: "/other" }).cwd).toBe("/other");
  });

  it("parses Cursor's JSON-string tool_output into a structured response", () => {
    const mapped = toCodexInput(common("postToolUse", {
      tool_name: "Shell",
      tool_use_id: "t1",
      tool_input: { command: "npm test" },
      tool_output: '{"exitCode":1,"stderr":"boom"}',
    }));
    expect(mapped.tool_response).toEqual({ exitCode: 1, stderr: "boom" });
  });
});

describe("Cursor hook capture", () => {
  let deps;
  beforeEach(() => { deps = makeDeps(); });
  afterEach(() => {
    fs.rmSync(deps.assistantBufferDir, { recursive: true, force: true });
    fs.rmSync(deps.toolBufferDir, { recursive: true, force: true });
  });

  it("captureUser stores the prompt with cursor metadata and always continues", async () => {
    const out = await captureUser(common("beforeSubmitPrompt", {
      prompt: "  remember this  ",
      attachments: [{ type: "file", file_path: "/repo/a.js" }],
    }), deps);

    expect(out).toEqual({ continue: true });
    expect(deps.createApi).toHaveBeenCalledWith("/repo");
    expect(deps.api.storeEpisodic.mock.calls).toEqual([[
      "remember this",
      "user",
      deps.logger,
      { client: "cursor", cwd: "/repo", session_id: "conv-1" },
    ]]);
    expect(JSON.stringify(deps.api.storeEpisodic.mock.calls)).not.toContain(EMAIL);
  });

  it("captureUser continues without an API call on an empty prompt", async () => {
    await expect(captureUser(common("beforeSubmitPrompt", { prompt: "  " }), deps))
      .resolves.toEqual(CONTINUE);
    expect(deps.createApi).not.toHaveBeenCalled();
  });

  it("captureUser continues when key resolution fails (fail-open)", async () => {
    deps.createApi.mockRejectedValueOnce(new Error("no key"));
    await expect(captureUser(common("beforeSubmitPrompt", { prompt: "hi" }), deps))
      .resolves.toEqual(CONTINUE);
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("CURSOR CAPTURE ERROR (user)"));
  });

  it("captureUser continues when the API store throws", async () => {
    deps.api.storeEpisodic.mockRejectedValueOnce(new Error("503"));
    await expect(captureUser(common("beforeSubmitPrompt", { prompt: "hi" }), deps))
      .resolves.toEqual(CONTINUE);
  });

  it("captureAssistant stores the response text with cursor metadata", async () => {
    await captureAssistant(common("afterAgentResponse", { text: "done" }), deps);

    expect(deps.api.storeEpisodic.mock.calls).toEqual([[
      "done",
      "assistant",
      deps.logger,
      { client: "cursor", cwd: "/repo", session_id: "conv-1" },
    ]]);
  });

  it("postToolUse events are buffered per generation and summarized with the response", async () => {
    await captureToolUse(common("postToolUse", {
      tool_name: "Shell",
      tool_use_id: "t1",
      tool_input: { command: "npm test" },
      tool_output: '{"exitCode":1,"stderr":"2 failed"}',
      cwd: "/repo",
    }), deps);
    await captureToolUse(common("postToolUse", {
      tool_name: "Read",
      tool_use_id: "t2",
      tool_input: { path: "/repo/a.js", token: "sk-1234567890abcdef" },
      tool_output: "file body",
    }), deps);
    expect(deps.api.storeEpisodic).not.toHaveBeenCalled();

    await captureAssistant(common("afterAgentResponse", { text: "fixed" }), deps);

    expect(deps.api.storeEpisodic).toHaveBeenCalledTimes(2);
    const [summary, role, , metadata] = deps.api.storeEpisodic.mock.calls[1];
    expect(role).toBe("assistant");
    expect(metadata).toEqual({ client: "cursor", cwd: "/repo", session_id: "conv-1" });
    expect(summary).toContain("Tools: Shell x1, Read x1");
    expect(summary).toContain("Shell: npm test -> exit 1: 2 failed");
    expect(summary).not.toContain("sk-1234567890abcdef");
    expect(summary).not.toContain(EMAIL);

    // buffer is cleared once stored: the next response carries no summary
    deps.api.storeEpisodic.mockClear();
    await captureAssistant(common("afterAgentResponse", { text: "again" }), deps);
    expect(deps.api.storeEpisodic).toHaveBeenCalledOnce();
  });

  it("tool events from another generation are not attached to this response", async () => {
    await captureToolUse(common("postToolUse", {
      generation_id: "gen-other",
      tool_name: "Shell",
      tool_input: { command: "ls" },
      tool_output: '{"exitCode":0}',
    }), deps);

    await captureAssistant(common("afterAgentResponse", { text: "done" }), deps);
    expect(deps.api.storeEpisodic).toHaveBeenCalledOnce();
  });

  it("captureAssistant is fail-open when the API is unavailable", async () => {
    deps.createApi.mockRejectedValue(new Error("no key"));
    await expect(captureAssistant(common("afterAgentResponse", { text: "x" }), deps))
      .resolves.toBeUndefined();
    expect(deps.logger.error).toHaveBeenCalledWith(expect.stringContaining("CURSOR CAPTURE ERROR (assistant)"));
  });
});

describe("Cursor finishHook", () => {
  it("writes the response before one self-update, then exits 0", async () => {
    const order = [];
    await finishHook(CONTINUE, {
      write: (text) => order.push(`write:${text}`),
      update: async () => { order.push("update"); },
      exit: (code) => { order.push(`exit:${code}`); },
    });
    expect(order).toEqual(['write:{"continue":true}', "update", "exit:0"]);
  });

  it("writes {} and exits 0 when self-update throws", async () => {
    const writes = [];
    const exits = [];
    await finishHook(undefined, {
      write: (text) => writes.push(text),
      update: async () => { throw new Error("offline"); },
      exit: (code) => exits.push(code),
    });
    expect(writes).toEqual(["{}"]);
    expect(exits).toEqual([0]);
  });
});

describe("Cursor hook wrappers (spawned, sandboxed)", () => {
  let env;
  let preloadFile;
  let fetchLog;

  beforeEach(async () => {
    env = await makeTestEnv({ clients: ["cursor"] });
    fs.mkdirSync(path.dirname(env.paths.globalKey), { recursive: true });
    fs.writeFileSync(env.paths.globalKey, "test-key\n", { mode: 0o600 });
    fetchLog = path.join(env.root, "fetch.ndjson");
    preloadFile = path.join(env.root, "fetch-preload.mjs");
    fs.writeFileSync(preloadFile, `
      import fs from "node:fs";
      globalThis.fetch = async (url, opts = {}) => {
        fs.appendFileSync(process.env.MIDBRAIN_TEST_FETCH_LOG, JSON.stringify({
          url: String(url),
          body: opts.body ? JSON.parse(opts.body) : undefined,
        }) + "\\n");
        if (process.env.MIDBRAIN_TEST_FETCH_MODE === "throw") throw new Error("network down");
        return { ok: true, status: 201, text: async () => "", json: async () => ({}) };
      };
    `);
  });

  afterEach(async () => {
    await env.restore();
  });

  function run(role, input, mode = "ok") {
    return spawnSync(process.execPath, [
      "--import", pathToFileURL(preloadFile).href,
      path.join(REPO_ROOT, "plugins", "cursor", `capture-${role}.mjs`),
    ], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 15000,
      env: env.childEnv({ MIDBRAIN_TEST_FETCH_LOG: fetchLog, MIDBRAIN_TEST_FETCH_MODE: mode }),
    });
  }

  function requests() {
    if (!fs.existsSync(fetchLog)) return [];
    return fs.readFileSync(fetchLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  it("beforeSubmitPrompt posts the prompt with metadata and answers continue", () => {
    const project = path.join(env.home, "work", "repo");
    const result = run("user", common("beforeSubmitPrompt", {
      prompt: "ship it",
      workspace_roots: [project],
    }));

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
    const posts = requests().filter((r) => r.url.includes("/memories/episodic"));
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      text: "ship it",
      role: "user",
      memory_metadata: { client: "cursor", cwd: "~/work/repo", session_id: "conv-1" },
    });
    expect(JSON.stringify(requests())).not.toContain(EMAIL);
  });

  it("beforeSubmitPrompt still answers continue when the API is unreachable", () => {
    const result = run("user", common("beforeSubmitPrompt", { prompt: "offline" }), "throw");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });

    // the failed POST lands in the offline cache for the boot-time drain
    const cacheDir = path.join(env.home, ".cache", "midbrain");
    const cached = fs.readdirSync(cacheDir).filter((name) => name.endsWith(".ndjson"))
      .map((name) => fs.readFileSync(path.join(cacheDir, name), "utf8")).join("");
    expect(cached).toContain('"text":"offline"');
    expect(cached).toContain('"client":"cursor"');
    expect(cached).not.toContain(EMAIL);
  });

  it("beforeSubmitPrompt answers continue on malformed stdin", () => {
    const result = spawnSync(process.execPath, [
      path.join(REPO_ROOT, "plugins", "cursor", "capture-user.mjs"),
    ], { input: "not json", encoding: "utf8", timeout: 15000, env: env.childEnv() });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ continue: true });
  });

  it("postToolUse + afterAgentResponse round-trip posts the answer and tool summary", () => {
    const tool = run("tool", common("postToolUse", {
      tool_name: "Shell",
      tool_use_id: "abc",
      tool_input: { command: "npm test" },
      tool_output: '{"exitCode":0,"stdout":"ok"}',
    }));
    expect(tool.status).toBe(0);
    expect(tool.stdout).toBe("{}");

    const assistant = run("assistant", common("afterAgentResponse", { text: "all green" }));
    expect(assistant.status).toBe(0);
    expect(assistant.stdout).toBe("{}");

    const texts = requests().filter((r) => r.url.includes("/memories/episodic")).map((r) => r.body.text);
    expect(texts[0]).toBe("all green");
    expect(texts[1]).toContain("Shell: npm test -> success");
    expect(JSON.stringify(requests())).not.toContain(EMAIL);
  });
});
