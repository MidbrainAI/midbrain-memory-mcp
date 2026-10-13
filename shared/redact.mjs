/**
 * Secret redaction for text that MidBrain stores from a source the user did
 * not type into MidBrain directly, such as imported conversation history
 * (issue #75). Replaces well-known credential shapes with `[redacted]`.
 *
 * This is a safety net, not a guarantee: it only knows token formats with a
 * recognisable prefix or framing.
 */

export const REDACTED = "[redacted]";

const SECRET_PATTERNS = [
  // Private key blocks (PEM / OpenSSH), whole block.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // OpenAI / Anthropic / MidBrain style keys (sk-..., sk-ant-..., sk-proj-...).
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // Bearer tokens in pasted headers or curl commands.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // GitHub tokens.
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  // Slack tokens.
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // Google API keys.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // npm tokens.
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  // `password=...`, `api_key: ...`, `SECRET_TOKEN="..."` style assignments:
  // keep the name, drop the value.
  /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|password|passwd|token)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)[^\s"']{6,}\3/gi,
];

/**
 * @param {string} text
 * @returns {{text: string, count: number}} The redacted text and how many
 *   values were replaced.
 */
export function redactSecrets(text) {
  let count = 0;
  let result = String(text ?? "");
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (...match) => {
      count += 1;
      // The assignment pattern keeps the variable name and separator.
      if (match.length > 5 && typeof match[1] === "string" && typeof match[2] === "string") {
        return `${match[1]}${match[2]}${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return { text: result, count };
}
