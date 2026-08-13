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

  it("adds a trimmed session_id", () => {
    expect(buildCaptureMetadata({ client: "hermes", sessionId: "  s1  " })).toEqual({
      client: "hermes",
      session_id: "s1",
    });
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
