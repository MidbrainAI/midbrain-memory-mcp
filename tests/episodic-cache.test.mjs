/**
 * Unit tests for shared/episodic-cache.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  appendToCache,
  beginCacheFlush,
  finishCacheFlush,
  readAndClearCache,
  rewriteCache,
  hasCachedEntries,
  _setCachePath,
} from "../shared/episodic-cache.mjs";

// Each test gets its own temp directory so they can't interfere.
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-cache-test-"));
  _setCachePath(tmpDir);
});

afterEach(() => {
  _setCachePath(null);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// appendToCache
// ---------------------------------------------------------------------------

describe("appendToCache", () => {
  it("creates the cache file on first append", () => {
    appendToCache({ text: "hello", role: "user" });
    const cacheFile = path.join(tmpDir, "midbrain-episodic-cache.ndjson");
    expect(fs.existsSync(cacheFile)).toBe(true);
  });

  it("appends one JSON line per call", () => {
    appendToCache({ text: "first", role: "user" });
    appendToCache({ text: "second", role: "assistant" });

    const cacheFile = path.join(tmpDir, "midbrain-episodic-cache.ndjson");
    const lines = fs.readFileSync(cacheFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    expect(first.text).toBe("first");
    expect(first.role).toBe("user");
    expect(typeof first.ts).toBe("number");

    const second = JSON.parse(lines[1]);
    expect(second.text).toBe("second");
    expect(second.role).toBe("assistant");
  });

  it("preserves memory_metadata in cached entries", () => {
    appendToCache({ text: "hi", role: "user", memory_metadata: { client: "opencode" } });

    const cacheFile = path.join(tmpDir, "midbrain-episodic-cache.ndjson");
    const entry = JSON.parse(fs.readFileSync(cacheFile, "utf8").trim());
    expect(entry.memory_metadata).toEqual({ client: "opencode" });
  });

  it("adds a ts (timestamp) field to each entry", () => {
    const before = Date.now();
    appendToCache({ text: "hi", role: "user" });
    const after = Date.now();

    const cacheFile = path.join(tmpDir, "midbrain-episodic-cache.ndjson");
    const entry = JSON.parse(fs.readFileSync(cacheFile, "utf8").trim());
    expect(entry.ts).toBeGreaterThanOrEqual(before);
    expect(entry.ts).toBeLessThanOrEqual(after);
  });

  it("never throws even if the directory is unwritable", () => {
    _setCachePath("/nonexistent/deep/path/that/should/not/exist");
    // Should not throw — best effort.
    expect(() => appendToCache({ text: "hi", role: "user" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// readAndClearCache
// ---------------------------------------------------------------------------

describe("readAndClearCache", () => {
  it("keeps cache entries isolated by scope", () => {
    appendToCache({ text: "from scope a", role: "user" }, "scope-a");
    appendToCache({ text: "from scope b", role: "assistant" }, "scope-b");

    const scopeB = readAndClearCache("scope-b");
    expect(scopeB.map((entry) => entry.text)).toEqual(["from scope b"]);
    expect(hasCachedEntries("scope-a")).toBe(true);

    const scopeA = readAndClearCache("scope-a");
    expect(scopeA.map((entry) => entry.text)).toEqual(["from scope a"]);
  });

  it("returns all cached entries and removes the file", () => {
    appendToCache({ text: "a", role: "user" });
    appendToCache({ text: "b", role: "assistant", memory_metadata: { client: "codex" } });

    const entries = readAndClearCache();
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe("a");
    expect(entries[0].role).toBe("user");
    expect(entries[1].text).toBe("b");
    expect(entries[1].memory_metadata).toEqual({ client: "codex" });

    const cacheFile = path.join(tmpDir, "midbrain-episodic-cache.ndjson");
    expect(fs.existsSync(cacheFile)).toBe(false);
  });

  it("returns empty array when no cache file exists", () => {
    expect(readAndClearCache()).toEqual([]);
  });

  it("skips malformed lines", () => {
    const cacheFile = path.join(tmpDir, "midbrain-episodic-cache.ndjson");
    fs.writeFileSync(cacheFile, [
      JSON.stringify({ text: "good", role: "user", ts: 1 }),
      "not json at all",
      JSON.stringify({ text: "also good", role: "assistant", ts: 2 }),
      "",
    ].join("\n"), "utf8");

    const entries = readAndClearCache();
    expect(entries).toHaveLength(2);
    expect(entries[0].text).toBe("good");
    expect(entries[1].text).toBe("also good");
  });

  it("skips entries missing required fields", () => {
    const cacheFile = path.join(tmpDir, "midbrain-episodic-cache.ndjson");
    fs.writeFileSync(cacheFile, [
      JSON.stringify({ text: "valid", role: "user", ts: 1 }),
      JSON.stringify({ role: "user", ts: 2 }),          // missing text
      JSON.stringify({ text: "no role", ts: 3 }),        // missing role
      JSON.stringify({ text: 123, role: "user", ts: 4 }),// text is number
    ].join("\n"), "utf8");

    const entries = readAndClearCache();
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("valid");
  });

  it("removes corrupted file and returns empty array", () => {
    const cacheFile = path.join(tmpDir, "midbrain-episodic-cache.ndjson");
    // Write binary garbage (non-UTF8-decodable data won't happen with writeFileSync,
    // but a truncated file with no valid lines simulates corruption).
    fs.writeFileSync(cacheFile, Buffer.from([0x80, 0x81, 0x82, 0x00, 0xff]), "binary");

    const entries = readAndClearCache();
    expect(entries).toEqual([]);
    // File should be cleaned up.
    expect(fs.existsSync(cacheFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// safe flush handoff
// ---------------------------------------------------------------------------

describe("safe flush handoff", () => {
  it("preserves failed survivors and concurrent appends after handoff", () => {
    const scope = "safe-handoff-scope";
    appendToCache({ text: "survivor", role: "user", memory_metadata: { client: "codex" } }, scope);
    appendToCache({ text: "flushed", role: "assistant" }, scope);

    const batch = beginCacheFlush(scope);
    expect(batch.map((entry) => entry.text)).toEqual(["survivor", "flushed"]);

    appendToCache({ text: "concurrent append", role: "user" }, scope);
    finishCacheFlush([batch[0]], scope);

    const remaining = readAndClearCache(scope);
    expect(remaining.map((entry) => entry.text).sort()).toEqual(["concurrent append", "survivor"]);
    expect(remaining.find((entry) => entry.text === "survivor").memory_metadata).toEqual({ client: "codex" });
  });

  it("recovers processing files left by an interrupted flush", () => {
    const scope = "interrupted-flush-scope";
    appendToCache({ text: "pending before crash", role: "user" }, scope);

    const firstBatch = beginCacheFlush(scope);
    expect(firstBatch.map((entry) => entry.text)).toEqual(["pending before crash"]);
    expect(hasCachedEntries(scope)).toBe(true);

    const recoveredBatch = beginCacheFlush(scope);
    expect(recoveredBatch.map((entry) => entry.text)).toEqual(["pending before crash"]);

    finishCacheFlush([], scope);
    expect(hasCachedEntries(scope)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rewriteCache
// ---------------------------------------------------------------------------

describe("rewriteCache", () => {
  it("writes survivors atomically", () => {
    const survivors = [
      { text: "s1", role: "user", ts: 100 },
      { text: "s2", role: "assistant", memory_metadata: { client: "claude" }, ts: 200 },
    ];
    rewriteCache(survivors);

    const cacheFile = path.join(tmpDir, "midbrain-episodic-cache.ndjson");
    const lines = fs.readFileSync(cacheFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(survivors[0]);
    expect(JSON.parse(lines[1])).toEqual(survivors[1]);
  });

  it("removes cache file when entries array is empty", () => {
    appendToCache({ text: "hi", role: "user" });
    const cacheFile = path.join(tmpDir, "midbrain-episodic-cache.ndjson");
    expect(fs.existsSync(cacheFile)).toBe(true);

    rewriteCache([]);
    expect(fs.existsSync(cacheFile)).toBe(false);
  });

  it("does not leave a .tmp file behind", () => {
    rewriteCache([{ text: "a", role: "user", ts: 1 }]);
    const tmpFile = path.join(tmpDir, "midbrain-episodic-cache.ndjson.tmp");
    expect(fs.existsSync(tmpFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasCachedEntries
// ---------------------------------------------------------------------------

describe("hasCachedEntries", () => {
  it("returns false when no cache file exists", () => {
    expect(hasCachedEntries()).toBe(false);
  });

  it("returns true when cache has content", () => {
    appendToCache({ text: "hi", role: "user" });
    expect(hasCachedEntries()).toBe(true);
  });

  it("returns false after readAndClearCache clears the file", () => {
    appendToCache({ text: "hi", role: "user" });
    readAndClearCache();
    expect(hasCachedEntries()).toBe(false);
  });

  it("returns false after rewriteCache with empty array", () => {
    appendToCache({ text: "hi", role: "user" });
    rewriteCache([]);
    expect(hasCachedEntries()).toBe(false);
  });
});
