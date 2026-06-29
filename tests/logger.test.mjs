/**
 * Unit tests for shared/logger.mjs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { makeLogger, logDir, logFile } from "../shared/logger.mjs";

function readLog(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return ""; }
}

describe("makeLogger", () => {
  let tmpDir;
  let logPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-logger-"));
    logPath = path.join(tmpDir, "test.log");
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("returns an object with level methods", () => {
    const log = makeLogger(logPath);
    for (const level of ["error", "warn", "info", "debug"]) {
      expect(typeof log[level]).toBe("function");
    }
  });

  it("never throws on an unwritable path", () => {
    const log = makeLogger("/nonexistent/dir/that/cannot/exist/debug.log");
    expect(() => log.error("boom")).not.toThrow();
    expect(() => log.debug("boom")).not.toThrow();
  });

  it("writes lines with an ISO timestamp and level tag", () => {
    const log = makeLogger(logPath, { level: "debug" });
    log.info("hello world");
    const contents = readLog(logPath);
    expect(contents).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] hello world\n$/);
  });

  it("default level is info: writes info/warn/error, drops debug", () => {
    const log = makeLogger(logPath, { level: "info" });
    log.error("an error");
    log.warn("a warning");
    log.info("some info");
    log.debug("a debug line");
    const contents = readLog(logPath);
    expect(contents).toContain("[ERROR] an error");
    expect(contents).toContain("[WARN] a warning");
    expect(contents).toContain("[INFO] some info");
    expect(contents).not.toContain("a debug line");
  });

  it("level=error suppresses everything below error", () => {
    const log = makeLogger(logPath, { level: "error" });
    log.error("keep me");
    log.warn("drop me");
    log.info("drop me too");
    log.debug("and me");
    const contents = readLog(logPath);
    expect(contents).toContain("[ERROR] keep me");
    expect(contents).not.toContain("drop me");
    expect(contents).not.toContain("drop me too");
  });

  it("level=debug writes all levels", () => {
    const log = makeLogger(logPath, { level: "debug" });
    log.debug("a debug line");
    expect(readLog(logPath)).toContain("[DEBUG] a debug line");
  });

  it("honors MIDBRAIN_LOG_LEVEL env var", () => {
    const prev = process.env.MIDBRAIN_LOG_LEVEL;
    process.env.MIDBRAIN_LOG_LEVEL = "debug";
    try {
      const log = makeLogger(logPath);
      log.debug("env-enabled debug");
      expect(readLog(logPath)).toContain("[DEBUG] env-enabled debug");
    } finally {
      if (prev === undefined) delete process.env.MIDBRAIN_LOG_LEVEL;
      else process.env.MIDBRAIN_LOG_LEVEL = prev;
    }
  });

  it("falls back to info for an unknown level value", () => {
    const log = makeLogger(logPath, { level: "verbose-nonsense" });
    expect(log.level).toBe("info");
    log.debug("should be dropped");
    log.info("should be kept");
    const contents = readLog(logPath);
    expect(contents).toContain("should be kept");
    expect(contents).not.toContain("should be dropped");
  });

  it("creates the parent directory on first write", () => {
    const nested = path.join(tmpDir, "a", "b", "c", "nested.log");
    const log = makeLogger(nested, { level: "debug" });
    log.info("made the dir");
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("rotates to .1 when the size cap is exceeded", () => {
    const log = makeLogger(logPath, { level: "debug", maxSize: 64 });
    // First write creates the file.
    log.info("first line that is reasonably long to approach the cap");
    // Force size over the cap.
    fs.appendFileSync(logPath, "x".repeat(128));
    // Next write should rotate the oversized file to .1 and start fresh.
    log.info("after rotation");
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(readLog(logPath)).toContain("after rotation");
    expect(readLog(logPath)).not.toContain("first line");
  });
});

describe("logDir / logFile", () => {
  const saved = {};
  const keys = ["MIDBRAIN_LOG_DIR", "XDG_STATE_HOME", "LOCALAPPDATA", "APPDATA"];

  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
    for (const k of keys) delete process.env[k];
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it("honors MIDBRAIN_LOG_DIR override", () => {
    process.env.MIDBRAIN_LOG_DIR = "/custom/log/dir";
    expect(logDir()).toBe("/custom/log/dir");
    expect(logFile("x.log")).toBe(path.join("/custom/log/dir", "x.log"));
  });

  it("uses XDG_STATE_HOME on linux", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    process.env.XDG_STATE_HOME = "/home/u/.local/state";
    expect(logDir()).toBe(path.join("/home/u/.local/state", "midbrain"));
  });

  it("falls back to ~/.local/state on linux without XDG_STATE_HOME", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(logDir()).toBe(path.join(os.homedir(), ".local", "state", "midbrain"));
  });

  it("uses ~/Library/Logs on macOS", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(logDir()).toBe(path.join(os.homedir(), "Library", "Logs", "midbrain"));
  });

  it("uses LOCALAPPDATA on Windows", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    process.env.LOCALAPPDATA = "C:\\Users\\u\\AppData\\Local";
    expect(logDir()).toBe(path.join("C:\\Users\\u\\AppData\\Local", "midbrain", "logs"));
  });
});
