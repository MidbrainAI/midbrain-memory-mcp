/**
 * Unit tests for shared/identity-context.mjs
 */

import { describe, expect, it } from "vitest";

import {
  formatIdentityContext,
  loadIdentityContext,
} from "../shared/identity-context.mjs";

describe("formatIdentityContext", () => {
  it("labels persona and profile under one intro line", () => {
    expect(formatIdentityContext({ persona: "Be concise.", profile: "Works at CX2." })).toBe(
      "MidBrain persona and user profile for this session (read-only):\n\n" +
      "## Agent persona\nBe concise.\n\n## User profile\nWorks at CX2.",
    );
  });

  it("omits an empty side and returns nothing when both are blank", () => {
    const block = formatIdentityContext({ persona: "   ", profile: "Works at CX2." });
    expect(block).toContain("## User profile\nWorks at CX2.");
    expect(block).not.toContain("Agent persona");
    expect(formatIdentityContext({ persona: "", profile: null })).toBe("");
  });

  it("passes fields through at any length: the API owns their size", () => {
    const persona = "p".repeat(100_000);
    const block = formatIdentityContext({ persona });
    expect(block).toContain(persona);
    expect(block).not.toContain("[truncated]");
  });
});

describe("loadIdentityContext", () => {
  it("reads persona and profile and formats both", async () => {
    const api = {
      getPersona: async () => "Be concise.",
      getProfile: async () => "Works at CX2.",
    };

    await expect(loadIdentityContext(api)).resolves.toContain("## Agent persona\nBe concise.");
    await expect(loadIdentityContext(api)).resolves.toContain("## User profile\nWorks at CX2.");
  });

  it("keeps the side that succeeded when the other read throws", async () => {
    const api = {
      getPersona: async () => { throw new Error("persona down"); },
      getProfile: async () => "Works at CX2.",
    };

    const block = await loadIdentityContext(api);
    expect(block).toContain("Works at CX2.");
    expect(block).not.toContain("Agent persona");
  });

  it("returns an empty string when both reads fail", async () => {
    const api = {
      getPersona: async () => { throw new Error("down"); },
      getProfile: async () => { throw new Error("down"); },
    };

    await expect(loadIdentityContext(api)).resolves.toBe("");
  });
});
