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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  spoolBindingPath,
  establishSpoolBinding,
  _setSpoolDir,
} from "../shared/claude-spool.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-spool-test-"));
  _setSpoolDir(tmpDir);
  establishSpoolBinding("0".repeat(64));
});

afterEach(() => {
  _setSpoolDir(null);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const IS_WIN = process.platform === "win32";

function entry(text, role = "user", meta) {
  return { text, role, memory_metadata: meta || { client: "nanoclaw" } };
}

// ---------------------------------------------------------------------------
// appendToSpool
// ---------------------------------------------------------------------------

describe("appendToSpool", () => {
  it("requires a valid binding sidecar and stamps the opaque binding", () => {
    const binding = "a".repeat(64);
    fs.unlinkSync(spoolBindingPath());
    expect(appendToSpool(entry("unbound", "user", { client: "nanoclaw" }))).toBe(false);
    expect(fs.existsSync(spoolFilePath())).toBe(false);

    expect(establishSpoolBinding(binding)).toMatchObject({ ok: true, previous: null });
    expect(appendToSpool(entry("bound", "user", { client: "nanoclaw" }))).toBe(true);
    const line = JSON.parse(fs.readFileSync(spoolFilePath(), "utf8").trim());
    expect(line.binding).toBe(binding);
    expect(fs.statSync(spoolBindingPath()).mode & 0o777).toBe(IS_WIN ? (fs.statSync(spoolBindingPath()).mode & 0o777) : 0o600);
  });

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
  }, 30_000);

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

  it("refuses a symlink swapped in at the spool open boundary", () => {
    if (IS_WIN) return;
    const victim = path.join(tmpDir, "swap-victim.ndjson");
    fs.writeFileSync(victim, "sentinel\n");
    const realOpen = fs.openSync.bind(fs);
    let swapped = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((file, ...args) => {
      if (!swapped && file === spoolFilePath()) {
        fs.symlinkSync(victim, spoolFilePath());
        swapped = true;
      }
      return realOpen(file, ...args);
    });
    try {
      expect(appendToSpool(entry("must-not-reach-victim"))).toBe(false);
    } finally {
      openSpy.mockRestore();
    }

    expect(swapped).toBe(true);
    expect(fs.readFileSync(victim, "utf8")).toBe("sentinel\n");
  });

  it("refuses to replace a binding sidecar symlink", () => {
    if (IS_WIN) return;
    const victim = path.join(tmpDir, "binding-victim");
    fs.writeFileSync(victim, "victim\n");
    fs.unlinkSync(spoolBindingPath());
    fs.symlinkSync(victim, spoolBindingPath());

    expect(establishSpoolBinding("c".repeat(64)).ok).toBe(false);
    expect(fs.readFileSync(victim, "utf8")).toBe("victim\n");
  });

  it.skipIf(IS_WIN || !fs.constants.O_NOFOLLOW)("keeps sidecar symlink refusal when no-follow flags are unavailable", () => {
    const binding = "0".repeat(64);
    const victim = path.join(tmpDir, "binding-fallback-victim");
    fs.writeFileSync(victim, `${binding}\n`, { mode: 0o644 });
    fs.unlinkSync(spoolBindingPath());
    fs.symlinkSync(victim, spoolBindingPath());
    const before = fs.readFileSync(victim);
    const realOpen = fs.openSync.bind(fs);
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((file, flags, ...args) => {
      const fallbackFlags = typeof flags === "number"
        ? flags & ~fs.constants.O_NOFOLLOW
        : flags;
      return realOpen(file, fallbackFlags, ...args);
    });
    try {
      expect(establishSpoolBinding(binding).ok).toBe(false);
    } finally {
      openSpy.mockRestore();
    }

    expect(fs.readFileSync(victim)).toEqual(before);
    expect(fs.lstatSync(spoolBindingPath()).isSymbolicLink()).toBe(true);
  });

  it("preserves malformed existing binding state instead of treating it as absent", () => {
    fs.writeFileSync(spoolBindingPath(), "malformed-existing-binding\n", { mode: 0o600 });

    expect(establishSpoolBinding("d".repeat(64)).ok).toBe(false);
    expect(fs.readFileSync(spoolBindingPath(), "utf8")).toBe("malformed-existing-binding\n");
  });

  it("restores mode 0600 for an unchanged valid binding", () => {
    if (IS_WIN) return;
    fs.chmodSync(spoolBindingPath(), 0o644);
    const binding = fs.readFileSync(spoolBindingPath(), "utf8").trim();

    expect(establishSpoolBinding(binding).ok).toBe(true);
    expect(fs.statSync(spoolBindingPath()).mode & 0o777).toBe(0o600);
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

  it("preserves an append opened before claim and written after the snapshot", () => {
    appendToSpool(entry("before"));
    const realWriteFile = fs.writeFileSync.bind(fs);
    let claimed;
    let intercepted = false;
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, ...args) => {
      if (!intercepted && typeof file === "number") {
        const openFile = fs.fstatSync(file);
        const liveFile = fs.statSync(spoolFilePath());
        if (openFile.dev === liveFile.dev && openFile.ino === liveFile.ino) {
          intercepted = true;
          claimed = beginSpoolFlush();
        }
      }
      return realWriteFile(file, data, ...args);
    });
    try {
      expect(appendToSpool(entry("racing"))).toBe(true);
    } finally {
      writeSpy.mockRestore();
    }

    expect(intercepted).toBe(true);
    expect(claimed.entries.map((e) => e.text)).toEqual(["before"]);
    finishSpoolFlush(claimed, []);
    expect(beginSpoolFlush().entries.map((e) => e.text)).toEqual(["racing"]);
  });

  it.each(["live", "processing"])("refuses a %s spool source symlink", (source) => {
    if (IS_WIN) return;
    const victim = path.join(tmpDir, `${source}-source-victim.ndjson`);
    const sourcePath = source === "live" ? spoolFilePath() : `${spoolFilePath()}.processing`;
    fs.writeFileSync(victim, `${JSON.stringify(entry("outside"))}\n`, { mode: 0o600 });
    fs.symlinkSync(victim, sourcePath);

    expect(beginSpoolFlush()).toMatchObject({ claimed: false, entries: [] });
    expect(fs.lstatSync(sourcePath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(victim, "utf8")).toBe(`${JSON.stringify(entry("outside"))}\n`);
  });

  it.each(["live", "processing"])("refuses a non-regular %s spool source", (source) => {
    const sourcePath = source === "live" ? spoolFilePath() : `${spoolFilePath()}.processing`;
    fs.mkdirSync(sourcePath);

    expect(beginSpoolFlush()).toMatchObject({ claimed: false, entries: [] });
    expect(fs.lstatSync(sourcePath).isDirectory()).toBe(true);
  });

  it.skipIf(IS_WIN || !fs.constants.O_NOFOLLOW)("refuses a live source swapped to a symlink without no-follow support", () => {
    const source = spoolFilePath();
    const original = `${source}.original`;
    const victim = path.join(tmpDir, "source-fallback-victim.ndjson");
    const sourceBytes = `${JSON.stringify(entry("owned"))}\n`;
    fs.writeFileSync(source, sourceBytes, { mode: 0o600 });
    fs.writeFileSync(victim, `${JSON.stringify(entry("outside"))}\n`, { mode: 0o600 });
    const victimBefore = fs.readFileSync(victim);
    const realOpen = fs.openSync.bind(fs);
    let swapped = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((file, flags, ...args) => {
      if (!swapped && file === source) {
        fs.renameSync(source, original);
        fs.symlinkSync(victim, source);
        swapped = true;
      }
      const fallbackFlags = typeof flags === "number" ? flags & ~fs.constants.O_NOFOLLOW : flags;
      return realOpen(file, fallbackFlags, ...args);
    });
    try {
      expect(beginSpoolFlush()).toMatchObject({ claimed: false, entries: [] });
    } finally {
      openSpy.mockRestore();
    }

    expect(swapped).toBe(true);
    expect(fs.lstatSync(source).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(original, "utf8")).toBe(sourceBytes);
    expect(fs.readFileSync(victim)).toEqual(victimBefore);
  });

  it("preserves processing evidence replaced before finish", () => {
    if (IS_WIN) return;
    appendToSpool(entry("claimed"));
    const flush = beginSpoolFlush();
    const original = `${flush.processingFile}.original`;
    const victim = path.join(tmpDir, "finish-source-victim.ndjson");
    fs.writeFileSync(victim, "sentinel\n");
    fs.renameSync(flush.processingFile, original);
    fs.symlinkSync(victim, flush.processingFile);

    finishSpoolFlush(flush, []);

    expect(fs.lstatSync(flush.processingFile).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(victim, "utf8")).toBe("sentinel\n");
    expect(fs.existsSync(original)).toBe(true);
  });

  it.skipIf(IS_WIN || !fs.constants.O_NOFOLLOW)("preserves processing when survivor target is a symlink without no-follow support", () => {
    appendToSpool(entry("survivor"));
    const flush = beginSpoolFlush();
    const victim = path.join(tmpDir, "survivor-fallback-victim");
    fs.writeFileSync(victim, "sentinel\n");
    fs.symlinkSync(victim, spoolFilePath());
    const realOpen = fs.openSync.bind(fs);
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((file, flags, ...args) => {
      const fallbackFlags = typeof flags === "number"
        ? flags & ~fs.constants.O_NOFOLLOW
        : flags;
      return realOpen(file, fallbackFlags, ...args);
    });
    try {
      finishSpoolFlush(flush, flush.entries);
    } finally {
      openSpy.mockRestore();
    }

    expect(fs.readFileSync(victim, "utf8")).toBe("sentinel\n");
    expect(fs.existsSync(`${spoolFilePath()}.processing`)).toBe(true);
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

  it("removes only successful valid rows and preserves malformed and torn bytes", () => {
    const binding = "b".repeat(64);
    establishSpoolBinding(binding);
    const valid = JSON.stringify({ ...entry("good", "user"), binding });
    const malformed = "not json\n";
    const torn = '{"text":"torn"';
    fs.writeFileSync(spoolFilePath(), `${valid}\n${malformed}${torn}`, { mode: 0o600 });

    const flush = beginSpoolFlush();
    expect(flush.entries.map((e) => e.text)).toEqual(["good"]);
    finishSpoolFlush(flush, []);

    const remaining = fs.readFileSync(spoolFilePath());
    expect(remaining.includes(Buffer.from(malformed))).toBe(true);
    expect(remaining.includes(Buffer.from(torn))).toBe(true);
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
