/**
 * Unit tests for shared/episodic-cache.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  hasAnyCachedEntries,
  countCachedEntries,
  inspectCachedEntries,
  listCacheBindings,
  readCacheCooldownUntil,
  writeCacheCooldownUntil,
  clearCacheCooldown,
  _setCachePath,
} from "../shared/episodic-cache.mjs";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

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
    const lines = fs.readFileSync(cacheFile, "utf8").trim().split("\n").filter(Boolean);
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

  it("creates cache directory as 0700 and cache file as 0600 where supported", () => {
    appendToCache({ text: "hi", role: "user" }, "permission-scope");

    if (process.platform === "win32") return;

    const files = fs.readdirSync(tmpDir);
    const cacheFile = path.join(tmpDir, files.find((name) => name.endsWith(".ndjson")));
    expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(cacheFile).mode & 0o777).toBe(0o600);
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

  it("separates a valid append from a retained torn tail without changing the tail", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    const torn = Buffer.from('{"text":"torn');
    fs.writeFileSync(cacheFile, torn);

    appendToCache({ text: "later-valid", role: "user" }, scope);

    const raw = fs.readFileSync(cacheFile);
    expect(raw.subarray(0, torn.length)).toEqual(torn);
    expect(raw[torn.length]).toBe(0x0a);
    const flush = beginCacheFlush(scope);
    expect(flush.entries.map((entry) => entry.text)).toEqual(["later-valid"]);
    finishCacheFlush(flush, []);
    expect(fs.readFileSync(cacheFile)).toEqual(Buffer.concat([Buffer.from("\n"), torn, Buffer.from("\n")]));
  });

  it("keeps a valid append separate when a torn writer lands before its write", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    const torn = Buffer.from('{"text":"concurrent-torn');
    const realWriteFile = fs.writeFileSync.bind(fs);
    let injected = false;
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, ...args) => {
      if (!injected && typeof file === "number") {
        const opened = fs.fstatSync(file);
        const live = fs.statSync(cacheFile);
        if (opened.dev === live.dev && opened.ino === live.ino) {
          injected = true;
          fs.appendFileSync(cacheFile, torn);
        }
      }
      return realWriteFile(file, data, ...args);
    });

    try {
      appendToCache({ text: "later-valid", role: "user" }, scope);
    } finally {
      writeSpy.mockRestore();
    }

    const raw = fs.readFileSync(cacheFile);
    expect(injected).toBe(true);
    expect(raw.subarray(0, torn.length)).toEqual(torn);
    expect(raw[torn.length]).toBe(0x0a);
    const flush = beginCacheFlush(scope);
    expect(flush.entries.map((entry) => entry.text)).toEqual(["later-valid"]);
    finishCacheFlush(flush, []);
    expect(fs.readFileSync(cacheFile)).toEqual(Buffer.concat([Buffer.from("\n"), torn, Buffer.from("\n")]));
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
    expect(fs.readFileSync(cacheFile, "utf8")).toBe("\nnot json at all\n");
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

  it("preserves corrupted raw evidence and returns an empty array", () => {
    const cacheFile = path.join(tmpDir, "midbrain-episodic-cache.ndjson");
    // Write binary garbage (non-UTF8-decodable data won't happen with writeFileSync,
    // but a truncated file with no valid lines simulates corruption).
    const raw = Buffer.from([0x80, 0x81, 0x82, 0x00, 0xff]);
    fs.writeFileSync(cacheFile, raw);

    const entries = readAndClearCache();
    expect(entries).toEqual([]);
    expect(fs.readFileSync(cacheFile)).toEqual(Buffer.concat([Buffer.from("\n"), raw]));
  });

  it("ignores blank separator lines without retaining phantom cache evidence", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    fs.writeFileSync(cacheFile, [
      "",
      JSON.stringify({ text: "valid", role: "user", ts: 1 }),
      "",
    ].join("\n"), "utf8");

    expect(readAndClearCache(scope).map((entry) => entry.text)).toEqual(["valid"]);
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

    const flush = beginCacheFlush(scope);
    expect(flush.claimed).toBe(true);
    expect(flush.entries.map((entry) => entry.text)).toEqual(["survivor", "flushed"]);

    appendToCache({ text: "concurrent append", role: "user" }, scope);
    finishCacheFlush(flush, [flush.entries[0]]);

    const remaining = readAndClearCache(scope);
    expect(remaining.map((entry) => entry.text).sort()).toEqual(["concurrent append", "survivor"]);
    expect(remaining.find((entry) => entry.text === "survivor").memory_metadata).toEqual({ client: "codex" });
  });

  it("separates a restored survivor from a concurrent torn live tail", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    const torn = Buffer.from('{"text":"torn');
    appendToCache({ text: "retry-me", role: "user" }, scope);

    const flush = beginCacheFlush(scope);
    expect(flush.entries.map((entry) => entry.text)).toEqual(["retry-me"]);
    fs.writeFileSync(cacheFile, torn);
    finishCacheFlush(flush, flush.entries);

    const raw = fs.readFileSync(cacheFile);
    expect(raw.subarray(0, torn.length)).toEqual(torn);
    expect(raw[torn.length]).toBe(0x0a);
    const retry = beginCacheFlush(scope);
    expect(retry.entries.map((entry) => entry.text)).toEqual(["retry-me"]);
    finishCacheFlush(retry, []);
    expect(fs.readFileSync(cacheFile)).toEqual(Buffer.concat([Buffer.from("\n"), torn, Buffer.from("\n")]));
  });

  it("keeps a restored survivor separate when a torn writer lands before its write", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    const torn = Buffer.from('{"text":"concurrent-torn');
    appendToCache({ text: "retry-survivor", role: "assistant" }, scope);
    const original = beginCacheFlush(scope);
    const realWriteFile = fs.writeFileSync.bind(fs);
    let injected = false;
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, ...args) => {
      if (!injected && typeof file === "number") {
        const opened = fs.fstatSync(file);
        const live = fs.statSync(cacheFile);
        if (opened.dev === live.dev && opened.ino === live.ino) {
          injected = true;
          fs.appendFileSync(cacheFile, torn);
        }
      }
      return realWriteFile(file, data, ...args);
    });

    try {
      finishCacheFlush(original, original.entries);
    } finally {
      writeSpy.mockRestore();
    }

    const raw = fs.readFileSync(cacheFile);
    expect(injected).toBe(true);
    expect(original.entries.map((entry) => entry.text)).toEqual(["retry-survivor"]);
    expect(raw.subarray(0, torn.length)).toEqual(torn);
    expect(raw[torn.length]).toBe(0x0a);
    const retry = beginCacheFlush(scope);
    expect(retry.entries.map((entry) => entry.text)).toEqual(["retry-survivor"]);
    finishCacheFlush(retry, []);
    expect(fs.readFileSync(cacheFile)).toEqual(Buffer.concat([Buffer.from("\n"), torn, Buffer.from("\n")]));
  });

  it("does not let a losing flusher delete another flusher's processing batch", () => {
    const scope = "concurrent-flusher-scope";
    appendToCache({ text: "owned by winner", role: "user" }, scope);

    const owner = beginCacheFlush(scope);
    expect(owner.claimed).toBe(true);
    expect(owner.entries.map((entry) => entry.text)).toEqual(["owned by winner"]);

    const loser = beginCacheFlush(scope);
    expect(loser.claimed).toBe(false);
    expect(loser.entries).toEqual([]);

    finishCacheFlush(loser, []);
    expect(hasCachedEntries(scope)).toBe(true);

    finishCacheFlush(owner, []);
    expect(hasCachedEntries(scope)).toBe(false);
  });

  it("recovers processing files left by an interrupted flush", () => {
    const scope = "interrupted-flush-scope";
    appendToCache({ text: "pending before crash", role: "user" }, scope);

    const firstFlush = beginCacheFlush(scope);
    expect(firstFlush.claimed).toBe(true);
    expect(firstFlush.entries.map((entry) => entry.text)).toEqual(["pending before crash"]);
    expect(hasCachedEntries(scope)).toBe(true);

    const concurrentFlush = beginCacheFlush(scope);
    expect(concurrentFlush.claimed).toBe(false);

    fs.unlinkSync(firstFlush.lockFile);
    const recoveredFlush = beginCacheFlush(scope);
    expect(recoveredFlush.claimed).toBe(true);
    expect(recoveredFlush.entries.map((entry) => entry.text)).toEqual(["pending before crash"]);

    finishCacheFlush(recoveredFlush, []);
    expect(hasCachedEntries(scope)).toBe(false);
  });

  it("preserves torn and structurally invalid raw segments after valid entries succeed", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    const malformed = Buffer.from('{"text":42,"role":"user"}\n');
    const torn = Buffer.from('{"text":"torn');
    fs.writeFileSync(cacheFile, Buffer.concat([
      Buffer.from('{"text":"valid","role":"user","ts":1}\n'),
      malformed,
      torn,
    ]));

    const flush = beginCacheFlush(scope);
    expect(flush.entries.map((entry) => entry.text)).toEqual(["valid"]);
    finishCacheFlush(flush, []);

    expect(fs.readFileSync(cacheFile)).toEqual(Buffer.concat([Buffer.from("\n"), malformed, torn]));
  });

  it("separates malformed-only restoration from a concurrent torn live prefix", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    const malformed = Buffer.from('evil","role":"user","ts":1}\n');
    const tornPrefix = Buffer.from('{"text":"');
    fs.writeFileSync(cacheFile, malformed);

    const flush = beginCacheFlush(scope);
    expect(flush.entries).toEqual([]);
    fs.writeFileSync(cacheFile, tornPrefix);
    finishCacheFlush(flush, []);

    expect(fs.readFileSync(cacheFile)).toEqual(Buffer.concat([
      tornPrefix,
      Buffer.from("\n"),
      malformed,
    ]));
    const retry = beginCacheFlush(scope);
    expect(retry.entries).toEqual([]);
  });

  it("preserves every original byte of a finite unattempted tail", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    const first = Buffer.from('{"text":"first","role":"user","ts":1}\n');
    const second = Buffer.from('  {"text":"second","role":"assistant","ts":2}  \n');
    const third = Buffer.from('{"text":"third","role":"user","ts":3}');
    fs.writeFileSync(cacheFile, Buffer.concat([first, second, third]));

    const flush = beginCacheFlush(scope);
    finishCacheFlush(flush, flush.entries.slice(1));

    expect(fs.readFileSync(cacheFile)).toEqual(Buffer.concat([
      Buffer.from("\n"),
      second,
      third,
    ]));
  });

  it("preserves a complete append through a descriptor opened before handoff", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    const late = Buffer.from('  {"text":"late-fd","role":"assistant","ts":2}  \n');
    appendToCache({ text: "snapshot", role: "user" }, scope);
    const staleFd = fs.openSync(cacheFile, "a");

    const flush = beginCacheFlush(scope);
    fs.writeSync(staleFd, late);
    fs.closeSync(staleFd);
    finishCacheFlush(flush, []);

    expect(fs.readFileSync(cacheFile)).toEqual(late);
    expect(fs.existsSync(`${cacheFile}.processing`)).toBe(false);
  });

  it("preserves a torn append through a descriptor opened before handoff", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    const late = Buffer.from('{"text":"late-torn');
    appendToCache({ text: "snapshot", role: "user" }, scope);
    const staleFd = fs.openSync(cacheFile, "a");

    const flush = beginCacheFlush(scope);
    fs.writeSync(staleFd, late);
    fs.closeSync(staleFd);
    finishCacheFlush(flush, []);

    expect(fs.readFileSync(cacheFile)).toEqual(late);
    expect(fs.existsSync(`${cacheFile}.processing`)).toBe(false);
  });

  it("retains processing evidence when its identity changes after snapshot", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    const processingFile = `${cacheFile}.processing`;
    const originalFile = `${processingFile}.original`;
    appendToCache({ text: "snapshot", role: "user" }, scope);

    const flush = beginCacheFlush(scope);
    fs.renameSync(processingFile, originalFile);
    const replacement = Buffer.from('{"text":"replacement","role":"user","ts":2}\n');
    fs.writeFileSync(processingFile, replacement);
    finishCacheFlush(flush, []);

    expect(fs.existsSync(originalFile)).toBe(true);
    expect(fs.readFileSync(processingFile)).toEqual(replacement);
  });

  it("retains processing evidence when its snapshot prefix changes", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    const processingFile = `${cacheFile}.processing`;
    appendToCache({ text: "snapshot", role: "user" }, scope);

    const flush = beginCacheFlush(scope);
    const changed = Buffer.from('{"text":"changed","role":"user","ts":2}\n');
    fs.writeFileSync(processingFile, changed);
    finishCacheFlush(flush, []);

    expect(fs.readFileSync(processingFile)).toEqual(changed);
  });

  it("reappends a pre-handoff write that lands after the final processing proof", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    const processingFile = `${cacheFile}.processing`;
    appendToCache({ text: "snapshot", role: "user" }, scope);

    const realAppend = fs.appendFileSync.bind(fs);
    const realOpen = fs.openSync.bind(fs);
    const realWriteFile = fs.writeFileSync.bind(fs);
    const realLstat = fs.lstatSync.bind(fs);
    let claimed;
    let intercepted = false;
    let processingLstats = 0;

    const finishAtFinalCheck = (fd, data, args) => {
      claimed = beginCacheFlush(scope);
      const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation((target, ...lstatArgs) => {
        if (String(target) === processingFile) {
          processingLstats += 1;
          if (processingLstats === 5) realWriteFile(fd, data, ...args);
        }
        return realLstat(target, ...lstatArgs);
      });
      try {
        finishCacheFlush(claimed, []);
      } finally {
        lstatSpy.mockRestore();
      }
    };

    const appendSpy = vi.spyOn(fs, "appendFileSync").mockImplementation((file, data, ...args) => {
      if (!intercepted && String(file) === cacheFile) {
        intercepted = true;
        const fd = realOpen(file, "a", 0o600);
        try { finishAtFinalCheck(fd, data, args); } finally { fs.closeSync(fd); }
        return;
      }
      return realAppend(file, data, ...args);
    });
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, ...args) => {
      if (!intercepted && typeof file === "number") {
        const opened = fs.fstatSync(file);
        const live = fs.statSync(cacheFile);
        if (opened.dev === live.dev && opened.ino === live.ino) {
          intercepted = true;
          finishAtFinalCheck(file, data, args);
          return;
        }
      }
      return realWriteFile(file, data, ...args);
    });

    try {
      appendToCache({ text: "after-final-proof", role: "assistant" }, scope);
    } finally {
      writeSpy.mockRestore();
      appendSpy.mockRestore();
    }

    expect(intercepted).toBe(true);
    expect(processingLstats).toBe(5);
    expect(claimed.entries.map((entry) => entry.text)).toEqual(["snapshot"]);
    expect(fs.existsSync(cacheFile)).toBe(true);
    expect(fs.readFileSync(cacheFile, "utf8").trim().split("\n").map(JSON.parse)
      .map((entry) => entry.text)).toEqual(["after-final-proof"]);
    expect(fs.existsSync(processingFile)).toBe(false);
  });

  it("reappends when the compensating write crosses a second final-proof handoff", () => {
    const scope = HEX_A;
    const cacheFile = path.join(tmpDir, `midbrain-episodic-cache-${scope}.ndjson`);
    const processingFile = `${cacheFile}.processing`;
    appendToCache({ text: "snapshot", role: "user" }, scope);

    const realWriteFile = fs.writeFileSync.bind(fs);
    const realLstat = fs.lstatSync.bind(fs);
    const claimedBatches = [];
    const processingLstats = [];
    let interceptedWrites = 0;

    const finishAtFinalCheck = (fd, data, args) => {
      const batch = beginCacheFlush(scope);
      const batchIndex = claimedBatches.push(batch) - 1;
      processingLstats[batchIndex] = 0;
      const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation((target, ...lstatArgs) => {
        if (String(target) === processingFile) {
          processingLstats[batchIndex] += 1;
          if (processingLstats[batchIndex] === 5) realWriteFile(fd, data, ...args);
        }
        return realLstat(target, ...lstatArgs);
      });
      try {
        finishCacheFlush(batch, []);
      } finally {
        lstatSpy.mockRestore();
      }
    };

    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, ...args) => {
      if (interceptedWrites < 2 && typeof file === "number" && fs.existsSync(cacheFile)) {
        const opened = fs.fstatSync(file);
        const live = fs.statSync(cacheFile);
        if (opened.dev === live.dev && opened.ino === live.ino) {
          interceptedWrites += 1;
          finishAtFinalCheck(file, data, args);
          return;
        }
      }
      return realWriteFile(file, data, ...args);
    });

    try {
      appendToCache({ text: "must-survive", role: "assistant" }, scope);
    } finally {
      writeSpy.mockRestore();
    }

    expect(interceptedWrites).toBe(2);
    expect(processingLstats).toEqual([5, 5]);
    expect(claimedBatches.map((batch) => batch.entries.map((entry) => entry.text)))
      .toEqual([["snapshot"], []]);
    expect(fs.existsSync(cacheFile)).toBe(true);
    expect(fs.readFileSync(cacheFile, "utf8").trim().split("\n").map(JSON.parse)
      .map((entry) => entry.text)).toEqual(["must-survive"]);
    expect(fs.existsSync(processingFile)).toBe(false);
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

describe("countCachedEntries", () => {
  it("returns zero for an empty binding", () => {
    expect(countCachedEntries("count-empty")).toBe(0);
  });

  it("counts valid entries in the live file", () => {
    appendToCache({ text: "one", role: "user" }, "count-live");
    appendToCache({ text: "two", role: "assistant" }, "count-live");
    expect(countCachedEntries("count-live")).toBe(2);
  });

  it("counts valid entries in the processing file", () => {
    appendToCache({ text: "processing", role: "user" }, "count-processing");
    const live = path.join(tmpDir, fs.readdirSync(tmpDir)[0]);
    fs.renameSync(live, `${live}.processing`);
    expect(countCachedEntries("count-processing")).toBe(1);
  });

  it("sums live and processing files", () => {
    appendToCache({ text: "processing", role: "user" }, "count-both");
    const live = path.join(tmpDir, fs.readdirSync(tmpDir)[0]);
    fs.renameSync(live, `${live}.processing`);
    appendToCache({ text: "live", role: "assistant" }, "count-both");
    expect(countCachedEntries("count-both")).toBe(2);
  });

  it("skips malformed and structurally invalid lines", () => {
    appendToCache({ text: "valid", role: "user" }, "count-malformed");
    const live = path.join(tmpDir, fs.readdirSync(tmpDir)[0]);
    fs.appendFileSync(live, "not-json\n{\"text\":42,\"role\":\"user\"}\n");
    expect(countCachedEntries("count-malformed")).toBe(1);
  });
});

describe("inspectCachedEntries", () => {
  it("distinguishes malformed-only files from an empty binding", () => {
    appendToCache({ text: "seed", role: "user" }, "malformed-only");
    const live = path.join(tmpDir, fs.readdirSync(tmpDir)[0]);
    fs.writeFileSync(live, "not-json\n", "utf8");

    expect(inspectCachedEntries("malformed-only")).toMatchObject({
      count: 0,
      filesPresent: true,
      unparseable: true,
      otherBindings: 0,
      cacheDir: tmpDir,
    });
  });

  it("counts other bindings once across live and processing files", () => {
    appendToCache({ text: "current", role: "user" }, "current-binding");
    appendToCache({ text: "other", role: "user" }, "other-binding");
    const other = fs.readdirSync(tmpDir)
      .map((name) => path.join(tmpDir, name))
      .find((name) => fs.readFileSync(name, "utf8").includes("other"));
    fs.copyFileSync(other, `${other}.processing`);

    expect(inspectCachedEntries("current-binding")).toMatchObject({
      count: 1,
      filesPresent: true,
      unparseable: false,
      otherBindings: 1,
    });
  });

  // AC-6: a malformed-only OTHER binding still holds unflushed content, so it
  // must count as a pending other binding (was undercounted to 0).
  it("counts a malformed-only other binding as pending", () => {
    appendToCache({ text: "current", role: "user" }, "current-binding");
    appendToCache({ text: "other", role: "user" }, "other-binding");
    const other = fs.readdirSync(tmpDir)
      .map((name) => path.join(tmpDir, name))
      .find((name) => fs.readFileSync(name, "utf8").includes("other"));
    fs.writeFileSync(other, "not-json\n", "utf8"); // malformed-only content

    expect(inspectCachedEntries("current-binding")).toMatchObject({
      count: 1,
      otherBindings: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// listCacheBindings / hasAnyCachedEntries (boot drain support, #53)
// ---------------------------------------------------------------------------

describe("listCacheBindings", () => {
  it("returns [] when the cache dir is empty", () => {
    expect(listCacheBindings()).toEqual([]);
  });

  it("lists every scope binding, de-duped across live + processing", () => {
    appendToCache({ text: "a1", role: "user" }, HEX_A);
    appendToCache({ text: "b1", role: "user" }, HEX_B);
    // Give scope A a processing file too — must not double-count.
    const flush = beginCacheFlush(HEX_A);
    // finish with survivors so the live file exists alongside no processing.
    finishCacheFlush(flush, flush.entries);

    const bindings = listCacheBindings();
    expect(new Set(bindings)).toEqual(new Set([HEX_A, HEX_B]));
  });

  it("includes the unscoped default binding as undefined", () => {
    appendToCache({ text: "d", role: "user" }); // no scope -> default file
    expect(listCacheBindings()).toEqual([undefined]);
  });

  it("each binding round-trips through beginCacheFlush to its own entries", () => {
    appendToCache({ text: "for-a", role: "user" }, HEX_A);
    appendToCache({ text: "for-b", role: "user" }, HEX_B);

    const drained = {};
    for (const scope of listCacheBindings()) {
      const flush = beginCacheFlush(scope);
      drained[scope] = flush.entries.map((e) => e.text);
      finishCacheFlush(flush, []);
    }
    expect(drained[HEX_A]).toEqual(["for-a"]);
    expect(drained[HEX_B]).toEqual(["for-b"]);
  });
});

describe("hasAnyCachedEntries", () => {
  it("false when empty, true when any binding has entries", () => {
    expect(hasAnyCachedEntries()).toBe(false);
    appendToCache({ text: "x", role: "user" }, HEX_A);
    expect(hasAnyCachedEntries()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cache-wide cooldown sidecar (#53)
// ---------------------------------------------------------------------------

describe("cache cooldown sidecar", () => {
  it("reads 0 when unset", () => {
    expect(readCacheCooldownUntil(HEX_A)).toBe(0);
  });

  it("persists one future timestamp across every scope", () => {
    const until = Date.now() + 60_000;
    writeCacheCooldownUntil(HEX_A, until);
    expect(readCacheCooldownUntil(HEX_A)).toBe(until);
    expect(readCacheCooldownUntil(HEX_B)).toBe(until);
  });

  it("clearCacheCooldown removes it", () => {
    writeCacheCooldownUntil(HEX_A, Date.now() + 60_000);
    clearCacheCooldown(HEX_A);
    expect(readCacheCooldownUntil(HEX_A)).toBe(0);
  });

  it("a corrupt cooldown file reads as 0 (never throws)", () => {
    writeCacheCooldownUntil(HEX_A, Date.now() + 1000);
    // Corrupt the sidecar.
    const file = path.join(tmpDir, "midbrain-episodic-cache.ndjson.cooldown");
    fs.writeFileSync(file, "garbage");
    expect(readCacheCooldownUntil(HEX_A)).toBe(0);
  });

  it("the cooldown sidecar is NOT counted as a cache binding", () => {
    appendToCache({ text: "real", role: "user" }, HEX_A);
    writeCacheCooldownUntil(HEX_A, Date.now() + 60_000);
    // Only the real .ndjson binding is listed; the .cooldown sidecar is ignored.
    expect(listCacheBindings()).toEqual([HEX_A]);
  });
});
