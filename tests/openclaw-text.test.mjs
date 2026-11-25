/**
 * openclawTypedText (#117): what a person typed in an OpenClaw user message.
 * Inputs mirror OpenClaw 2026.9.6: its inbound time envelope and its
 * runtime-context delimiters (src/agents/internal-runtime-context.ts).
 */

import { describe, it, expect } from "vitest";

import { openclawTypedText } from "../shared/openclaw-text.mjs";

const BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

describe("openclawTypedText", () => {
  it("keeps only the typed line of a live agent_end prompt (seen 2026-10-16, #117)", () => {
    const live = [
      "[Fri 2026-10-16 12:02 GMT+2] Without tools: say your codename once more and the number 2, or NONE.",
      "",
      BEGIN,
      "## Media Generation Tasks",
      "- tool=image_generate; none",
      "- tool=video_generate; none",
      END,
    ].join("\n");
    expect(openclawTypedText(live)).toBe("Without tools: say your codename once more and the number 2, or NONE.");
  });

  it("removes the time envelope OpenClaw 2026.9.6 adds to every prompt", () => {
    expect(openclawTypedText("[Wed 2026-11-25 17:00 GMT-3] reply with just BASELINE")).toBe("reply with just BASELINE");
  });

  it("removes a context block placed before the prompt, and several blocks", () => {
    expect(openclawTypedText(`${BEGIN}\nctx\n${END}\n\n[Wed 2026-11-25 17:00 GMT-3] hello`)).toBe("hello");
    expect(openclawTypedText(`a\n${BEGIN}\nx\n${END}\nb\n${BEGIN}\ny\n${END}`)).toBe("a\nb");
  });

  it("removes an empty block and keeps what follows it", () => {
    expect(openclawTypedText(`${BEGIN}\n${END}\ntyped text`)).toBe("typed text");
  });

  it("removes an end line left over, as OpenClaw does", () => {
    expect(openclawTypedText(`typed text\n${END}`)).toBe("typed text");
  });

  it("drops a block with no end line to the end of the text, as OpenClaw does", () => {
    expect(openclawTypedText(`hello\n${BEGIN}\nunfinished context`)).toBe("hello");
  });

  it("returns empty text for a message that is only runtime context", () => {
    expect(openclawTypedText(`${BEGIN}\nOpenClaw runtime event.\n${END}`)).toBe("");
  });

  it("leaves typed text alone, including lookalikes", () => {
    for (const text of [
      "plain prompt",
      "[draft] my notes",
      "The marker <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> is mid-line here",
      "see [Wed 2026-11-25 17:00 GMT-3] later in the line",
      "line one\n[Wed 2026-11-25 17:00 GMT-3] second line",
    ]) expect(openclawTypedText(text)).toBe(text);
  });
});
