/**
 * Unit tests for plugins/hermes/common.mjs (capture runtime).
 *
 * The MidBrain API is stubbed via injected deps — no network, no real key.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CONTEXT_MARKER_END, CONTEXT_MARKER_START } from "../shared/pk-inject.mjs";

const {
  captureUser,
  captureAssistant,
  finishHook,
} = await import("../plugins/hermes/common.mjs");

function makeDeps() {
  const stored = [];
  const deps = {
    createApi: vi.fn(async () => ({
      keySource: "global-config",
      storeEpisodic: vi.fn(async (text, role, _logger, metadata) => {
        stored.push({ text, role, metadata });
        return true;
      }),
      searchProcedural: vi.fn(async () => []),
    })),
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { deps, stored };
}

describe("captureUser", () => {
  beforeEach(() => { delete process.env.MIDBRAIN_ENABLE_PK_INJECTION; });

  it("stores the trimmed user prompt with hermes metadata", async () => {
    const { deps, stored } = makeDeps();
    await captureUser({ extra: { user_message: "  hello world  " }, cwd: "/proj" }, deps);
    expect(stored).toEqual([{ text: "hello world", role: "user", metadata: { client: "hermes" } }]);
  });

  it("passes cwd through as the project dir for key resolution", async () => {
    const { deps } = makeDeps();
    await captureUser({ extra: { user_message: "hi" }, cwd: "/proj" }, deps);
    expect(deps.createApi).toHaveBeenCalledWith("/proj");
  });

  it("accepts alternative payload field names", async () => {
    const { deps, stored } = makeDeps();
    await captureUser({ extra: { message: "via message" } }, deps);
    expect(stored[0].text).toBe("via message");
  });

  it("no-ops on an empty prompt", async () => {
    const { deps, stored } = makeDeps();
    const out = await captureUser({ extra: {} }, deps);
    expect(stored).toHaveLength(0);
    expect(out).toBeUndefined();
    expect(deps.createApi).not.toHaveBeenCalled();
  });

  it("does not inject PK context by default", async () => {
    const { deps } = makeDeps();
    const out = await captureUser({ extra: { user_message: "hi" } }, deps);
    expect(out).toBeUndefined();
  });

  it("returns a context payload when PK injection is enabled", async () => {
    process.env.MIDBRAIN_ENABLE_PK_INJECTION = "1";
    const { deps } = makeDeps();
    deps.createApi = vi.fn(async () => ({
      storeEpisodic: vi.fn(async () => true),
      searchProcedural: vi.fn(async () => [{ id: "pk1", title: "T", content: "C" }]),
    }));
    const out = await captureUser({ extra: { user_message: "hi" } }, deps);
    expect(out).toBeDefined();
    expect(typeof out.context).toBe("string");
    expect(out.context.length).toBeGreaterThan(0);
  });

  it("fails open when the API cannot be created", async () => {
    const { deps } = makeDeps();
    deps.createApi = vi.fn(async () => { throw new Error("no key"); });
    const out = await captureUser({ extra: { user_message: "hi" } }, deps);
    expect(out).toBeUndefined();
  });
});

describe("captureAssistant", () => {
  beforeEach(() => { delete process.env.MIDBRAIN_ENABLE_PK_INJECTION; });

  it("stores the current Hermes assistant_response wire field with metadata", async () => {
    const { deps, stored } = makeDeps();
    await captureAssistant({ extra: { assistant_response: "the answer" } }, deps);
    expect(stored).toEqual([{ text: "the answer", role: "assistant", metadata: { client: "hermes" } }]);
  });

  it("preserves marker-like assistant text verbatim when PK injection is disabled", async () => {
    const { deps, stored } = makeDeps();
    const literal = [
      "literal example",
      CONTEXT_MARKER_START,
      "<!-- mb:ctx-meta nonce=fake sig=deadbeef -->",
      "## Procedural knowledge:",
      "<!-- mb:pk 123 -->",
      CONTEXT_MARKER_END,
    ].join("\n");
    await captureAssistant({ extra: { assistant_response: literal } }, deps);
    expect(stored[0].text).toBe(literal);
  });

  it("logs only the selected key source after API creation", async () => {
    const { deps } = makeDeps();
    await captureAssistant({ extra: { assistant_response: "answer" } }, deps);
    expect(deps.logger.debug).toHaveBeenCalledWith("KEY SOURCE: global-config");
    expect(deps.logger.debug.mock.calls.flat().join(" ")).not.toMatch(/test-key|fingerprint/i);
  });

  it("no-ops on an empty response", async () => {
    const { deps, stored } = makeDeps();
    await captureAssistant({ extra: { response_text: "   " } }, deps);
    expect(stored).toHaveLength(0);
  });

  it("fails open when storeEpisodic throws", async () => {
    const { deps } = makeDeps();
    deps.createApi = vi.fn(async () => ({
      storeEpisodic: vi.fn(async () => { throw new Error("boom"); }),
    }));
    await expect(
      captureAssistant({ extra: { response_text: "x" } }, deps),
    ).resolves.toBeUndefined();
  });
});

describe("finishHook", () => {
  it("writes required JSON before awaiting exactly one self-update", async () => {
    const order = [];
    await finishHook({ context: "ok" }, {
      write: (text) => order.push(`write:${text}`),
      update: async () => { order.push("update"); },
      exit: (code) => { order.push(`exit:${code}`); },
    });
    expect(order).toEqual(['write:{"context":"ok"}', "update", "exit:0"]);
  });

  it("fails open when self-update throws without changing stdout", async () => {
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
