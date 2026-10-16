/**
 * Unit tests for shared/identity-context.mjs
 */

import { describe, expect, it, vi } from "vitest";
import { MidbrainApi } from "../shared/midbrain-api.mjs";

import {
  IDENTITY_MAX_CHARS,
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

  it("passes server-sized fields through untouched", () => {
    const persona = "p".repeat(10_000);
    expect(formatIdentityContext({ persona })).toContain(persona);
  });

  it("caps only a malformed, oversized response at the safety ceiling", () => {
    const block = formatIdentityContext({ persona: "x".repeat(IDENTITY_MAX_CHARS * 2) });
    expect(block.length).toBe(IDENTITY_MAX_CHARS);
    expect(block.endsWith("\n[truncated]")).toBe(true);
  });

  it("adds no markers, nonces or signatures", () => {
    const block = formatIdentityContext({ persona: "Be concise." });
    expect(block).not.toMatch(/<!--|mb:identity|sig=|nonce=/);
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

describe("storage boundary", () => {
  it.each(["storeEpisodic", "postEpisodicResult"])("%s stores assistant text unchanged", async (method) => {
    const api = new MidbrainApi("fixture-agent", "fixture");
    const text = `${formatIdentityContext({ persona: "Quoted persona" })}\n\nFinal answer`;
    const posted = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
      posted.push(JSON.parse(opts.body));
      return { ok: true, status: 201 };
    });
    const log = { info() {}, debug() {}, warn() {}, error() {} };
    try {
      if (method === "storeEpisodic") await api.storeEpisodic(text, "assistant", log);
      else await api.postEpisodicResult(text, "assistant");
      expect(posted.map((body) => body.text)).toEqual([text]);
    } finally { fetch.mockRestore(); }
  });
});
