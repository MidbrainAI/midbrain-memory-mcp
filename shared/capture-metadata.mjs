/**
 * Builds the episodic `memory_metadata` object shared by every capture path.
 *
 * The originating `client` is always present. Optional scoping fields are
 * added only when the harness provides them:
 *   - `cwd`        home-relative working directory (see homeRelativePath)
 *   - `session_id` the harness's own session/conversation id, verbatim
 *
 * Values are strings; absent inputs are omitted (never sent as empty/null).
 */

import { homeRelativePath } from "./diagnostics.mjs";

const ROOTED_PATH = /^(?:[a-z]:[\\/]|[\\/])/i;
const USER_HOME_SEGMENT = /^(?:users|home)$/i;

function captureCwd(value) {
  const normalized = homeRelativePath(value);
  if (normalized === "~" || normalized.startsWith("~/")) return normalized;
  if (!ROOTED_PATH.test(value)) return normalized;

  const segments = value.split(/[\\/]+/).filter(Boolean);
  const start = /^[a-z]:$/i.test(segments[0]) ? 1 : 0;
  const homeIndex = segments.findIndex((segment, index) => (
    index >= start
    && index < segments.length - 1
    && USER_HOME_SEGMENT.test(segment)
  ));
  if (homeIndex < 0) return normalized;

  const tail = segments.slice(homeIndex + 2).join("/");
  return tail ? `<redacted>/${tail}` : "<redacted>";
}

/**
 * @param {object} params
 * @param {string} params.client - Originating client label (always sent).
 * @param {string} [params.cwd] - Working directory from the harness payload.
 * @param {string} [params.sessionId] - Harness session/conversation id.
 * @returns {Record<string, string>}
 */
export function buildCaptureMetadata({ client, cwd, sessionId } = {}) {
  const metadata = { client };
  if (typeof cwd === "string" && cwd.trim()) {
    metadata.cwd = captureCwd(cwd.trim());
  }
  if (typeof sessionId === "string" && sessionId.trim()) {
    metadata.session_id = sessionId;
  }
  return metadata;
}
