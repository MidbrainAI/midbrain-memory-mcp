/**
 * Unit tests for shared/pk-inject.mjs
 */

import { describe, it, expect } from "vitest";
import {
  CONTEXT_MARKER_START,
  CONTEXT_MARKER_END,
  extractInjectedPkIds,
  formatPkContext,
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
// extractInjectedPkIds
// ---------------------------------------------------------------------------

describe("extractInjectedPkIds", () => {
  it("returns empty array when no markers present", () => {
    expect(extractInjectedPkIds(["hello world", "no markers here"])).toEqual([]);
  });

  it("extracts a single id from a single text", () => {
    expect(extractInjectedPkIds(["<!-- mb:pk 5 -->"])).toEqual([5]);
  });

  it("extracts comma-separated ids from one marker", () => {
    const ids = extractInjectedPkIds(["<!-- mb:pk 1,3,7 -->"]);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 3, 7]);
  });

  it("extracts ids with spaces around commas", () => {
    const ids = extractInjectedPkIds(["<!-- mb:pk 2, 4, 6 -->"]);
    expect(ids.sort((a, b) => a - b)).toEqual([2, 4, 6]);
  });

  it("deduplicates ids seen across multiple texts", () => {
    const ids = extractInjectedPkIds([
      "<!-- mb:pk 1,2 -->",
      "some text",
      "<!-- mb:pk 2,3 -->",
    ]);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("extracts ids from multiple markers within one text", () => {
    const text = "<!-- mb:pk 1 --> mid text <!-- mb:pk 2,3 -->";
    const ids = extractInjectedPkIds([text]);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("ignores malformed id segments that are not integers", () => {
    const ids = extractInjectedPkIds(["<!-- mb:pk 1,abc,3 -->"]);
    expect(ids.sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it("returns empty array for empty input", () => {
    expect(extractInjectedPkIds([])).toEqual([]);
  });

  it("handles text with marker embedded in surrounding content", () => {
    const text = "prefix\n<!-- mb:pk 10,20 -->\nsuffix";
    expect(extractInjectedPkIds([text]).sort((a, b) => a - b)).toEqual([10, 20]);
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

const BLOCK = `${CONTEXT_MARKER_START}\n## Procedural knowledge:\n<!-- mb:pk 1 -->\n### Python\nuse ruff\n${CONTEXT_MARKER_END}`;

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
});
