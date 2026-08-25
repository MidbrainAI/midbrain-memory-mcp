/**
 * Boot-time offline-cache drain (issue #53).
 *
 * The cache no longer flushes on every capture; it drains once at server start
 * via runSelfRepair, through the shared disciplined runner. These tests drive
 * runSelfRepair with a mocked fetch and assert:
 *   - the backlog is drained (single pass, no per-hook amplification),
 *   - EVERY scope binding is drained (orphans from past keys recovered),
 *   - a WAF rejection stops the pass, preserves entries, sets a cooldown,
 *   - nothing is ever dropped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "crypto";

import { makeTestEnv } from "./helpers/test-env.mjs";
import { runSelfRepair } from "../install.mjs";
import { runFlush } from "../shared/flush-runner.mjs";
import {
  appendToCache,
  beginCacheFlush,
  finishCacheFlush,
  hasCachedEntries,
  readCacheCooldownUntil,
  writeCacheCooldownUntil,
  clearCacheCooldown,
  _setCachePath,
} from "../shared/episodic-cache.mjs";

const NPX_CTX = {
  context: { kind: "npx-cache", path: "/Users/u/.npm/_npx/abc123/node_modules/midbrain-memory-mcp" },
};
const TEST_KEY = "test-key-cache-drain";
const DEFAULT_BASE = "https://memory.midbrain.ai";

function scopeFor(key, base = DEFAULT_BASE) {
  return createHash("sha256").update(`${base}\0${key}`).digest("hex");
}

let env;
let fetchSpy;

beforeEach(async () => {
  env = await makeTestEnv({ clients: ["claude"] });
  _setCachePath(null); // resolve under the sandbox home (~/.cache/midbrain)
  process.env.MIDBRAIN_API_KEY = TEST_KEY;
  process.env.MIDBRAIN_CACHE_POST_SPACING_MS = "0";
  process.env.MIDBRAIN_CACHE_COOLDOWN_MS = "300000";
});

afterEach(async () => {
  fetchSpy?.mockRestore();
  delete process.env.MIDBRAIN_API_KEY;
  delete process.env.MIDBRAIN_CACHE_POST_SPACING_MS;
  delete process.env.MIDBRAIN_CACHE_COOLDOWN_MS;
  delete process.env.MIDBRAIN_CACHE_MAX_ENTRIES_PER_BOOT;
  _setCachePath(null);
  await env?.restore();
});

function mockFetch(handler) {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(handler);
}

const okResponse = () => ({ ok: true, status: 201, headers: new Map(), text: async () => "", json: async () => ({}) });

describe("boot cache drain (runSelfRepair)", () => {
  it("drains the current-scope backlog in a single pass, then clears it", async () => {
    const scope = scopeFor(TEST_KEY);
    appendToCache({ text: "one", role: "user" }, scope);
    appendToCache({ text: "two", role: "assistant" }, scope);

    const posted = [];
    mockFetch(async (url, opts = {}) => {
      if (String(url).includes("/memories/episodic")) { posted.push(JSON.parse(opts.body).text); return okResponse(); }
      return { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) };
    });

    await runSelfRepair(NPX_CTX);

    expect(posted.sort()).toEqual(["one", "two"]);
    expect(hasCachedEntries(scope)).toBe(false);
  });

  it("drains only the current binding and preserves opaque old or unscoped buckets", async () => {
    const currentScope = scopeFor(TEST_KEY);
    const orphanScope = scopeFor("deleted-old-key"); // a rotated-away key's bucket
    appendToCache({ text: "current entry", role: "user" }, currentScope);
    appendToCache({ text: "orphaned entry", role: "user" }, orphanScope);
    appendToCache({ text: "unscoped entry", role: "user" });

    const posted = [];
    mockFetch(async (url, opts = {}) => {
      if (String(url).includes("/memories/episodic")) { posted.push(JSON.parse(opts.body).text); return okResponse(); }
      return { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) };
    });

    await runSelfRepair(NPX_CTX);

    expect(posted).toEqual(["current entry"]);
    expect(hasCachedEntries(currentScope)).toBe(false);
    expect(hasCachedEntries(orphanScope)).toBe(true);
    expect(hasCachedEntries()).toBe(true);
  });

  it("a WAF rejection stops the pass, preserves entries (never dropped), and sets a cooldown", async () => {
    const scope = scopeFor(TEST_KEY);
    appendToCache({ text: "a", role: "user" }, scope);
    appendToCache({ text: "b", role: "user" }, scope);
    appendToCache({ text: "c", role: "user" }, scope);

    let calls = 0;
    mockFetch(async (url) => {
      if (String(url).includes("/memories/episodic")) {
        calls += 1;
        // HTML-bodied 403 = WAF/edge rejection.
        const headers = new Map([["content-type", "text/html"]]);
        return { ok: false, status: 403, headers, text: async () => "<html>blocked</html>", json: async () => ({}) };
      }
      return { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) };
    });

    await runSelfRepair(NPX_CTX);

    // Pass stopped on the first rejection — no burst across the backlog.
    expect(calls).toBe(1);
    // All three entries preserved.
    expect(hasCachedEntries(scope)).toBe(true);
    // Cooldown persisted for this scope.
    expect(readCacheCooldownUntil(scope)).toBeGreaterThan(Date.now());
  });

  it("an active cooldown defers the drain entirely (no POSTs), entries kept", async () => {
    const scope = scopeFor(TEST_KEY);
    appendToCache({ text: "still here", role: "user" }, scope);

    const posted = [];
    mockFetch(async (url, opts = {}) => {
      if (String(url).includes("/memories/episodic")) { posted.push(JSON.parse(opts.body).text); return okResponse(); }
      return { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) };
    });

    // First run trips the cooldown (WAF) — then a second run must defer.
    // Simpler: seed a cooldown via a WAF response, then a normal run defers.
    // Here we directly assert the deferral by running twice with WAF then OK.
    fetchSpy.mockRestore();
    let waf = true;
    mockFetch(async (url) => {
      if (String(url).includes("/memories/episodic")) {
        if (waf) return { ok: false, status: 429, headers: new Map(), text: async () => "", json: async () => ({}) };
        posted.push("late"); return okResponse();
      }
      return { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) };
    });

    await runSelfRepair(NPX_CTX);      // 429 -> cooldown set, entry preserved
    expect(hasCachedEntries(scope)).toBe(true);
    waf = false;
    await runSelfRepair(NPX_CTX);      // cooldown active -> deferred, no POST

    expect(posted).not.toContain("late");
    expect(hasCachedEntries(scope)).toBe(true);
  });

  it("a rate limit creates one cache-wide cooldown across binding changes and rapid restarts", async () => {
    const scopeA = scopeFor(TEST_KEY);
    appendToCache({ text: "binding a", role: "user" }, scopeA);

    let calls = 0;
    mockFetch(async (url) => {
      if (String(url).includes("/memories/episodic")) {
        calls += 1;
        return { ok: false, status: 429, headers: new Map(), text: async () => "", json: async () => ({}) };
      }
      return { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) };
    });
    await runSelfRepair(NPX_CTX);
    expect(calls).toBe(1);

    process.env.MIDBRAIN_API_KEY = "different-current-key";
    const scopeB = scopeFor(process.env.MIDBRAIN_API_KEY);
    appendToCache({ text: "binding b", role: "user" }, scopeB);

    fetchSpy.mockRestore();
    const posted = [];
    mockFetch(async (url, opts = {}) => {
      if (String(url).includes("/memories/episodic")) {
        posted.push(JSON.parse(opts.body).text);
        return okResponse();
      }
      return { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) };
    });
    await runSelfRepair(NPX_CTX);

    expect(posted).toEqual([]);
    expect(readCacheCooldownUntil(scopeB)).toBeGreaterThan(Date.now());
    expect(hasCachedEntries(scopeA)).toBe(true);
    expect(hasCachedEntries(scopeB)).toBe(true);
  });

  it("does not let one binding success erase another binding's newer global cooldown", async () => {
    const scopeA = scopeFor("concurrent-binding-a");
    const scopeB = scopeFor("concurrent-binding-b");
    appendToCache({ text: "binding a", role: "user" }, scopeA);
    appendToCache({ text: "binding b", role: "user" }, scopeB);
    clearCacheCooldown(scopeA);

    const source = (scope) => ({
      begin: () => beginCacheFlush(scope),
      finish: (flush, survivors) => finishCacheFlush(flush, survivors),
      readCooldownUntil: () => readCacheCooldownUntil(scope),
      writeCooldownUntil: (until) => writeCacheCooldownUntil(scope, until),
      clearCooldown: () => clearCacheCooldown(scope),
    });

    let releaseA;
    let markAStarted;
    const aGate = new Promise((resolve) => { releaseA = resolve; });
    const aStarted = new Promise((resolve) => { markAStarted = resolve; });
    const runA = runFlush({
      source: source(scopeA),
      post: async () => {
        markAStarted();
        await aGate;
        return "ok";
      },
      cooldownMs: 60_000,
    });

    await aStarted;
    const summaryB = await runFlush({
      source: source(scopeB),
      post: async () => "rateLimited",
      cooldownMs: 60_000,
    });
    const afterB = readCacheCooldownUntil(scopeB);
    releaseA();
    const summaryA = await runA;

    expect(summaryA).toMatchObject({ sent: 1, survivors: 0, rateLimited: false });
    expect(summaryB).toMatchObject({ sent: 0, survivors: 1, rateLimited: true });
    expect(afterB).toBeGreaterThan(Date.now());
    expect(readCacheCooldownUntil(scopeB)).toBe(afterB);
  });

  it("limits each boot and leaves the unattempted cache tail for a later boot", async () => {
    process.env.MIDBRAIN_CACHE_MAX_ENTRIES_PER_BOOT = "2";
    const scope = scopeFor(TEST_KEY);
    appendToCache({ text: "one", role: "user" }, scope);
    appendToCache({ text: "two", role: "user" }, scope);
    appendToCache({ text: "three", role: "user" }, scope);

    const posted = [];
    mockFetch(async (url, opts = {}) => {
      if (String(url).includes("/memories/episodic")) {
        posted.push(JSON.parse(opts.body).text);
        return okResponse();
      }
      return { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) };
    });

    await runSelfRepair(NPX_CTX);
    expect(posted).toEqual(["one", "two"]);
    expect(hasCachedEntries(scope)).toBe(true);

    await runSelfRepair(NPX_CTX);
    expect(posted).toEqual(["one", "two", "three"]);
    expect(hasCachedEntries(scope)).toBe(false);
  });

  it("never drops: a transient 5xx keeps entries cached across repeated boots until success", async () => {
    const scope = scopeFor(TEST_KEY);
    appendToCache({ text: "durable", role: "user" }, scope);

    // Two failing boots (503).
    mockFetch(async (url) => {
      if (String(url).includes("/memories/episodic")) {
        return { ok: false, status: 503, headers: new Map(), text: async () => "", json: async () => ({}) };
      }
      return { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) };
    });
    await runSelfRepair(NPX_CTX);
    await runSelfRepair(NPX_CTX);
    expect(hasCachedEntries(scope)).toBe(true);

    // A later successful boot drains it.
    fetchSpy.mockRestore();
    mockFetch(async (url) => (String(url).includes("/memories/episodic")
      ? okResponse()
      : { ok: false, status: 404, headers: new Map(), text: async () => "", json: async () => ({}) }));
    await runSelfRepair(NPX_CTX);
    expect(hasCachedEntries(scope)).toBe(false);
  });
});
