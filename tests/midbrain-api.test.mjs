/**
 * Unit tests for shared/midbrain-api.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { MidbrainApi } from "../shared/midbrain-api.mjs";
import {
  _setCachePath,
  readAndClearCache,
  hasCachedEntries,
  appendToCache,
} from "../shared/episodic-cache.mjs";

/** Logger-shaped mock: each level method is an independent spy. */
function makeLog() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

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
    const log = makeLog();
    api.storeEpisodic("hello world", "user", log);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(MidbrainApi.EPISODIC);
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer test-key");
    expect(opts.headers["User-Agent"]).toBe("midbrain-memory-mcp");
    expect(JSON.parse(opts.body)).toEqual({ text: "hello world", role: "user" });
  });

  it.each(["opencode", "claude", "codex"])(
    "includes %s client memory_metadata in POST body",
    async (client) => {
      const log = makeLog();
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
    const log = makeLog();
    api.storeEpisodic("hello", "user", log);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());

    const [, opts] = fetchSpy.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ text: "hello", role: "user" });
    expect(body).not.toHaveProperty("memory_metadata");
  });

  it("calls debug log function on success", async () => {
    const log = makeLog();
    api.storeEpisodic("msg", "assistant", log);

    await vi.waitFor(() => expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("STORED")));
  });

  it("returns the POST promise so hook callers can await storage", async () => {
    let resolveFetch;
    fetchSpy.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));
    const log = makeLog();

    const promise = api.storeEpisodic("msg", "assistant", log);
    let settled = false;
    promise.then(() => { settled = true; });
    await Promise.resolve();

    expect(promise).toBeInstanceOf(Promise);
    expect(settled).toBe(false);

    resolveFetch({ ok: true, status: 201 });
    await expect(promise).resolves.toBe(true);

    expect(log.debug).toHaveBeenCalledWith("STORED: status=201");
  });

  it("returns false and logs when fetch fails", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    const log = makeLog();

    await expect(api.storeEpisodic("msg", "user", log)).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("STORE ERROR"));
  });

  it("returns false and logs when the API returns a non-2xx status", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue("temporarily unavailable"),
    });
    const log = makeLog();

    await expect(api.storeEpisodic("msg", "user", log)).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("STORE ERROR: status=503"));
  });
});

// ---------------------------------------------------------------------------
// storeEpisodic — cache-on-fail / flush-on-success
// ---------------------------------------------------------------------------

