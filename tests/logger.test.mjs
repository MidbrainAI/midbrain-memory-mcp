/**
 * Unit tests for shared/logger.mjs
 */

import { describe, it, expect } from "vitest";
import { makeDebugLogger } from "../shared/logger.mjs";

describe("makeDebugLogger", () => {
  it("returns a function", () => {
    const log = makeDebugLogger("/tmp/test-debug.log");
    expect(typeof log).toBe("function");
  });

  it("never throws", () => {
    const log = makeDebugLogger("/nonexistent/path/debug.log");
    expect(() => log("test message")).not.toThrow();
  });
});
