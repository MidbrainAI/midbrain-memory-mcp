/**
 * shared/pk-inject.mjs
 *
 * Shared helpers for procedural knowledge (PK) context injection.
 * Used by the OpenCode plugin, Claude Code hook, and Codex hook to inject
 * matched PK entries into user messages before they reach the LLM.
 *
 * Marker format is intentionally identical to the litellm-proxy so that
 * sessions spanning both systems deduplicate correctly.
 */

export const CONTEXT_MARKER_START = "<!-- mb:ctx-start -->";
export const CONTEXT_MARKER_END   = "<!-- mb:ctx-end -->";
export const PK_ENTRY_TITLE_MAX_CHARS = 160;
export const PK_ENTRY_CONTENT_MAX_CHARS = 2_000;
export const PK_CONTEXT_MAX_CHARS = 6_000;
export const PK_TRUNCATION_MARKER = "\n[truncated]";

const PK_MARKER_RE  = /<!-- mb:pk ([^-]+) -->/g;
const CTX_BLOCK_RE  = new RegExp(
  CONTEXT_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
  "[\\s\\S]*?" +
  CONTEXT_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  "g"
);
const PK_HEADER = "## Procedural knowledge:";
const HTML_COMMENT_START_RE = /<!--/g;
const HTML_COMMENT_END_RE = /-->/g;

function escapeContextText(value) {
  return String(value ?? "")
    .replace(HTML_COMMENT_START_RE, "&lt;!--")
    .replace(HTML_COMMENT_END_RE, "--&gt;");
}

function truncate(value, maxChars) {
  const text = escapeContextText(value);
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - PK_TRUNCATION_MARKER.length);
  return `${text.slice(0, keep)}${PK_TRUNCATION_MARKER}`;
}

function trustedBlocks(text) {
  const blocks = [];
  CTX_BLOCK_RE.lastIndex = 0;
  let match;
  while ((match = CTX_BLOCK_RE.exec(text)) !== null) {
    if (isTrustedBlock(match[0])) blocks.push(match[0]);
  }
  return blocks;
}

function isTrustedBlock(block) {
  PK_MARKER_RE.lastIndex = 0;
  return block.startsWith(CONTEXT_MARKER_START) &&
    block.endsWith(CONTEXT_MARKER_END) &&
    block.includes(PK_HEADER) &&
    PK_MARKER_RE.test(block);
}

function extractIdsFromTrustedBlock(block, ids) {
  PK_MARKER_RE.lastIndex = 0;
  let match;
  while ((match = PK_MARKER_RE.exec(block)) !== null) {
    for (const part of match[1].split(",")) {
      const n = parseInt(part.trim(), 10);
      if (!isNaN(n)) ids.add(n);
    }
  }
}

function buildBlock(entries) {
  const ids = entries.map((e) => e.id).join(",");
  const sections = entries.map((e) => `### ${e.title}\n${e.content}`).join("\n\n");
  const inner = `${PK_HEADER}\n<!-- mb:pk ${ids} -->\n${sections}`;
  return `${CONTEXT_MARKER_START}\n${inner}\n${CONTEXT_MARKER_END}`;
}

function capContext(entries) {
  let block = buildBlock(entries);
  if (block.length <= PK_CONTEXT_MAX_CHARS) return block;
  const ids = entries.map((e) => e.id).join(",");
  const prefix = `${CONTEXT_MARKER_START}\n${PK_HEADER}\n<!-- mb:pk ${ids} -->\n`;
  const suffix = `${PK_TRUNCATION_MARKER}\n${CONTEXT_MARKER_END}`;
  const maxBody = Math.max(0, PK_CONTEXT_MAX_CHARS - prefix.length - suffix.length);
  const body = entries.map((e) => `### ${e.title}\n${e.content}`).join("\n\n");
  block = `${prefix}${body.slice(0, maxBody)}${suffix}`;
  return block.slice(0, PK_CONTEXT_MAX_CHARS - CONTEXT_MARKER_END.length) + CONTEXT_MARKER_END;
}

/**
 * Scan an array of message texts for injected PK id markers and return the
 * union of all seen entry ids. Pass the result as `excludeIds` on the next
 * searchProcedural call to avoid re-injecting the same entries.
 *
 * @param {string[]} texts - Raw text strings from prior conversation turns.
 * @returns {number[]} Deduplicated list of injected entry ids.
 */
export function extractInjectedPkIds(texts) {
  const ids = new Set();
  for (const text of texts) {
    for (const block of trustedBlocks(String(text ?? ""))) extractIdsFromTrustedBlock(block, ids);
  }
  return Array.from(ids);
}

/**
 * Build the context block prepended to the user message before LLM delivery.
 * Returns empty string when entries is empty (caller should skip injection).
 *
 * @param {Array<{id: number, title: string, content: string}>} entries
 * @returns {string}
 */
export function formatPkContext(entries) {
  if (!entries || entries.length === 0) return "";
  const safeEntries = entries.map((e) => ({
    id: e.id,
    title: truncate(e.title, PK_ENTRY_TITLE_MAX_CHARS),
    content: truncate(e.content, PK_ENTRY_CONTENT_MAX_CHARS),
  }));
  return capContext(safeEntries);
}

/**
 * Strip any injected context block from text. Prevents accumulation when
 * the same message is processed more than once (e.g. OpenCode re-renders).
 *
 * @param {string} text
 * @returns {string}
 */
export function stripInjectedContext(text) {
  return String(text ?? "").replace(CTX_BLOCK_RE, (block) =>
    isTrustedBlock(block) ? "" : block
  ).trim();
}
