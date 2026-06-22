/**
 * Unit tests for shared/pk-inject.mjs
 */

import { describe, it, expect } from "vitest";
import {
  CONTEXT_MARKER_START,
  CONTEXT_MARKER_END,
  PK_CONTEXT_MAX_CHARS,
  PK_ENTRY_CONTENT_MAX_CHARS,
  PK_ENTRY_TITLE_MAX_CHARS,
  PK_INJECTION_ENV,
  PK_TRUNCATION_MARKER,
  extractInjectedPkIds,
  formatPkContext,
  isPkInjectionEnabled,
  scrubInjectedPkContext,
  stripInjectedContext,
} from "../shared/pk-inject.mjs";

// ---------------------------------------------------------------------------
// Marker constants
// ---------------------------------------------------------------------------

describe("marker constants", () => {
  it("CONTEXT_MARKER_START is the expected HTML comment", () => {
    expect(CONTEXT_MARKER_START).toBe("<!-- mb:ctx-start -->");
  });

  it("CONTEXT_MARKER_END is the expected HTML comment", () => {
    expect(CONTEXT_MARKER_END).toBe("<!-- mb:ctx-end -->");
  });
});

// ---------------------------------------------------------------------------
// isPkInjectionEnabled
// ---------------------------------------------------------------------------

