/**
 * Unit tests for shared/midbrain-api.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MidbrainApi } from "../shared/midbrain-api.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("MidbrainApi constants", () => {
  it("API_BASE_URL is https", () => {
    expect(MidbrainApi.API_BASE_URL).toMatch(/^https:\/\//);
  });

  it("all endpoints start with API_BASE_URL", () => {
    const base = MidbrainApi.API_BASE_URL.replace(/[/.]/g, "\\$&");
    for (const ep of [MidbrainApi.SEARCH_SEMANTIC, MidbrainApi.SEARCH_LEXICAL, MidbrainApi.EPISODIC, MidbrainApi.SEMANTIC_FILES]) {
      expect(ep).toMatch(new RegExp(`^${base}`));
    }
  });

  it("DEFAULT_SEARCH_LIMIT is 10", () => {
    expect(MidbrainApi.DEFAULT_SEARCH_LIMIT).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// storeEpisodic
// ---------------------------------------------------------------------------

describe("MidbrainApi.storeEpisodic", () => {
  let fetchSpy;
  let api;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, status: 200 });
    api = new MidbrainApi("test-key", "test-source");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("POSTs to the episodic endpoint with correct body", async () => {
    const log = vi.fn();
    api.storeEpisodic("hello world", "user", log);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(MidbrainApi.EPISODIC);
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(opts.body)).toEqual({ text: "hello world", role: "user" });
  });

  it.each(["opencode", "claude", "codex"])(
    "includes %s client memory_metadata in POST body",
    async (client) => {
      const log = vi.fn();
      api.storeEpisodic("hello", "assistant", log, { client });

      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());

      const [, opts] = fetchSpy.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({
        text: "hello",
        role: "assistant",
        memory_metadata: { client },
      });
    },
  );

  it("omits memory_metadata from POST body when metadata not provided", async () => {
    const log = vi.fn();
    api.storeEpisodic("hello", "user", log);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ text: "hello", role: "user" });
    expect(body).not.toHaveProperty("memory_metadata");
  });

  it("calls debug log function on success", async () => {
    const log = vi.fn();
    api.storeEpisodic("msg", "assistant", log);

    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("STORED")));
  });

  it("returns the POST promise so hook callers can await storage", async () => {
    let resolveFetch;
    fetchSpy.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));
    const log = vi.fn();

    const promise = api.storeEpisodic("msg", "assistant", log);
    let settled = false;
    promise.then(() => { settled = true; });
    await Promise.resolve();

    expect(promise).toBeInstanceOf(Promise);
    expect(settled).toBe(false);

    resolveFetch({ ok: true, status: 201 });
    await expect(promise).resolves.toBe(true);

    expect(log).toHaveBeenCalledWith("STORED: status=201");
  });

  it("returns false and logs when fetch fails", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    const log = vi.fn();

    await expect(api.storeEpisodic("msg", "user", log)).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("STORE ERROR"));
  });

  it("returns false and logs when the API returns a non-2xx status", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue("temporarily unavailable"),
    });
    const log = vi.fn();

    await expect(api.storeEpisodic("msg", "user", log)).resolves.toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("STORE ERROR: status=503"));
  });
});

// ---------------------------------------------------------------------------
// create factory
// ---------------------------------------------------------------------------

describe("MidbrainApi.create", () => {
  it("creates an instance from a client adapter", async () => {
    const mockClient = { resolveKey: vi.fn().mockResolvedValue({ key: "abc123", source: "test" }) };
    const api = await MidbrainApi.create(mockClient, "/some/dir");
    expect(api.keySource).toBe("test");
    expect(api.keyFingerprint).toBe("...c123");
    expect(mockClient.resolveKey).toHaveBeenCalledWith("/some/dir");
  });

  it("throws when no key found", async () => {
    const mockClient = { resolveKey: vi.fn().mockResolvedValue(null) };
    await expect(MidbrainApi.create(mockClient)).rejects.toThrow(/No API key/);
  });
});
