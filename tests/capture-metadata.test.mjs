/**
 * Unit tests for shared/capture-metadata.mjs (buildCaptureMetadata).
 */

import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";

import { buildCaptureMetadata } from "../shared/capture-metadata.mjs";

describe("buildCaptureMetadata", () => {
  it("always includes the client and nothing else when no cwd/session", () => {
    expect(buildCaptureMetadata({ client: "codex" })).toEqual({ client: "codex" });
  });

  it("adds cwd as a home-relative path", () => {
    const cwd = path.join(os.homedir(), "proj", "app");
    expect(buildCaptureMetadata({ client: "opencode", cwd })).toEqual({
      client: "opencode",
      cwd: "~/proj/app",
    });
  });

  it("passes non-home absolute cwd through unchanged", () => {
    expect(buildCaptureMetadata({ client: "codex", cwd: "/repo" })).toEqual({
      client: "codex",
      cwd: "/repo",
    });
  });

  it("forwards a nonblank session_id verbatim", () => {
    expect(buildCaptureMetadata({ client: "hermes", sessionId: "  s1  " })).toEqual({
      client: "hermes",
      session_id: "  s1  ",
    });
  });

  it.each([
    ["/home/alice/project", "<redacted>/project"],
    ["/Users/alice/project", "<redacted>/project"],
    ["C:\\Users\\Alice\\project", "<redacted>/project"],
    ["/var/home/alice/project", "<redacted>/project"],
    ["/mnt/Users/Alice/project", "<redacted>/project"],
    ["//server/Users/Alice/project", "<redacted>/project"],
  ])("redacts another user's name from cwd %s", (cwd, expected) => {
    const metadata = buildCaptureMetadata({ client: "claude", cwd });
    expect(metadata.cwd).toBe(expected);
    expect(metadata.cwd.toLowerCase()).not.toContain("alice");
    expect(metadata.cwd).not.toBe(cwd);
  });

  it("omits blank or non-string cwd and session_id", () => {
    expect(buildCaptureMetadata({ client: "claude", cwd: "   ", sessionId: "" })).toEqual({
      client: "claude",
    });
    expect(buildCaptureMetadata({ client: "claude", cwd: 5, sessionId: {} })).toEqual({
      client: "claude",
    });
  });

  it("includes both cwd and session_id when present", () => {
    expect(buildCaptureMetadata({ client: "codex", cwd: "/repo", sessionId: "s1" })).toEqual({
      client: "codex",
      cwd: "/repo",
      session_id: "s1",
    });
  });
});