describe("MidbrainApi.storeEpisodic cache resilience", () => {
  let fetchSpy;
  let api;
  let tmpDir;
  let originalSimulateOffline;
  const log = makeLog();

  function cacheScopeForKey(key) {
    return createHash("sha256")
      .update(`${MidbrainApi.API_BASE_URL}\0${key}`)
      .digest("hex");
  }

  beforeEach(() => {
    originalSimulateOffline = process.env.MIDBRAIN_SIMULATE_OFFLINE;
    delete process.env.MIDBRAIN_SIMULATE_OFFLINE;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-api-cache-test-"));
    _setCachePath(tmpDir);
    fetchSpy = vi.spyOn(globalThis, "fetch");
    api = new MidbrainApi("test-key", "test-source");
    for (const fn of Object.values(log)) fn.mockClear();
  });

  afterEach(() => {
    if (originalSimulateOffline === undefined) delete process.env.MIDBRAIN_SIMULATE_OFFLINE;
    else process.env.MIDBRAIN_SIMULATE_OFFLINE = originalSimulateOffline;
    fetchSpy.mockRestore();
    _setCachePath(null);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("caches entry on network failure", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));

    await api.storeEpisodic("hello", "user", log, { client: "opencode" });

    const cached = readAndClearCache(cacheScopeForKey("test-key"));
    expect(cached).toHaveLength(1);
    expect(cached[0].text).toBe("hello");
    expect(cached[0].role).toBe("user");
    expect(cached[0].memory_metadata).toEqual({ client: "opencode" });
  });

  it("caches entry on non-2xx response", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue("unavailable"),
    });

    await api.storeEpisodic("world", "assistant", log);

    const cached = readAndClearCache(cacheScopeForKey("test-key"));
    expect(cached).toHaveLength(1);
    expect(cached[0].text).toBe("world");
    expect(cached[0].role).toBe("assistant");
  });

  it("caches under the current scope without fetch when MIDBRAIN_SIMULATE_OFFLINE=1", async () => {
    process.env.MIDBRAIN_SIMULATE_OFFLINE = "1";
    fetchSpy.mockRejectedValue(new Error("fetch should not be called"));

    await expect(api.storeEpisodic("simulated outage", "user", log, { client: "codex" }))
      .resolves.toBe(false);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hasCachedEntries(cacheScopeForKey("test-key"))).toBe(true);
    expect(hasCachedEntries(cacheScopeForKey("other-key"))).toBe(false);

    const cached = readAndClearCache(cacheScopeForKey("test-key"));
    expect(cached).toHaveLength(1);
    expect(cached[0].text).toBe("simulated outage");
    expect(cached[0].memory_metadata).toEqual({ client: "codex" });
  });

  it("does not cache on success", async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });

    await api.storeEpisodic("hello", "user", log);

    expect(hasCachedEntries(cacheScopeForKey("test-key"))).toBe(false);
  });

  it("flushes cached entries on next successful POST", async () => {
    // First call fails — entry gets cached.
    fetchSpy.mockRejectedValueOnce(new Error("offline"));
    await api.storeEpisodic("cached msg", "user", log, { client: "claude" });
    expect(hasCachedEntries(cacheScopeForKey("test-key"))).toBe(true);

    // Second call succeeds — should flush the cache.
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await api.storeEpisodic("new msg", "assistant", log);

    // Cache should be empty now.
    expect(hasCachedEntries(cacheScopeForKey("test-key"))).toBe(false);
    // fetch was called: once for the failed attempt, once for the new msg, once for the cached flush.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const [, options] of fetchSpy.mock.calls) {
      expect(options.headers["User-Agent"]).toBe("midbrain-memory-mcp");
    }
  });

  it("does not flush one API key's cached entries under another API key", async () => {
    const apiA = new MidbrainApi("key-a", "source-a");
    const apiB = new MidbrainApi("key-b", "source-b");

    fetchSpy.mockRejectedValueOnce(new Error("offline"));
    await apiA.storeEpisodic("cached under key A", "user", log, { client: "codex" });

    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await apiB.storeEpisodic("trigger from key B", "user", log, { client: "codex" });
    await apiA.storeEpisodic("trigger from key A", "user", log, { client: "codex" });

    const posts = fetchSpy.mock.calls.map(([, opts]) => ({
      authorization: opts.headers.Authorization,
      body: JSON.parse(opts.body),
    }));

    expect(posts).not.toContainEqual(expect.objectContaining({
      authorization: "Bearer key-b",
      body: expect.objectContaining({ text: "cached under key A" }),
    }));
    expect(posts).toContainEqual(expect.objectContaining({
      authorization: "Bearer key-a",
      body: expect.objectContaining({ text: "cached under key A" }),
    }));
  });

  it("re-caches entries that still fail during flush", async () => {
    // Seed two entries into the cache.
    appendToCache(
      { text: "entry1", role: "user", memory_metadata: { client: "codex" } },
      cacheScopeForKey("test-key"),
    );
    appendToCache({ text: "entry2", role: "assistant" }, cacheScopeForKey("test-key"));

    // The current call succeeds, first flush entry fails, second flush entry succeeds.
    fetchSpy
      .mockResolvedValueOnce({ ok: true, status: 200 })   // current storeEpisodic call
      .mockResolvedValueOnce({                              // flush entry1 — fail
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("server error"),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });   // flush entry2 — success

    await api.storeEpisodic("trigger", "user", log);

    // entry1 should still be cached, entry2 should be gone.
    const remaining = readAndClearCache(cacheScopeForKey("test-key"));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe("entry1");
    expect(remaining[0].memory_metadata).toEqual({ client: "codex" });
  });

  it("preserves concurrent appends when failed flush survivors are re-cached", async () => {
    appendToCache({ text: "survivor", role: "user" }, cacheScopeForKey("test-key"));
    appendToCache({ text: "flush succeeds", role: "assistant" }, cacheScopeForKey("test-key"));

    fetchSpy
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: vi.fn().mockImplementation(async () => {
          appendToCache({ text: "concurrent append", role: "user" }, cacheScopeForKey("test-key"));
          return "server error";
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await api.storeEpisodic("trigger", "user", log);

    const remaining = readAndClearCache(cacheScopeForKey("test-key"));
    expect(remaining.map((entry) => entry.text).sort()).toEqual(["concurrent append", "survivor"]);
  });

  it("clears cache completely when all flush entries succeed", async () => {
    appendToCache({ text: "a", role: "user" }, cacheScopeForKey("test-key"));
    appendToCache({ text: "b", role: "assistant" }, cacheScopeForKey("test-key"));

    fetchSpy.mockResolvedValue({ ok: true, status: 200 });

    await api.storeEpisodic("trigger", "user", log);

    expect(hasCachedEntries(cacheScopeForKey("test-key"))).toBe(false);
    expect(readAndClearCache(cacheScopeForKey("test-key"))).toEqual([]);
  });

  it("logs cache activity", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("offline"));
    await api.storeEpisodic("msg", "user", log);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("cached entry"));
  });

  it("accumulates multiple failures in the cache", async () => {
    fetchSpy.mockRejectedValue(new Error("still offline"));

    await api.storeEpisodic("first", "user", log);
    await api.storeEpisodic("second", "assistant", log);
    await api.storeEpisodic("third", "user", log);

    const cached = readAndClearCache(cacheScopeForKey("test-key"));
    expect(cached).toHaveLength(3);
    expect(cached.map((e) => e.text)).toEqual(["first", "second", "third"]);
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
