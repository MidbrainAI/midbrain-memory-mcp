/**
 * Unit tests for the OpenClaw capture plugin (plugins/openclaw/index.js).
 * The API, logger and offline cache are injected, so nothing reaches the
 * network or the real cache; the default-export test runs in a sandbox home.
 * Message shapes mirror a live OpenClaw 2026.9.6 `agent_end` event.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";

import { makeTestEnv } from "./helpers/test-env.mjs";
import { formatIdentityContext } from "../shared/identity-context.mjs";
import plugin, {
  PLUGIN_ID, createAgentEndHandler, createPromptBuildHandler, extractTurn, messageText,
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

  it("stores a failed-model retry once, then the reply when one finally arrives", async () => {
    const onEnd = handler();
    await onEnd({ success: true, messages: [user("same", 1)] }, CTX);
    await onEnd({ success: true, messages: [user("same", 2)] }, CTX);
    await onEnd({ success: true, messages: [user("same", 3)] }, CTX);
    await onEnd({ success: true, messages: [user("same", 4), assistant("ok")] }, CTX);
    await onEnd({ success: true, messages: [user("same", 5), assistant("again")] }, CTX);
    expect(stored().map((s) => s.text)).toEqual(["same", "ok", "same", "again"]);
  });

  it("stores only the prompt when the run produced no assistant text", async () => {
    await handler()({ success: true, messages: [user("q"), toolCall()] }, CTX);
    expect(stored().map((s) => s.role)).toEqual(["user"]);
  });

  it("caches a store that is still in flight when the process exits", async () => {
    api.storeEpisodic = vi.fn(() => new Promise(() => {}));
    const running = handler({ storeTimeLimitMs: 60_000 })(
      { success: true, messages: [user("slow"), assistant("reply")] },
      CTX,
    );
    await vi.waitFor(() => expect(api.storeEpisodic).toHaveBeenCalled());
    process.emit("exit", 0);
    expect(cache.mock.calls.map(([entry]) => entry.role)).toEqual(["user", "assistant"]);
    expect(cache.mock.calls.map(([entry]) => entry.text)).toEqual(["slow", "reply"]);
    running.catch(() => {});
  });

  it("stops waiting for a slow store but never caches it itself: a late success is stored once", async () => {
    let finish;
    api.storeEpisodic = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    await handler({ storeTimeLimitMs: 20 })({ success: true, messages: [user("slow"), assistant("")] }, CTX);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("OPENCLAW CAPTURE SLOW (user)"));
    expect(cache).not.toHaveBeenCalled();

    finish(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.emit("exit", 0);
    // stored live, so there is nothing left for the exit flush to replay
    expect(cache).not.toHaveBeenCalled();
    expect(api.storeEpisodic).toHaveBeenCalledTimes(1);
  });

  it("leaves a late failure to the API's own cache write instead of caching twice", async () => {
    let fail;
    api.storeEpisodic = vi.fn(() => new Promise((resolve) => { fail = resolve; }));
    await handler({ storeTimeLimitMs: 20 })({ success: true, messages: [user("slow"), assistant("")] }, CTX);
    fail(false); // MidbrainApi.storeEpisodic returns false after appending to the cache itself
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.emit("exit", 0);
    expect(cache).not.toHaveBeenCalled();
  });

  it("holds identical prompts from two sessions separately for the exit flush", async () => {
    api.storeEpisodic = vi.fn(() => new Promise(() => {}));
    const onEnd = handler({ storeTimeLimitMs: 60_000 });
    const a = onEnd({ success: true, messages: [user("yes")] }, { ...CTX, sessionKey: "a", sessionId: "sa" });
    const b = onEnd({ success: true, messages: [user("yes")] }, { ...CTX, sessionKey: "b", sessionId: "sb" });
    await vi.waitFor(() => expect(api.storeEpisodic).toHaveBeenCalledTimes(2));
    process.emit("exit", 0);
    expect(cache.mock.calls.map(([entry]) => entry.memory_metadata.session_id)).toEqual(["sa", "sb"]);
    a.catch(() => {});
    b.catch(() => {});
  });

  it("drops the turn, with a log line, when the API does not resolve within the limit", async () => {
    createApi.mockImplementationOnce(() => new Promise(() => {}));
    await handler({ storeTimeLimitMs: 20 })({ success: true, messages: [user("q"), assistant("a")] }, CTX);
    expect(api.storeEpisodic).not.toHaveBeenCalled();
    expect(cache).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("key/host not resolved after 20ms"));
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

  it("preserves unsigned persona and profile examples", async () => {
    const block = formatIdentityContext({ persona: "Be concise." });
    await handler()({ success: true, messages: [user("q"), assistant(`${block}\n\nAnswer.`)] }, CTX);
    expect(stored().map((s) => s.text)).toEqual(["q", `${block}\n\nAnswer.`]);
  });
});

describe("createPromptBuildHandler", () => {
  let api;
  let createApi;
  let logger;

  beforeEach(() => {
    api = {
      getPersona: vi.fn(async () => "Be concise."),
      getProfile: vi.fn(async () => "Works at CX2."),
    };
    createApi = vi.fn(async () => api);
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  });

  const handler = (extra = {}) => createPromptBuildHandler({ createApi, logger, ...extra });

  it("appends the persona and profile to the system prompt", async () => {
    const result = await handler()({ prompt: "hi", messages: [] }, CTX);
    expect(createApi).toHaveBeenCalledWith(CTX.workspaceDir);
    expect(result).toEqual({
      appendSystemContext: formatIdentityContext({ persona: "Be concise.", profile: "Works at CX2." }),
    });
  });

  it("adds nothing when both fields are blank", async () => {
    api.getPersona.mockResolvedValue(null);
    api.getProfile.mockResolvedValue(null);
    await expect(handler()({ prompt: "hi" }, CTX)).resolves.toBeUndefined();
  });

  it("skips cron and heartbeat runs", async () => {
    const onBuild = handler();
    await expect(onBuild({ prompt: "tick" }, { ...CTX, trigger: "heartbeat" })).resolves.toBeUndefined();
    await expect(onBuild({ prompt: "job" }, { ...CTX, trigger: "cron" })).resolves.toBeUndefined();
    expect(createApi).not.toHaveBeenCalled();
  });

  it("reuses one API per workspace across turns", async () => {
    const onBuild = handler();
    await onBuild({ prompt: "a" }, CTX);
    await onBuild({ prompt: "b" }, CTX);
    expect(createApi).toHaveBeenCalledTimes(1);
    expect(api.getPersona).toHaveBeenCalledTimes(2);
  });

  it("adds nothing, with a log line, when the API cannot be created", async () => {
    createApi.mockRejectedValueOnce(new Error("No API key configured"));
    await expect(handler()({ prompt: "hi" }, CTX)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("OPENCLAW IDENTITY ERROR: No API key configured");
  });

  it("adds nothing when the API does not resolve within the limit", async () => {
    createApi.mockImplementationOnce(() => new Promise(() => {}));
    await expect(handler({ timeLimitMs: 20 })({ prompt: "hi" }, CTX)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("not loaded after 20ms"));
  });
});

describe("plugin entry", () => {
  let env;
  beforeEach(async () => { env = await makeTestEnv(); });
  afterEach(async () => { await env.restore(); });

  it("registers the prompt-build and agent_end handlers under the manifest id", () => {
    const on = vi.fn();
    plugin.register({ on });
    expect(plugin.id).toBe(PLUGIN_ID);
    expect(on.mock.calls.map(([event]) => event)).toEqual(["before_prompt_build", "agent_end"]);
    for (const [, fn] of on.mock.calls) expect(fn).toEqual(expect.any(Function));
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
