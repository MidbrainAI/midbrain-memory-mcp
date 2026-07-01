/**
 * Unit tests for plugins/hermes/common.mjs (capture runtime).
 *
 * The MidBrain API is stubbed via injected deps — no network, no real key.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { captureUser, captureAssistant } = await import("../plugins/hermes/common.mjs");

function makeDeps() {
  const stored = [];
  const deps = {
    createApi: vi.fn(async () => ({
      storeEpisodic: vi.fn(async (text, role, _logger, metadata) => {
        stored.push({ text, role, metadata });
        return true;
      }),
      searchProcedural: vi.fn(async () => []),
    })),
    logger: { info() {}, debug() {}, warn() {}, error() {} },
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
  it("stores the assistant response with hermes metadata", async () => {
    const { deps, stored } = makeDeps();
    await captureAssistant({ extra: { response_text: "the answer" } }, deps);
    expect(stored).toEqual([{ text: "the answer", role: "assistant", metadata: { client: "hermes" } }]);
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