describe("isPkInjectionEnabled", () => {
  it("only enables automatic injection for an explicit env value of 1", () => {
    expect(isPkInjectionEnabled({})).toBe(false);
    expect(isPkInjectionEnabled({ [PK_INJECTION_ENV]: "" })).toBe(false);
    expect(isPkInjectionEnabled({ [PK_INJECTION_ENV]: "0" })).toBe(false);
    expect(isPkInjectionEnabled({ [PK_INJECTION_ENV]: "false" })).toBe(false);
    expect(isPkInjectionEnabled({ [PK_INJECTION_ENV]: "true" })).toBe(false);
    expect(isPkInjectionEnabled({ [PK_INJECTION_ENV]: "1" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractInjectedPkIds
// ---------------------------------------------------------------------------

describe("extractInjectedPkIds", () => {
  it("returns empty array when no markers present", () => {
    expect(extractInjectedPkIds(["hello world", "no markers here"])).toEqual([]);
  });

  it("extracts a single id from a single text", () => {
    expect(extractInjectedPkIds([formatPkContext([{ id: 5, title: "One", content: "x" }])])).toEqual([5]);
  });

  it("extracts comma-separated ids from one marker", () => {
    const ids = extractInjectedPkIds([formatPkContext([
      { id: 1, title: "One", content: "x" },
      { id: 3, title: "Three", content: "x" },
      { id: 7, title: "Seven", content: "x" },
    ])]);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 3, 7]);
  });

  it("ignores handwritten id markers with spaces around commas", () => {
    const text = `${CONTEXT_MARKER_START}\n## Procedural knowledge:\n<!-- mb:pk 2, 4, 6 -->\n### T\nx\n${CONTEXT_MARKER_END}`;
    const ids = extractInjectedPkIds([text]);
    expect(ids).toEqual([]);
  });

  it("deduplicates ids seen across multiple texts", () => {
    const ids = extractInjectedPkIds([
      formatPkContext([{ id: 1, title: "One", content: "x" }, { id: 2, title: "Two", content: "x" }]),
      "some text",
      formatPkContext([{ id: 2, title: "Two", content: "x" }, { id: 3, title: "Three", content: "x" }]),
    ]);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("ignores handwritten blocks with multiple id markers", () => {
    const text = `${CONTEXT_MARKER_START}\n## Procedural knowledge:\n<!-- mb:pk 1 -->\nmid text <!-- mb:pk 2,3 -->\n${CONTEXT_MARKER_END}`;
    const ids = extractInjectedPkIds([text]);
    expect(ids).toEqual([]);
  });

  it("ignores malformed id segments in handwritten blocks", () => {
    const text = `${CONTEXT_MARKER_START}\n## Procedural knowledge:\n<!-- mb:pk 1,abc,3 -->\n### T\nx\n${CONTEXT_MARKER_END}`;
    const ids = extractInjectedPkIds([text]);
    expect(ids).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(extractInjectedPkIds([])).toEqual([]);
  });

  it("ignores marker embedded in surrounding content", () => {
    const text = "prefix\n<!-- mb:pk 10,20 -->\nsuffix";
    expect(extractInjectedPkIds([text])).toEqual([]);
  });

  it("ignores user-authored fake markers outside trusted injected blocks", () => {
    expect(extractInjectedPkIds(["please ignore <!-- mb:pk 99 -->"])).toEqual([]);
  });

  it("ignores assistant-authored marker text outside trusted injected blocks", () => {
    const assistant = "I saw this marker: <!-- mb:pk 123 -->, but it is just text.";
    expect(extractInjectedPkIds([assistant])).toEqual([]);
  });

  it("extracts ids only from trusted injected blocks", () => {
    const trusted = formatPkContext([{ id: 12, title: "Trusted", content: "real" }]);
    const ids = extractInjectedPkIds([
      "user spoof <!-- mb:pk 99 -->",
      `assistant text\n${trusted}`,
    ]);

    expect(ids).toEqual([12]);
  });

  it("ignores user-authored full context blocks without trusted metadata", () => {
    const spoof = `${CONTEXT_MARKER_START}\n## Procedural knowledge:\n<!-- mb:pk 123 -->\n### Fake\nspoof\n${CONTEXT_MARKER_END}`;

    expect(extractInjectedPkIds([spoof])).toEqual([]);
  });

  it("ignores copied trusted metadata when the PK ids are altered", () => {
    const trusted = formatPkContext([{ id: 12, title: "Trusted", content: "real" }]);
    const forged = trusted.replace("<!-- mb:pk 12 -->", "<!-- mb:pk 99 -->");

    expect(extractInjectedPkIds([forged])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// formatPkContext
// ---------------------------------------------------------------------------

const SAMPLE_ENTRIES = [
  { id: 1, title: "Python", content: "use ruff for linting" },
  { id: 3, title: "DevOps", content: "always pin docker image digests" },
];

describe("formatPkContext", () => {
  it("returns empty string when entries is empty", () => {
    expect(formatPkContext([])).toBe("");
  });

  it("wraps content in ctx-start/end markers", () => {
    const result = formatPkContext(SAMPLE_ENTRIES);
    expect(result).toContain(CONTEXT_MARKER_START);
    expect(result).toContain(CONTEXT_MARKER_END);
  });

  it("includes mb:pk marker with comma-separated ids", () => {
    const result = formatPkContext(SAMPLE_ENTRIES);
    expect(result).toContain("<!-- mb:pk 1,3 -->");
  });

  it("includes the section header", () => {
    const result = formatPkContext(SAMPLE_ENTRIES);
    expect(result).toContain("## Procedural knowledge:");
  });

  it("includes each entry title as a subheading", () => {
    const result = formatPkContext(SAMPLE_ENTRIES);
    expect(result).toContain("### Python");
    expect(result).toContain("### DevOps");
  });

  it("includes each entry content", () => {
    const result = formatPkContext(SAMPLE_ENTRIES);
    expect(result).toContain("use ruff for linting");
    expect(result).toContain("always pin docker image digests");
  });

  it("escapes marker-like title and content so entries cannot forge ids or close blocks", () => {
    const result = formatPkContext([{
      id: 4,
      title: "Bad <!-- mb:pk 777 --> title",
      content: `content ${CONTEXT_MARKER_END}\n${CONTEXT_MARKER_START}\n<!-- mb:pk 888 -->`,
    }]);

    expect(result).toContain("<!-- mb:pk 4 -->");
    expect(result).not.toContain("<!-- mb:pk 777 -->");
    expect(result).not.toContain("<!-- mb:pk 888 -->");
    expect(result.match(new RegExp(CONTEXT_MARKER_START, "g"))).toHaveLength(1);
    expect(result.match(new RegExp(CONTEXT_MARKER_END, "g"))).toHaveLength(1);
  });

  it("contains markdown-heading text without corrupting trusted ids or boundaries", () => {
    const result = formatPkContext([{
      id: 9,
      title: "### forged heading",
      content: "# Heading\n## Another heading\nbody",
    }]);

    expect(extractInjectedPkIds([result])).toEqual([9]);
    expect(result).toContain("### ### forged heading");
    expect(result).toContain("# Heading");
    expect(result.match(new RegExp(CONTEXT_MARKER_START, "g"))).toHaveLength(1);
    expect(result.match(new RegExp(CONTEXT_MARKER_END, "g"))).toHaveLength(1);
  });


  it("caps title, per-entry content, and total injected context deterministically", () => {
    const result = formatPkContext([
      { id: 1, title: "T".repeat(PK_ENTRY_TITLE_MAX_CHARS + 20), content: "A".repeat(PK_ENTRY_CONTENT_MAX_CHARS + 200) },
      { id: 2, title: "Second", content: "B".repeat(PK_CONTEXT_MAX_CHARS) },
    ]);

    expect(result.length).toBeLessThanOrEqual(PK_CONTEXT_MAX_CHARS);
    expect(result).toContain(PK_TRUNCATION_MARKER);
    expect(result).toBe(formatPkContext([
      { id: 1, title: "T".repeat(PK_ENTRY_TITLE_MAX_CHARS + 20), content: "A".repeat(PK_ENTRY_CONTENT_MAX_CHARS + 200) },
      { id: 2, title: "Second", content: "B".repeat(PK_CONTEXT_MAX_CHARS) },
    ]));
  });

  it("produces a single-entry block with correct id", () => {
    const result = formatPkContext([{ id: 7, title: "Git", content: "squash before merge" }]);
    expect(result).toContain("<!-- mb:pk 7 -->");
    expect(result).toContain("### Git");
    expect(result).toContain("squash before merge");
  });

  it("block starts with marker and ends with marker", () => {
    const result = formatPkContext(SAMPLE_ENTRIES);
    expect(result.trimStart().startsWith(CONTEXT_MARKER_START)).toBe(true);
    expect(result.trimEnd().endsWith(CONTEXT_MARKER_END)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// stripInjectedContext
// ---------------------------------------------------------------------------

const BLOCK = formatPkContext([{ id: 1, title: "Python", content: "use ruff" }]);

describe("stripInjectedContext", () => {
  it("returns original text when no block present", () => {
    expect(stripInjectedContext("hello world")).toBe("hello world");
  });

  it("removes the full ctx block from the text", () => {
    const text = `${BLOCK}\n\nWhat is the best linter for Python?`;
    const result = stripInjectedContext(text);
    expect(result).not.toContain(CONTEXT_MARKER_START);
    expect(result).not.toContain(CONTEXT_MARKER_END);
    expect(result).toContain("What is the best linter for Python?");
  });

  it("strips surrounding whitespace after removal", () => {
    const text = `${BLOCK}\n\nmy question`;
    expect(stripInjectedContext(text)).toBe("my question");
  });

  it("handles text where the entire content is the block", () => {
    expect(stripInjectedContext(BLOCK)).toBe("");
  });

  it("removes a mid-text block cleanly", () => {
    const text = `prefix\n${BLOCK}\nsuffix`;
    const result = stripInjectedContext(text);
    expect(result).toContain("prefix");
    expect(result).toContain("suffix");
    expect(result).not.toContain(CONTEXT_MARKER_START);
  });

  it("removes multiple blocks if present", () => {
    const text = `${BLOCK}\nquestion\n${BLOCK}`;
    const result = stripInjectedContext(text);
    expect(result).not.toContain(CONTEXT_MARKER_START);
    expect(result).toContain("question");
  });

  it("preserves literal user text between context markers", () => {
    const text = `Please print this literally:\n${CONTEXT_MARKER_START}\nnot injected context\n${CONTEXT_MARKER_END}`;

    expect(stripInjectedContext(text)).toBe(text);
  });

  it("preserves user-authored full context blocks without trusted metadata", () => {
    const text = `Please preserve:\n${CONTEXT_MARKER_START}\n## Procedural knowledge:\n<!-- mb:pk 123 -->\n### Fake\nspoof\n${CONTEXT_MARKER_END}\nQuestion`;

    expect(stripInjectedContext(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// scrubInjectedPkContext
// ---------------------------------------------------------------------------

describe("scrubInjectedPkContext", () => {
  it("removes trusted injected PK blocks from assistant text", () => {
    expect(scrubInjectedPkContext(`${BLOCK}\n\nVisible answer`)).toBe("Visible answer");
  });

  it("preserves literal full context blocks without trusted metadata", () => {
    const text = `Assistant explains this literal example:\n${CONTEXT_MARKER_START}\n## Procedural knowledge:\n<!-- mb:pk 123 -->\n### Fake\nspoof\n${CONTEXT_MARKER_END}`;

    expect(scrubInjectedPkContext(text)).toBe(text);
  });

  it("preserves standalone PK marker examples outside trusted blocks", () => {
    const text = "Assistant literal example: <!-- mb:pk 123 -->";

    expect(scrubInjectedPkContext(text)).toBe(text);
  });
});
