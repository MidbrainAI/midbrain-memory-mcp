import { describe, expect, it } from "vitest";

import { homeRelativePath } from "../shared/diagnostics.mjs";

describe("homeRelativePath", () => {
  it("renders POSIX home paths without the username", () => {
    expect(homeRelativePath("/Users/alice/project/file", "/Users/alice", "linux"))
      .toBe("~/project/file");
    expect(homeRelativePath("/Users/alice", "/Users/alice", "linux")).toBe("~");
    expect(homeRelativePath("/opt/midbrain", "/Users/alice", "linux"))
      .toBe("/opt/midbrain");
  });

  it("renders win32 home paths with portable separators", () => {
    expect(homeRelativePath(
      "C:\\Users\\Alice\\AppData\\Local\\midbrain",
      "c:\\users\\alice",
      "win32",
    )).toBe("~/AppData/Local/midbrain");
  });

  it("leaves environment and default source labels unchanged", () => {
    expect(homeRelativePath("env:MIDBRAIN_API_KEY", "/Users/alice", "linux"))
      .toBe("env:MIDBRAIN_API_KEY");
    expect(homeRelativePath("default", "/Users/alice", "linux")).toBe("default");
  });
});
