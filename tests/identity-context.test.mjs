/**
 * Unit tests for shared/identity-context.mjs
 */

import { describe, expect, it, vi } from "vitest";
import { MidbrainApi } from "../shared/midbrain-api.mjs";

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
    const api = new MidbrainApi("fixture-key", "fixture");
    const block = formatIdentityContext({ persona: "Be concise." }, api);

    expect(scrubIdentityContext(`${block}\n\nFinal answer`, api)).toBe("Final answer");
  });

  it("keeps an unsigned identity-shaped example", () => {
    const text = "<!-- mb:identity-start -->\nnot from the hook\n<!-- mb:identity-end -->";

    expect(scrubIdentityContext(text)).toBe(text);
  });

  it("preserves documentation examples with real persona headings", () => {
    const text = "Example:\n```markdown\n<!-- mb:identity-start -->\n## Agent persona\nAn example, never injected.\n<!-- mb:identity-end -->\n```";
    expect(scrubIdentityContext(text)).toBe(text);
  });

  it("only removes blocks authenticated for the capturing API binding", async () => {
    const api = new MidbrainApi("fixture-agent-a", "fixture", { apiBase: "https://a.example" });
    api.getPersona = async () => "Be concise.";
    api.getProfile = async () => null;
    const block = await loadIdentityContext(api);
    const sameBinding = new MidbrainApi("fixture-agent-a", "fixture", { apiBase: "https://a.example" });
    const otherKey = new MidbrainApi("fixture-agent-b", "fixture", { apiBase: "https://a.example" });
    const otherHost = new MidbrainApi("fixture-agent-a", "fixture", { apiBase: "https://b.example" });
    expect(scrubIdentityContext(block, sameBinding)).toBe("");
    expect(scrubIdentityContext(block, otherKey)).toBe(block);
    expect(scrubIdentityContext(block, otherHost)).toBe(block);
    expect(scrubIdentityContext(block)).toBe(block);
    const edited = block.replace("Be concise.", "Changed after injection.");
    expect(scrubIdentityContext(edited, sameBinding)).toBe(edited);
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

describe("authenticated identity at the storage boundary", () => {
  it.each(["storeEpisodic", "postEpisodicResult"])("%s strips valid echoes but keeps user text and unsigned examples", async (method) => {
    const author = new MidbrainApi("fixture-agent", "fixture");
    const capture = new MidbrainApi("fixture-agent", "independent-hook");
    const block = formatIdentityContext({ persona: "Private identity" }, author);
    const example = formatIdentityContext({ persona: "Documentation sample" });
    const posted = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, opts) => {
      posted.push(JSON.parse(opts.body));
      return { ok: true, status: 201 };
    });
    const log = { info() {}, debug() {}, warn() {}, error() {} };
    const store = (text, role) => method === "storeEpisodic"
      ? capture.storeEpisodic(text, role, log)
      : capture.postEpisodicResult(text, role);
    try {
      await store(`${block}\n\nFinal answer`, "assistant");
      await store(example, "assistant");
      await store(block, "user");
      await store(block, "assistant");
      expect(posted.map(({ text }) => text)).toEqual(["Final answer", example, block]);
    } finally { fetch.mockRestore(); }
  });
});
