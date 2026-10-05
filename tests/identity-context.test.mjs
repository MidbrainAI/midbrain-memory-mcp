/**
 * Unit tests for shared/identity-context.mjs
 */

import { describe, expect, it } from "vitest";

import {
  IDENTITY_FIELD_MAX_CHARS,
  formatIdentityContext,
  loadIdentityContext,
  scrubIdentityContext,
} from "../shared/identity-context.mjs";

describe("formatIdentityContext", () => {
  it("labels persona and profile inside identity markers", () => {
    const block = formatIdentityContext({
      persona: "Be concise.",
      profile: "Works at CX2.",
    });

    expect(block).toBe([
      "<!-- mb:identity-start -->",
      "## Agent persona",
      "Be concise.",
      "",
      "## User profile",
      "Works at CX2.",
      "<!-- mb:identity-end -->",
    ].join("\n"));
  });

  it("omits an empty side", () => {
    expect(formatIdentityContext({ persona: "Be concise.", profile: "  " })).toBe([
      "<!-- mb:identity-start -->",
      "## Agent persona",
      "Be concise.",
      "<!-- mb:identity-end -->",
    ].join("\n"));
    expect(formatIdentityContext({ persona: null, profile: null })).toBe("");
  });

  it("caps each description at 3000 characters", () => {
    const block = formatIdentityContext({ persona: "a".repeat(IDENTITY_FIELD_MAX_CHARS + 1) });
    const body = block.split("## Agent persona\n")[1].split("\n<!-- mb:identity-end -->")[0];

    expect(body).toHaveLength(IDENTITY_FIELD_MAX_CHARS);
    expect(body.endsWith("[truncated]")).toBe(true);
    expect(body.startsWith("a".repeat(IDENTITY_FIELD_MAX_CHARS - "\n[truncated]".length))).toBe(true);
  });

  it("escapes marker-like text inside a description", () => {
    const block = formatIdentityContext({ persona: "keep <!-- hidden -->" });

    expect(block).toContain("keep &lt;!-- hidden --&gt;");
    expect(block).not.toContain("keep <!-- hidden -->");
  });
});

describe("scrubIdentityContext", () => {
  it("drops an injected identity block and keeps the answer", () => {
    const block = formatIdentityContext({ persona: "Be concise." });

    expect(scrubIdentityContext(`${block}\n\nFinal answer`)).toBe("Final answer");
  });

  it("keeps an unsigned identity-shaped example", () => {
    const text = "<!-- mb:identity-start -->\nnot from the hook\n<!-- mb:identity-end -->";

    expect(scrubIdentityContext(text)).toBe(text);
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
