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

const PK_MARKER_RE  = /<!-- mb:pk ([^-]+) -->/g;
const CTX_BLOCK_RE  = new RegExp(
  CONTEXT_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
  "[\\s\\S]*?" +
  CONTEXT_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  "g"
);

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
    PK_MARKER_RE.lastIndex = 0;
    let match;
    while ((match = PK_MARKER_RE.exec(text)) !== null) {
      for (const part of match[1].split(",")) {
        const n = parseInt(part.trim(), 10);
        if (!isNaN(n)) ids.add(n);
      }
    }
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
  const ids = entries.map((e) => e.id).join(",");
  const sections = entries.map((e) => `### ${e.title}\n${e.content}`).join("\n\n");
  const inner = `## Procedural knowledge:\n<!-- mb:pk ${ids} -->\n${sections}`;
  return `${CONTEXT_MARKER_START}\n${inner}\n${CONTEXT_MARKER_END}`;
}

/**
 * Strip any injected context block from text. Prevents accumulation when
 * the same message is processed more than once (e.g. OpenCode re-renders).
 *
 * @param {string} text
 * @returns {string}
 */
export function stripInjectedContext(text) {
  return text.replace(CTX_BLOCK_RE, "").trim();
}
