/**
 * Unit tests for shared/midbrain-api.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { MidbrainApi } from "../shared/midbrain-api.mjs";
import { PKG_VERSION } from "../shared/clients/utils.mjs";
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

describe("MidbrainApi instance API base", () => {
  it("builds every endpoint and diagnostic getter from the injected base", () => {
    const api = new MidbrainApi("test-key", "key-file", {
      apiBase: "http://127.0.0.1:43123/custom",
      apiBaseScope: "client",
      apiBaseSource: "/tmp/config.json",
      keyScope: "global",
    });

    expect(api.effectiveApiBase).toBe("http://127.0.0.1:43123/custom");
    expect(api.apiBaseScope).toBe("client");
    expect(api.apiBaseSource).toBe("/tmp/config.json");
    expect(api.keyScope).toBe("global");
    expect(api.cacheScope).toMatch(/^[a-f0-9]{64}$/);
    expect(api.SEARCH_SEMANTIC).toBe(
      "http://127.0.0.1:43123/custom/api/v1/memories/search/semantic",
    );
    expect(api.SEARCH_LEXICAL).toBe(
      "http://127.0.0.1:43123/custom/api/v1/memories/search/lexical",
    );
    expect(api.SEARCH_PROCEDURAL).toBe(
      "http://127.0.0.1:43123/custom/api/v1/memories/search/procedural",
    );
    expect(api.EPISODIC).toBe(
      "http://127.0.0.1:43123/custom/api/v1/memories/episodic",
    );
    expect(api.SEMANTIC_FILES).toBe(
      "http://127.0.0.1:43123/custom/api/v1/memories/semantic/files",
    );
    expect(api.PROCEDURAL).toBe(
      "http://127.0.0.1:43123/custom/api/v1/memories/procedural",
    );
  });

  it("keeps v0.4.7 no-override URL bytes unchanged", () => {
    const api = new MidbrainApi("test-key", "test-source");
    expect(api.effectiveApiBase).toBe("https://memory.midbrain.ai");
    expect(api.SEARCH_SEMANTIC).toBe(
      "https://memory.midbrain.ai/api/v1/memories/search/semantic",
    );
    expect(api.SEARCH_LEXICAL).toBe(
      "https://memory.midbrain.ai/api/v1/memories/search/lexical",
    );
    expect(api.SEARCH_PROCEDURAL).toBe(
      "https://memory.midbrain.ai/api/v1/memories/search/procedural",
    );
    expect(api.EPISODIC).toBe(
      "https://memory.midbrain.ai/api/v1/memories/episodic",
    );
    expect(api.SEMANTIC_FILES).toBe(
      "https://memory.midbrain.ai/api/v1/memories/semantic/files",
    );
    expect(api.PROCEDURAL).toBe(
      "https://memory.midbrain.ai/api/v1/memories/procedural",
    );
  });

  it("keeps compatibility base metadata bound to the import-time environment", () => {
    process.env.MIDBRAIN_API_URL = "https://late-mutation.example";
    try {
      const api = new MidbrainApi("test-key", "test-source");
      expect(api.effectiveApiBase).toBe("https://memory.midbrain.ai");
      expect(api.apiBaseScope).toBe("default");
      expect(api.apiBaseSource).toBe("default");
    } finally {
      delete process.env.MIDBRAIN_API_URL;
    }
  });
});

describe("MidbrainApi.fetch diagnostics", () => {
  let fetchSpy;

  afterEach(() => fetchSpy?.mockRestore());

  it("enriches 401 with host, key scope, and the diagnostics pointer only", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue("credential ending A1b2 rejected"),
    });
    const api = new MidbrainApi("secret-A1b2", "/Users/alice/.midbrain-key", {
      apiBase: "https://staging.example.test",
      apiBaseScope: "client",
      apiBaseSource: "/Users/alice/.config/midbrain/config.json",
      keyScope: "client",
    });

    await expect(api.fetch(api.EPISODIC)).rejects.toThrow(
      "API 401 (auth failed): host=https://staging.example.test key_scope=client — run memory_diagnostics for details",
    );
    await expect(api.fetch(api.EPISODIC)).rejects.not.toThrow(/alice|A1b2|config\.json/);
  });

  it("leaves non-401 error behavior unchanged", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue("temporarily unavailable"),
    });
    const api = new MidbrainApi("test-key", "test-source");
    await expect(api.fetch(api.EPISODIC)).rejects.toThrow(
      "API 503: temporarily unavailable",
    );
  });

  it("does not fall back to POST when allowPostFallback is false", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 405,
      text: vi.fn().mockResolvedValue("method not allowed"),
    });
    const api = new MidbrainApi("test-key", "test-source");

    await expect(
      api.fetch(api.EPISODIC, {}, { allowPostFallback: false }),
    ).rejects.toThrow("API 405: method not allowed");

    // Exactly one call, and it must be a GET — never a POST to the write path.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ method: "GET" });
  });

  it("still falls back to POST on 405 by default", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: false, status: 405, text: vi.fn().mockResolvedValue("") })
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ items: [] }) });
    const api = new MidbrainApi("test-key", "test-source");

    await api.fetch(api.EPISODIC, { page: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][1]).toMatchObject({ method: "POST" });
  });

  it("sends X-Midbrain-User-Agent on the GET path", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ items: [] }),
    });
    const api = new MidbrainApi("test-key", "test-source");

    await api.fetch(api.EPISODIC, { page: 1 });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["X-Midbrain-User-Agent"]).toBe(`midbrain-memory-mcp/${PKG_VERSION}`);
  });

  it("sends X-Midbrain-User-Agent on the POST fallback path", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: false, status: 405, text: vi.fn().mockResolvedValue("") })
      .mockResolvedValueOnce({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ items: [] }) });
    const api = new MidbrainApi("test-key", "test-source");

    await api.fetch(api.EPISODIC, { page: 1 });

    const [, opts] = fetchSpy.mock.calls[1];
    expect(opts.headers["X-Midbrain-User-Agent"]).toBe(`midbrain-memory-mcp/${PKG_VERSION}`);
  });
});

describe("MidbrainApi diagnostic output audit", () => {
  let fetchSpy;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-output-audit-"));
    _setCachePath(tmpDir);
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    _setCachePath(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("audits the enriched 401 and both capture log-label lines together", async () => {
    const api = new MidbrainApi("secret-A1b2", "/Users/alice/.midbrain-key", {
      apiBase: "https://staging.example.test",
      apiBaseScope: "client",
      apiBaseSource: "/Users/alice/.config/midbrain/config.json",
      keyScope: "client",
    });

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue("credential ending A1b2 rejected"),
    });
    let authError;
    try {
      await api.fetch(api.EPISODIC);
    } catch (error) {
      authError = error;
    }

    const networkLog = makeLog();
    fetchSpy.mockRejectedValueOnce(new Error("network down with credential A1b2"));
    await api.storeEpisodic("network case", "user", networkLog);

    const statusLog = makeLog();
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue("credential ending A1b2 rejected"),
    });
    await api.storeEpisodic("status case", "user", statusLog);

    const surfaces = [
      authError?.message,
      networkLog.error.mock.calls[0]?.[0],
      statusLog.error.mock.calls[0]?.[0],
    ];
    expect(surfaces).toEqual([
      "API 401 (auth failed): host=https://staging.example.test key_scope=client — run memory_diagnostics for details",
      "STORE ERROR: host=https://staging.example.test key_scope=client network-error",
      "STORE ERROR: status=503 host=https://staging.example.test key_scope=client",
    ]);
    expect(surfaces.join("\n")).not.toMatch(/\/Users\/|alice|A1b2|secret-A1b2|key=/i);
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
    expect(opts.headers["X-Midbrain-User-Agent"]).toBe(`midbrain-memory-mcp/${PKG_VERSION}`);
    expect(JSON.parse(opts.body)).toEqual({ text: "hello world", role: "user" });
  });

  it("appends the client id as a second UA token when configured", async () => {
    api = new MidbrainApi("test-key", "test-source", { clientId: "opencode" });
    api.storeEpisodic("hello world", "user", makeLog());

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["X-Midbrain-User-Agent"]).toBe(`midbrain-memory-mcp/${PKG_VERSION} opencode`);
  });

  it("POSTs episodic data to the injected instance endpoint", async () => {
    api = new MidbrainApi("test-key", "test-source", {
      apiBase: "http://127.0.0.1:43123",
    });
    await api.storeEpisodic("custom host", "user", makeLog());

    expect(fetchSpy.mock.calls[0][0]).toBe(
      "http://127.0.0.1:43123/api/v1/memories/episodic",
    );
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
    fetchSpy.mockRejectedValueOnce(new Error("network down with credential A1b2"));
    const log = makeLog();

    await expect(api.storeEpisodic("msg", "user", log)).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      "STORE ERROR: host=https://memory.midbrain.ai key_scope=unknown network-error",
    );
    expect(log.error.mock.calls.flat().join("\n")).not.toContain("A1b2");
  });

  it("returns false and logs when the API returns a non-2xx status", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue("credential ending A1b2 rejected"),
    });
    const log = makeLog();

    await expect(api.storeEpisodic("msg", "user", log)).resolves.toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      "STORE ERROR: status=503 host=https://memory.midbrain.ai key_scope=unknown",
    );
    expect(log.error.mock.calls.flat().join("\n")).not.toContain("A1b2");
  });
});

// ---------------------------------------------------------------------------
// postEpisodicResult — disciplined single-entry POST for the spool flush (#52)
// ---------------------------------------------------------------------------

describe("MidbrainApi.postEpisodicResult", () => {
  let fetchSpy;
  let api;

  beforeEach(() => {
    api = new MidbrainApi("test-key", "test-source");
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function mockResponse({ ok, status, contentType }) {
    const headers = new Map();
    if (contentType) headers.set("content-type", contentType);
    return { ok, status, headers, text: async () => "", json: async () => ({}) };
  }

  it("returns 'ok' on 2xx", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({ ok: true, status: 201 }));
    await expect(api.postEpisodicResult("hi", "user", { client: "nanoclaw" })).resolves.toBe("ok");
    const [, opts] = fetchSpy.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ text: "hi", role: "user", memory_metadata: { client: "nanoclaw" } });
  });

  it("returns 'rateLimited' on 429", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({ ok: false, status: 429 }));
    await expect(api.postEpisodicResult("hi", "user")).resolves.toBe("rateLimited");
  });

  it("returns 'rateLimited' on an HTML-bodied 403 (WAF/edge rejection)", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ ok: false, status: 403, contentType: "text/html" }),
    );
    await expect(api.postEpisodicResult("hi", "user")).resolves.toBe("rateLimited");
  });

  it("returns 'failed' on a JSON 403 (genuine auth/permission denial)", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mockResponse({ ok: false, status: 403, contentType: "application/json" }),
    );
    await expect(api.postEpisodicResult("hi", "user")).resolves.toBe("failed");
  });

  it("returns 'failed' on 5xx and on a network error, never throwing", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({ ok: false, status: 503 }));
    await expect(api.postEpisodicResult("hi", "user")).resolves.toBe("failed");
    fetchSpy.mockRestore();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
    await expect(api.postEpisodicResult("hi", "user")).resolves.toBe("failed");
  });

  it("does not touch the offline cache (no flush side effects)", async () => {
    // A pure POST helper: only one fetch call, no cache-flush GET/POST storm.
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse({ ok: true, status: 201 }));
    await api.postEpisodicResult("hi", "user");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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

  function cacheScopeForHost(host, key) {
    return createHash("sha256")
      .update(`${host}\0${key}`)
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

    await api.storeEpisodic("hello", "user", log, {
      client: "opencode",
      cwd: "~/project",
      session_id: "session-cache",
    });

    const cached = readAndClearCache(cacheScopeForKey("test-key"));
    expect(cached).toHaveLength(1);
    expect(cached[0].text).toBe("hello");
    expect(cached[0].role).toBe("user");
    expect(cached[0].memory_metadata).toEqual({
      client: "opencode",
      cwd: "~/project",
      session_id: "session-cache",
    });
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

  it("does NOT flush the backlog on a successful store (issue #53: no per-hook amplification)", async () => {
    // First call fails — entry gets cached.
    fetchSpy.mockRejectedValueOnce(new Error("offline"));
    await api.storeEpisodic("cached msg", "user", log, { client: "claude" });
    expect(hasCachedEntries(cacheScopeForKey("test-key"))).toBe(true);

    // Second call succeeds — it must POST ONLY itself, never replay the backlog.
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await api.storeEpisodic("new msg", "assistant", log);

    // fetch was called exactly twice: the failed attempt + the new msg. NO
    // third call for a backlog flush. The cached entry remains for boot drain.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchSpy.mock.calls) {
      expect(options.headers["X-Midbrain-User-Agent"]).toBe(`midbrain-memory-mcp/${PKG_VERSION}`);
    }
    expect(hasCachedEntries(cacheScopeForKey("test-key"))).toBe(true);
    const stillCached = readAndClearCache(cacheScopeForKey("test-key"));
    expect(stillCached.map((e) => e.text)).toEqual(["cached msg"]);
  });

  it("a successful store under one key never POSTs another key's cached entry", async () => {
    const apiA = new MidbrainApi("key-a", "source-a");
    const apiB = new MidbrainApi("key-b", "source-b");

    fetchSpy.mockRejectedValueOnce(new Error("offline"));
    await apiA.storeEpisodic("cached under key A", "user", log, { client: "codex" });

    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await apiB.storeEpisodic("trigger from key B", "user", log, { client: "codex" });
    await apiA.storeEpisodic("trigger from key A", "user", log, { client: "codex" });

    // "cached under key A" was POSTed exactly ONCE — the original failed
    // attempt. With no per-store flush, no later store re-POSTs it; it stays
    // cached under key-a's scope for the boot drain.
    const postsOfA = fetchSpy.mock.calls
      .map(([, opts]) => JSON.parse(opts.body).text)
      .filter((t) => t === "cached under key A");
    expect(postsOfA).toHaveLength(1);
    expect(hasCachedEntries(cacheScopeForKey("key-a"))).toBe(true);
  });

  it("caches per host-binding scope without cross-binding flush on store", async () => {
    const hostA = "http://127.0.0.1:43123";
    const hostB = "http://127.0.0.1:43124";
    const apiA = new MidbrainApi("shared-key", "source", { apiBase: hostA });
    const apiB = new MidbrainApi("shared-key", "source", { apiBase: hostB });
    const scopeA = cacheScopeForHost(hostA, "shared-key");
    const scopeB = cacheScopeForHost(hostB, "shared-key");

    fetchSpy.mockRejectedValueOnce(new Error("host A offline"));
    await apiA.storeEpisodic("pending A", "user", log);
    expect(hasCachedEntries(scopeA)).toBe(true);

    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await apiB.storeEpisodic("write B", "user", log);
    // host B's successful store never touches host A's cached entry.
    expect(hasCachedEntries(scopeA)).toBe(true);
    expect(hasCachedEntries(scopeB)).toBe(false);
    const hostBBodies = fetchSpy.mock.calls
      .filter(([url]) => url === `${hostB}/api/v1/memories/episodic`)
      .map(([, opts]) => JSON.parse(opts.body).text);
    expect(hostBBodies).not.toContain("pending A");

    // A later successful store under host A also does not flush (boot drains it).
    await apiA.storeEpisodic("return A", "user", log);
    expect(hasCachedEntries(scopeA)).toBe(true);
    // "pending A" was POSTed exactly once — the original failed attempt — and
    // never re-flushed by a subsequent store.
    const pendingAPosts = fetchSpy.mock.calls.filter(([, opts]) =>
      JSON.parse(opts.body).text === "pending A");
    expect(pendingAPosts).toHaveLength(1);
  });

  it("leaves a pre-normalization trailing-slash bucket orphaned", async () => {
    const rawHost = "http://127.0.0.1:43123/";
    const normalizedHost = "http://127.0.0.1:43123";
    const oldScope = cacheScopeForHost(rawHost, "shared-key");
    const newScope = cacheScopeForHost(normalizedHost, "shared-key");
    appendToCache({ text: "old raw bucket", role: "user" }, oldScope);
    const api = new MidbrainApi("shared-key", "source", {
      apiBase: normalizedHost,
    });

    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await api.storeEpisodic("normalized write", "user", log);

    expect(hasCachedEntries(oldScope)).toBe(true);
    expect(hasCachedEntries(newScope)).toBe(false);
    expect(readAndClearCache(oldScope).map((entry) => entry.text))
      .toEqual(["old raw bucket"]);
  });

  it("a successful store leaves seeded backlog entries untouched (drained at boot, not on store)", async () => {
    // Seed two entries into the cache as a prior offline session would have.
    appendToCache(
      { text: "entry1", role: "user", memory_metadata: { client: "codex" } },
      cacheScopeForKey("test-key"),
    );
    appendToCache({ text: "entry2", role: "assistant" }, cacheScopeForKey("test-key"));

    // A fresh successful store must POST only itself and NOT replay the backlog.
    fetchSpy.mockResolvedValue({ ok: true, status: 200 });
    await api.storeEpisodic("trigger", "user", log);

    expect(fetchSpy).toHaveBeenCalledTimes(1); // only "trigger", no backlog replay
    const remaining = readAndClearCache(cacheScopeForKey("test-key"));
    expect(remaining.map((e) => e.text).sort()).toEqual(["entry1", "entry2"]);
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

  it("sends X-Midbrain-User-Agent header", async () => {
    fetchSpy.mockReturnValueOnce(okJson(MOCK_RESULTS));
    await api.searchProcedural({ query: "test" });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["X-Midbrain-User-Agent"]).toBe(`midbrain-memory-mcp/${PKG_VERSION}`);
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
    const mockClient = {
      id: "opencode",
      resolveKey: vi.fn().mockResolvedValue({
        key: "abc123",
        source: "test",
        scope: "global",
      }),
    };
    const api = await MidbrainApi.create(mockClient, "/some/dir");
    expect(api.keySource).toBe("test");
    expect(api.keyFingerprint).toBe("...c123");
    expect(api.keyScope).toBe("global");
    expect(api.credentialScopes).toEqual([]);
    expect(api.credentialShadowNote).toBeNull();
    expect(mockClient.resolveKey).toHaveBeenCalledWith(
      "/some/dir",
      { includeScope: true },
    );
  });

  it("uses the client adapter's id as the UA client token", async () => {
    const mockClient = {
      id: "opencode",
      resolveKey: vi.fn().mockResolvedValue({ key: "abc123", source: "test", scope: "global" }),
    };
    const api = await MidbrainApi.create(mockClient, "/some/dir");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ items: [] }),
    });
    await api.fetch(api.EPISODIC);
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["X-Midbrain-User-Agent"]).toBe(`midbrain-memory-mcp/${PKG_VERSION} opencode`);
    fetchSpy.mockRestore();
  });

  it("prefers an explicit clientLabel override over the adapter's id", async () => {
    const mockClient = {
      id: "claude",
      resolveKey: vi.fn().mockResolvedValue({ key: "abc123", source: "test", scope: "global" }),
    };
    const api = await MidbrainApi.create(mockClient, "/some/dir", { clientLabel: "nanoclaw" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ items: [] }),
    });
    await api.fetch(api.EPISODIC);
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["X-Midbrain-User-Agent"]).toBe(`midbrain-memory-mcp/${PKG_VERSION} nanoclaw`);
    fetchSpy.mockRestore();
  });

  it("exposes secret-free credential diagnostics from the client resolver", async () => {
    const diagnosticState = {
      entries: [
        { scope: "client", status: "present", source: "/tmp/key", winner: true },
        { scope: "global", status: "present", source: "/tmp/global", winner: false },
      ],
      shadowNote: "client credential shadows the global credential for this client",
    };
    const mockClient = {
      id: "codex",
      resolveKey: vi.fn().mockResolvedValue({
        key: "client-secret",
        source: "/tmp/key",
        scope: "client",
      }),
      inspectCredentialScopes: vi.fn().mockResolvedValue(diagnosticState),
    };

    const api = await MidbrainApi.create(mockClient, "/project");
    expect(mockClient.inspectCredentialScopes).toHaveBeenCalledWith(
      "/project",
      expect.objectContaining({ scope: "client", source: "/tmp/key" }),
    );
    expect(api.credentialScopes).toEqual(diagnosticState.entries);
    expect(api.credentialShadowNote).toBe(diagnosticState.shadowNote);
    expect(JSON.stringify(api.credentialScopes)).not.toContain("client-secret");
  });

  it("throws when no key found", async () => {
    const mockClient = { resolveKey: vi.fn().mockResolvedValue(null) };
    await expect(MidbrainApi.create(mockClient)).rejects.toThrow(/No API key/);
  });
});

// ---------------------------------------------------------------------------
// Account management (user-key authenticated)
// ---------------------------------------------------------------------------

describe("MidbrainApi account operations", () => {
  let fetchSpy;

  function jsonResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("createForUser resolves the user key and errors when absent", async () => {
    const withKey = { resolveUserKey: vi.fn().mockResolvedValue({ key: "sk-user", source: "ks" }) };
    const api = await MidbrainApi.createForUser(withKey);
    expect(api.keySource).toBe("ks");

    const noKey = { resolveUserKey: vi.fn().mockResolvedValue(null) };
    await expect(MidbrainApi.createForUser(noKey)).rejects.toThrow(/No user API key configured/);
  });

  it("createForUser uses the client adapter's id as the UA client token", async () => {
    const client = {
      id: "hermes",
      resolveUserKey: vi.fn().mockResolvedValue({ key: "sk-user", source: "ks" }),
    };
    const api = await MidbrainApi.createForUser(client);
    fetchSpy.mockResolvedValue(jsonResponse(200, []));
    await api.listAgents();
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["X-Midbrain-User-Agent"]).toBe(`midbrain-memory-mcp/${PKG_VERSION} hermes`);
  });

  it("listAgents sends the key as a Bearer token to the account endpoint", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, [{ agent_id: "a1", name: "One" }]));
    const api = new MidbrainApi("sk-user", "test");
    await expect(api.listAgents()).resolves.toEqual([{ agent_id: "a1", name: "One" }]);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/api\/v1\/account\/agents$/);
    expect(opts.headers.Authorization).toBe("Bearer sk-user");
  });

  it("listAgents sends X-Midbrain-User-Agent to the account endpoint", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, []));
    const api = new MidbrainApi("sk-user", "test", { clientId: "codex" });
    await api.listAgents();
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers["X-Midbrain-User-Agent"]).toBe(`midbrain-memory-mcp/${PKG_VERSION} codex`);
  });

  it("listAgents tolerates a non-array body", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { unexpected: true }));
    const api = new MidbrainApi("sk-user", "test");
    await expect(api.listAgents()).resolves.toEqual([]);
  });

  it("createAgent POSTs name + description and requires a name", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(201, { agent_id: "a1", name: "One" }));
    const api = new MidbrainApi("sk-user", "test");
    await api.createAgent({ name: "One", description: "desc" });
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ name: "One", description: "desc" });
    await expect(api.createAgent({})).rejects.toThrow(/requires a name/);
  });

  it("createKey returns the KeyResponse and validates inputs", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(201, {
      key: "sk-secret", token: "tok-1", key_alias: "k", agent_id: "a1", max_budget: null,
    }));
    const api = new MidbrainApi("sk-user", "test");
    const res = await api.createKey({ agent_id: "a1", key_alias: "k" });
    expect(res.key).toBe("sk-secret");
    expect(res.token).toBe("tok-1");
    await expect(api.createKey({ key_alias: "k" })).rejects.toThrow(/requires an agent_id/);
    await expect(api.createKey({ agent_id: "a1" })).rejects.toThrow(/requires a key_alias/);
  });

  it("createKey passes optional read_only and max_budget", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(201, { key: "sk", token: "t", key_alias: "k", agent_id: "a1", max_budget: 5 }));
    const api = new MidbrainApi("sk-user", "test");
    await api.createKey({ agent_id: "a1", key_alias: "k", read_only: true, max_budget: 5 });
    const [, opts] = fetchSpy.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({ agent_id: "a1", key_alias: "k", read_only: true, max_budget: 5 });
  });

  it("deleteAgent issues a DELETE to the instance base and tolerates 204", async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 204, text: async () => "", json: async () => null });
    const api = new MidbrainApi("sk-user", "ks", {
      apiBase: "https://self-host.invalid",
      apiBaseScope: "environment",
      apiBaseSource: "env:MIDBRAIN_API_URL",
      keyScope: "global",
    });
    await expect(api.deleteAgent("agent_9")).resolves.toBeNull();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://self-host.invalid/api/v1/account/agents/agent_9");
    expect(opts.method).toBe("DELETE");
    expect(opts.headers.Authorization).toBe("Bearer sk-user");
    // Never the default origin.
    for (const [calledUrl] of fetchSpy.mock.calls) {
      expect(String(calledUrl)).not.toContain("memory.midbrain.ai");
    }
  });

  it("deleteAgent url-encodes the id and requires one", async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 204, text: async () => "", json: async () => null });
    const api = new MidbrainApi("sk-user", "test");
    await api.deleteAgent("a/b?c");
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/agents\/a%2Fb%3Fc$/);
    await expect(api.deleteAgent()).rejects.toThrow(/requires an agent_id/);
  });

  it("throws with status + body on a non-2xx account response", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 404, text: async () => "Agent not found" });
    const api = new MidbrainApi("sk-user", "test");
    await expect(api.createKey({ agent_id: "x", key_alias: "k" }))
      .rejects.toThrow(/Account API 404: Agent not found/);
  });

  it("bounds and redacts secret-like tokens in account error bodies", async () => {
    const leaky = "denied for Bearer sk-user-abcdef and key mb_deadbeefcafe " + "x".repeat(400);
    fetchSpy.mockResolvedValue({ ok: false, status: 403, text: async () => leaky });
    const api = new MidbrainApi("sk-user", "test");
    let msg = "";
    try { await api.listAgents(); } catch (e) { msg = e.message; }
    expect(msg).toContain("Account API 403");
    expect(msg).not.toContain("sk-user-abcdef");
    expect(msg).not.toContain("mb_deadbeefcafe");
    expect(msg).toContain("[redacted]");
    expect(msg.length).toBeLessThan(260); // bounded
  });

  // Blocker #1 regression: an instance bound to a non-default (self-hosted)
  // base must NEVER contact the default origin with the account credential.
  it("sends account requests to the instance base, never the default origin", async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, []));
    const api = new MidbrainApi("sk-user", "ks", {
      apiBase: "https://self-host.invalid",
      apiBaseScope: "environment",
      apiBaseSource: "env:MIDBRAIN_API_URL",
      keyScope: "global",
    });
    await api.listAgents();
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://self-host.invalid/api/v1/account/agents");
    for (const [calledUrl] of fetchSpy.mock.calls) {
      expect(String(calledUrl)).not.toContain("memory.midbrain.ai");
    }
  });

  it("createForUser binds the account host from resolveApiHost (not default)", async () => {
    // With MIDBRAIN_API_URL set, the resolved host is the env origin; the
    // account request must target it.
    const prev = process.env.MIDBRAIN_API_URL;
    process.env.MIDBRAIN_API_URL = "https://self-host.invalid";
    try {
      fetchSpy.mockResolvedValue(jsonResponse(200, []));
      const client = {
        id: "opencode",
        resolveUserKey: vi.fn().mockResolvedValue({ key: "sk-user", source: "ks" }),
      };
      const api = await MidbrainApi.createForUser(client);
      await api.listAgents();
      const [url] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://self-host.invalid/api/v1/account/agents");
    } finally {
      if (prev === undefined) delete process.env.MIDBRAIN_API_URL;
      else process.env.MIDBRAIN_API_URL = prev;
    }
  });
});
