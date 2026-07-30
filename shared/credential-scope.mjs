/**
 * Leaf helpers for credential-scope inspection shared by the client base and
 * the diagnostics report. This module has no intra-package imports so it can
 * be consumed by both `clients/base.mjs` and `diagnostics.mjs` without forming
 * an import cycle.
 */

import { createHash } from "crypto";

function keyDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Compare credential contents internally and return only a safe, secret-free
 * finding. Never returns a digest, key, or fragment.
 *
 * @param {string} scope
 * @param {string} winnerKey
 * @param {string} globalKey
 * @returns {string|null}
 */
export function credentialShadowNote(scope, winnerKey, globalKey) {
  if (!winnerKey || !globalKey || !["project", "client"].includes(scope)) return null;
  if (keyDigest(winnerKey) === keyDigest(globalKey)) return null;
  return `${scope} credential shadows the global credential for this client`;
}

/**
 * Classify a credential-read error into a fixed, path-free vocabulary so the
 * diagnostics report never echoes a raw filesystem error message (which may
 * embed a username-bearing absolute path). Returns a short label only.
 *
 * @param {unknown} error
 * @returns {'not-found'|'empty'|'permission-denied'|'unreadable'}
 */
export function classifyScopeError(error) {
  const code = error?.code || error?.cause?.code;
  const message = String(error?.message || "");
  if (code === "EACCES" || /^Permission denied reading key file:/i.test(message)) {
    return "permission-denied";
  }
  if (/^Key file is empty:/i.test(message)) return "empty";
  if (code === "ENOENT") return "not-found";
  return "unreadable";
}
