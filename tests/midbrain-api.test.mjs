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
    for (const ep of [MidbrainApi.SEARCH_SEMANTIC, MidbrainApi.SEARCH_LEXICAL, MidbrainApi.EPISODIC, MidbrainApi.SEMANTIC_FILES, MidbrainApi.SEARCH_PROCEDURAL]) {
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
// searchProcedural
// ---------------------------------------------------------------------------

describe("MidbrainApi.searchProcedural", () => {
  let fetchSpy;
  let api;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    api = new MidbrainApi("test-key", "test-source");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const MOCK_RESULTS = [
    { id: 1, title: "Python", content: "use ruff", source_ids: [], score: 0.9 },
    { id: 3, title: "DevOps", content: "pin images", source_ids: [5], score: 0.7 },
  ];

  function okJson(body) {
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  }

  it("GETs the search/procedural endpoint with query, limit, min_score", async () => {
    fetchSpy.mockReturnValueOnce(okJson(MOCK_RESULTS));
    await api.searchProcedural({ query: "python linting", limit: 3, minScore: 0.6 });

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url] = fetchSpy.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/memories/search/procedural");
    expect(parsed.searchParams.get("query")).toBe("python linting");
    expect(parsed.searchParams.get("limit")).toBe("3");
    expect(parsed.searchParams.get("min_score")).toBe("0.6");
  });

  it("sends Authorization header with Bearer token", async () => {
    fetchSpy.mockReturnValueOnce(okJson(MOCK_RESULTS));
    await api.searchProcedural({ query: "test" });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer test-key");
  });

  it("appends exclude_ids as repeated query params", async () => {
    fetchSpy.mockReturnValueOnce(okJson([]));
    await api.searchProcedural({ query: "test", excludeIds: [1, 3, 7] });

    const [url] = fetchSpy.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.getAll("exclude_ids")).toEqual(["1", "3", "7"]);
  });

  it("omits exclude_ids param when array is empty", async () => {
    fetchSpy.mockReturnValueOnce(okJson([]));
    await api.searchProcedural({ query: "test", excludeIds: [] });

    const [url] = fetchSpy.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.getAll("exclude_ids")).toEqual([]);
  });

  it("uses default limit=5 and min_score=0.5 when not specified", async () => {
    fetchSpy.mockReturnValueOnce(okJson([]));
    await api.searchProcedural({ query: "anything" });

    const [url] = fetchSpy.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.get("limit")).toBe("5");
    expect(parsed.searchParams.get("min_score")).toBe("0.5");
  });

  it("returns parsed results on success", async () => {
    fetchSpy.mockReturnValueOnce(okJson(MOCK_RESULTS));
    const results = await api.searchProcedural({ query: "python" });
    expect(results).toEqual(MOCK_RESULTS);
  });

  it("returns empty array on non-OK response (never throws)", async () => {
    fetchSpy.mockReturnValueOnce(
      Promise.resolve({ ok: false, status: 503, text: async () => "error" })
    );
    const results = await api.searchProcedural({ query: "test" });
    expect(results).toEqual([]);
  });

  it("returns empty array when fetch throws a network error (never throws)", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    const results = await api.searchProcedural({ query: "test" });
    expect(results).toEqual([]);
  });

  it("returns empty array when fetch is aborted (timeout) (never throws)", async () => {
    const err = new DOMException("signal timed out", "TimeoutError");
    fetchSpy.mockRejectedValueOnce(err);
    const results = await api.searchProcedural({ query: "test" });
    expect(results).toEqual([]);
  });

  it("passes AbortSignal.timeout to fetch", async () => {
    fetchSpy.mockReturnValueOnce(okJson([]));
    await api.searchProcedural({ query: "test", timeoutMs: 2000 });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.signal).toBeDefined();
    // AbortSignal.timeout returns an AbortSignal instance
    expect(typeof opts.signal.aborted).toBe("boolean");
  });

  it("SEARCH_PROCEDURAL static getter returns the correct URL", () => {
    expect(MidbrainApi.SEARCH_PROCEDURAL).toContain("/memories/search/procedural");
    expect(MidbrainApi.SEARCH_PROCEDURAL).toMatch(/^https:\/\//);
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
