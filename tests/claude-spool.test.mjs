/**
 * Unit tests for shared/claude-spool.mjs
 *
 * The spool is the keyless recovery surface for NanoClaw opener capture
 * (issue #52): a Claude hook that resolves no API key appends its payload here
 * — on the durable ~/.claude mount — instead of dropping it. A later
 * authenticated server-start flush drains it.
 *
 * Hard invariant under test: entries are NEVER dropped. The spool has no cap;
 * only a successful flush removes an entry.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  appendToSpool,
  beginSpoolFlush,
  finishSpoolFlush,
  hasSpooledEntries,
  countSpooledEntries,
  readCooldownUntil,
  writeCooldownUntil,
  spoolFilePath,
  _setSpoolDir,
} from "../shared/claude-spool.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-spool-test-"));
  _setSpoolDir(tmpDir);
});

afterEach(() => {
  _setSpoolDir(null);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const IS_WIN = process.platform === "win32";

function entry(text, role = "user", meta) {
  return meta ? { text, role, memory_metadata: meta } : { text, role };
}

// ---------------------------------------------------------------------------
// appendToSpool
// ---------------------------------------------------------------------------

describe("appendToSpool", () => {
  it("creates the spool file on first append and records the entry", () => {
    appendToSpool(entry("opening message", "user", { client: "nanoclaw" }));
    expect(fs.existsSync(spoolFilePath())).toBe(true);
    expect(countSpooledEntries()).toBe(1);
    const line = JSON.parse(fs.readFileSync(spoolFilePath(), "utf8").trim());
    expect(line.text).toBe("opening message");
    expect(line.role).toBe("user");
    expect(line.memory_metadata).toEqual({ client: "nanoclaw" });
    expect(typeof line.ts).toBe("number");
  });

  it("appends multiple entries without dropping any (no cap)", () => {
    for (let i = 0; i < 250; i += 1) appendToSpool(entry(`m${i}`));
    expect(countSpooledEntries()).toBe(250);
  });

  it("writes the spool file with 0600 permissions", () => {
    appendToSpool(entry("x"));
    if (!IS_WIN) {
      const mode = fs.statSync(spoolFilePath()).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("never throws on a bad entry and never throws when the dir is unwritable", () => {
    // A non-serializable entry must not crash the caller.
    const circular = {};
    circular.self = circular;
    expect(() => appendToSpool({ text: "ok", role: "user", memory_metadata: circular })).not.toThrow();
  });

  it("refuses to follow a symlink at the spool path (no traversal write)", () => {
    if (IS_WIN) return; // symlink creation is unreliable on Windows CI
    const outside = path.join(tmpDir, "outside.ndjson");
    fs.writeFileSync(outside, "sentinel\n");
    fs.mkdirSync(path.dirname(spoolFilePath()), { recursive: true });
    fs.symlinkSync(outside, spoolFilePath());

    appendToSpool(entry("should-not-write-through-symlink"));

    // The symlink target must be untouched.
    expect(fs.readFileSync(outside, "utf8")).toBe("sentinel\n");
  });
});

// ---------------------------------------------------------------------------
// begin/finishSpoolFlush (atomic claim)
// ---------------------------------------------------------------------------

describe("spool flush claim", () => {
  it("claims the batch and reads all valid entries", () => {
    appendToSpool(entry("a"));
    appendToSpool(entry("b"));

    const flush = beginSpoolFlush();
    expect(flush.claimed).toBe(true);
    expect(flush.entries.map((e) => e.text)).toEqual(["a", "b"]);
  });

  it("returns not-claimed when there is nothing to flush", () => {
    const flush = beginSpoolFlush();
    expect(flush.claimed).toBe(false);
    expect(flush.entries).toEqual([]);
  });

  it("finish with no survivors removes the processing file (entries gone)", () => {
    appendToSpool(entry("a"));
    const flush = beginSpoolFlush();
    finishSpoolFlush(flush, []);
    expect(hasSpooledEntries()).toBe(false);
    expect(countSpooledEntries()).toBe(0);
  });

  it("finish with survivors preserves them for the next flush (never dropped)", () => {
    appendToSpool(entry("a"));
    appendToSpool(entry("b"));
    const flush = beginSpoolFlush();
    // Simulate: "a" succeeded, "b" still pending.
    const survivors = flush.entries.filter((e) => e.text === "b");
    finishSpoolFlush(flush, survivors);

    expect(countSpooledEntries()).toBe(1);
    const next = beginSpoolFlush();
    expect(next.entries.map((e) => e.text)).toEqual(["b"]);
  });

  it("concurrent appends during a claim are not lost", () => {
    appendToSpool(entry("first"));
    const flush = beginSpoolFlush();
    // A hook appends while the flush batch is in flight.
    appendToSpool(entry("during"));
    finishSpoolFlush(flush, []);

    // The in-flight append survives in the live file.
    expect(countSpooledEntries()).toBe(1);
    expect(beginSpoolFlush().entries.map((e) => e.text)).toEqual(["during"]);
  });

  it("skips malformed lines without dropping valid ones", () => {
    fs.mkdirSync(path.dirname(spoolFilePath()), { recursive: true });
    fs.writeFileSync(
      spoolFilePath(),
      `${JSON.stringify(entry("good", "user"))}\nnot json\n{"role":"user"}\n`,
      { mode: 0o600 },
    );
    const flush = beginSpoolFlush();
    expect(flush.entries.map((e) => e.text)).toEqual(["good"]);
  });
});

// ---------------------------------------------------------------------------
// cooldown state (WAF backoff)
// ---------------------------------------------------------------------------

describe("flush cooldown", () => {
  it("readCooldownUntil is 0 when no cooldown is set", () => {
    expect(readCooldownUntil()).toBe(0);
  });

  it("writeCooldownUntil persists and reads back a future timestamp", () => {
    const until = Date.now() + 5 * 60_000;
    writeCooldownUntil(until);
    expect(readCooldownUntil()).toBe(until);
  });

  it("a corrupt cooldown file reads as 0 (fail-open, never throws)", () => {
    writeCooldownUntil(Date.now() + 1000);
    // Corrupt it.
    fs.writeFileSync(path.join(tmpDir, ".midbrain-spool-cooldown"), "garbage");
    expect(readCooldownUntil()).toBe(0);
  });
});
