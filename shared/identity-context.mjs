/**
 * shared/identity-context.mjs
 *
 * Read-only persona and profile injection for session context.
 * Not an MCP tool. Hooks prepend this block; they do not write either field.
 */

export const IDENTITY_MARKER_START = "<!-- mb:identity-start -->";
export const IDENTITY_MARKER_END = "<!-- mb:identity-end -->";
export const IDENTITY_FIELD_MAX_CHARS = 3_000;
const TRUNCATION_MARKER = "\n[truncated]";
const PERSONA_HEADER = "## Agent persona";
const PROFILE_HEADER = "## User profile";
const HTML_COMMENT_START_RE = /<!--/g;
const HTML_COMMENT_END_RE = /-->/g;
const IDENTITY_BLOCK_RE = new RegExp(
  `${IDENTITY_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${IDENTITY_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  "g",
);

function escapeContextText(value) {
  return String(value ?? "")
    .replace(HTML_COMMENT_START_RE, "&lt;!--")
    .replace(HTML_COMMENT_END_RE, "--&gt;");
}

function capField(value) {
  const text = escapeContextText(String(value).trim());
  if (text.length <= IDENTITY_FIELD_MAX_CHARS) return text;
  const keep = Math.max(0, IDENTITY_FIELD_MAX_CHARS - TRUNCATION_MARKER.length);
  return `${text.slice(0, keep)}${TRUNCATION_MARKER}`;
}

function section(header, value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return `${header}\n${capField(value)}`;
}

/**
 * Build the identity block for one turn. Empty when both sides are blank.
 *
 * @param {{persona?: string|null, profile?: string|null}} fields
 * @returns {string}
 */
export function formatIdentityContext({ persona, profile } = {}) {
  const sections = [section(PERSONA_HEADER, persona), section(PROFILE_HEADER, profile)].filter(Boolean);
  if (sections.length === 0) return "";
  return `${IDENTITY_MARKER_START}\n${sections.join("\n\n")}\n${IDENTITY_MARKER_END}`;
}

function isInjectedIdentityBlock(block) {
  return block.startsWith(IDENTITY_MARKER_START) &&
    block.endsWith(IDENTITY_MARKER_END) &&
    (block.includes(PERSONA_HEADER) || block.includes(PROFILE_HEADER));
}

/**
 * Remove hook-injected identity blocks before storing assistant text.
 * A marker pair without the persona or profile heading is left alone.
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubIdentityContext(text) {
  return String(text ?? "").replace(IDENTITY_BLOCK_RE, (block) =>
    isInjectedIdentityBlock(block) ? "" : block
  ).trim();
}

async function readField(api, method) {
  try {
    if (typeof api?.[method] !== "function") return null;
    return await api[method]();
  } catch {
    return null;
  }
}

/**
 * Fetch persona and profile and format them. One failed read does not drop
 * the other. Never throws.
 *
 * @param {{getPersona?: Function, getProfile?: Function}} api
 * @returns {Promise<string>}
 */
export async function loadIdentityContext(api) {
  const [persona, profile] = await Promise.all([
    readField(api, "getPersona"),
    readField(api, "getProfile"),
  ]);
  return formatIdentityContext({ persona, profile });
}
