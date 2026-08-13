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
    metadata.cwd = homeRelativePath(cwd.trim());
  }
  if (typeof sessionId === "string" && sessionId.trim()) {
    metadata.session_id = sessionId.trim();
  }
  return metadata;
}
