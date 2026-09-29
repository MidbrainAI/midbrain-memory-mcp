/**
 * Unit tests for the OpenClaw capture plugin (plugins/openclaw/index.js).
 * The API, logger and offline cache are injected, so nothing reaches the
 * network or the real cache; the default-export test runs in a sandbox home.
 * Message shapes mirror a live OpenClaw 2026.9.6 `agent_end` event.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";

import { makeTestEnv } from "./helpers/test-env.mjs";
import plugin, {
  PLUGIN_ID, createAgentEndHandler, extractTurn, messageText,
} from "../plugins/openclaw/index.js";

const user = (text, timestamp = 1) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
const toolCall = () => ({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "exec", arguments: {} }] });
const toolResult = () => ({ role: "toolResult", content: [{ type: "text", text: "tool output" }] });
const CTX = {
  runId: "run-1",
  agentId: "main",
  sessionKey: "agent:main:main",
  sessionId: "sess-1",
  workspaceDir: "/home/tester/.openclaw/workspace",
  trigger: "user",
};

describe("messageText", () => {
  it("reads string content and joins text parts, ignoring other parts", () => {
    expect(messageText({ content: "  hi  " })).toBe("hi");
    expect(messageText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(messageText({ content: 42 })).toBe("");
    expect(messageText(null)).toBe("");
  });
});

describe("extractTurn", () => {
  it("takes the last user prompt and the final assistant text after it", () => {
    const turn = extractTurn([
      user("first", 1), assistant("old reply"),
      user("second", 2), toolCall(), toolResult(), assistant("final answer"),
    ]);
    expect(turn).toEqual({ user: "second", assistant: "final answer", key: "2:6" });
  });

  it("returns an empty reply when the run produced no assistant text", () => {
    expect(extractTurn([user("hi"), toolCall()])).toMatchObject({ user: "hi", assistant: "" });
  });

  it("returns null without a user prompt", () => {
    expect(extractTurn([])).toBeNull();
    expect(extractTurn([assistant("hello")])).toBeNull();
    expect(extractTurn(undefined)).toBeNull();
  });
});

describe("createAgentEndHandler", () => {
  let api;
  let createApi;
  let logger;
  let cache;

  beforeEach(() => {
    api = { storeEpisodic: vi.fn(async () => true), cacheScope: "scope-1" };
    createApi = vi.fn(async () => api);
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    cache = vi.fn();
  });

  const handler = (extra = {}) => createAgentEndHandler({ createApi, logger, appendToCache: cache, ...extra });
  const stored = () => api.storeEpisodic.mock.calls.map(([text, role, , metadata]) => ({ text, role, metadata }));

  it("stores the user prompt then the assistant reply with OpenClaw metadata", async () => {
    await handler()({ success: true, messages: [user("remember Pixel"), assistant("Noted.")] }, CTX);

    const metadata = { client: "openclaw", cwd: "~/.openclaw/workspace", session_id: "sess-1" };
    expect(createApi).toHaveBeenCalledWith(CTX.workspaceDir);
    expect(stored()).toEqual([
      { text: "remember Pixel", role: "user", metadata: expect.objectContaining({ client: "openclaw", session_id: "sess-1" }) },
      { text: "Noted.", role: "assistant", metadata: expect.objectContaining({ client: "openclaw", session_id: "sess-1" }) },
    ]);
    expect(stored()[0].metadata.cwd).toMatch(/\.openclaw[\\/]workspace$/);
    expect(Object.keys(stored()[0].metadata).sort()).toEqual(Object.keys(metadata).sort());
  });

  it("skips failed runs, empty (incognito) histories and cron/heartbeat triggers", async () => {
    const onEnd = handler();
    await onEnd({ success: false, messages: [user("a"), assistant("b")] }, CTX);
    await onEnd({ success: true, messages: [] }, CTX);
    await onEnd({ success: true, messages: [user("tick"), assistant("ok")] }, { ...CTX, trigger: "heartbeat" });
    await onEnd({ success: true, messages: [user("job"), assistant("done")] }, { ...CTX, trigger: "cron" });
    expect(api.storeEpisodic).not.toHaveBeenCalled();
  });

  it("captures runs that carry no trigger", async () => {
    await handler()({ success: true, messages: [user("hi"), assistant("hello")] }, { ...CTX, trigger: undefined });
    expect(stored().map((s) => s.role)).toEqual(["user", "assistant"]);
  });

  it("stores each turn once per session, even though agent_end repeats the history", async () => {
    const onEnd = handler();
    const turn1 = [user("one", 1), assistant("r1")];
    await onEnd({ success: true, messages: turn1 }, CTX);
    await onEnd({ success: true, messages: turn1 }, CTX);
    await onEnd({ success: true, messages: [...turn1, user("two", 2), assistant("r2")] }, CTX);
    expect(stored().map((s) => s.text)).toEqual(["one", "r1", "two", "r2"]);
  });

  it("stores only the prompt when the run produced no assistant text", async () => {
    await handler()({ success: true, messages: [user("q"), toolCall()] }, CTX);
    expect(stored().map((s) => s.role)).toEqual(["user"]);
  });

  it("caches the entry when a store exceeds the time limit", async () => {
    api.storeEpisodic = vi.fn(() => new Promise(() => {}));
    await handler({ storeTimeLimitMs: 20 })({ success: true, messages: [user("slow"), assistant("")] }, CTX);
    expect(cache).toHaveBeenCalledWith(
      { text: "slow", role: "user", memory_metadata: expect.objectContaining({ client: "openclaw" }) },
      "scope-1",
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("OPENCLAW CAPTURE TIMEOUT (user)"));
  });

  it("never throws when the API cannot be created, and retries on the next turn", async () => {
    createApi.mockRejectedValueOnce(new Error("No API key configured"));
    const onEnd = handler();
    await expect(onEnd({ success: true, messages: [user("a", 1)] }, CTX)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("OPENCLAW CAPTURE ERROR (user): No API key configured");

    await onEnd({ success: true, messages: [user("a", 1), assistant("b"), user("c", 2)] }, CTX);
    expect(stored().map((s) => s.text)).toEqual(["c"]);
  });

  it("never throws on a malformed event", async () => {
    const onEnd = handler();
    await expect(onEnd(undefined, undefined)).resolves.toBeUndefined();
    await expect(onEnd({ success: true, messages: "nope" }, CTX)).resolves.toBeUndefined();
  });
});

describe("plugin entry", () => {
  let env;
  beforeEach(async () => { env = await makeTestEnv(); });
  afterEach(async () => { await env.restore(); });

  it("registers one agent_end handler under the manifest id", () => {
    const on = vi.fn();
    plugin.register({ on });
    expect(plugin.id).toBe(PLUGIN_ID);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on).toHaveBeenCalledWith("agent_end", expect.any(Function));
  });

  it("matches the manifest id and package entry OpenClaw loads", async () => {
    const dir = new URL("../plugins/openclaw/", import.meta.url);
    const manifest = JSON.parse(await fs.readFile(new URL("openclaw.plugin.json", dir), "utf8"));
    const pkg = JSON.parse(await fs.readFile(new URL("package.json", dir), "utf8"));
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.configSchema).toEqual({ type: "object", additionalProperties: false });
    expect(pkg.openclaw.extensions).toEqual(["./index.js"]);
  });
});
