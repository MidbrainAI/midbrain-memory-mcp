/**
 * shared/identity-context.mjs
 *
 * Read-only persona and profile context for a session (issue #61).
 * Not an MCP tool, and never written by MidBrain clients.
 *
 * Each client adds this text ONCE per session at its session-level surface
 * (Claude Code / Codex SessionStart, OpenCode system prompt, OpenClaw system
 * context, Hermes first turn, Cursor MCP server instructions), never on every
 * turn: the text stays stable for the session, so it costs its tokens once
 * and never disturbs the client's prompt cache.
 *
 * Persona and profile length is owned by the API: the text is passed through
 * as returned, with no client-side limit.
 */

const INTRO = "MidBrain persona and user profile for this session (read-only):";
const PERSONA_HEADER = "## Agent persona";
const PROFILE_HEADER = "## User profile";

function section(header, value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return `${header}\n${value.trim()}`;
}

/**
 * Build the session identity text. Empty when both fields are blank.
 *
 * @param {{persona?: string|null, profile?: string|null}} fields
 * @returns {string}
 */
export function formatIdentityContext({ persona, profile } = {}) {
  const sections = [section(PERSONA_HEADER, persona), section(PROFILE_HEADER, profile)].filter(Boolean);
  if (sections.length === 0) return "";
  return `${INTRO}\n\n${sections.join("\n\n")}`;
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
