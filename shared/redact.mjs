/**
 * Secret redaction for text that MidBrain stores from a source the user did
 * not type into MidBrain directly, such as imported conversation history
 * (issue #75). Replaces well-known credential shapes with `[redacted]`.
 *
 * This is a safety net, not a guarantee: it only knows token formats with a
 * recognisable prefix or framing.
 */

export const REDACTED = "[redacted]";

// An unquoted assignment value that is code, not a credential:
// `process.env.TOKEN`, `makeToken()`, `${API_KEY}`, `<your-key>`, `apiKeyParam`.
const CODE_VALUE = /^(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[;,)]*|[A-Za-z_$][\w$.]*\(.*|\$\{?[A-Za-z_][\w.]*\}?[;,]*|<[^>\s]+>|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*[;,)]*)$/;

// Each pattern replaces the whole match, or keeps the named `keep` prefix
// (a variable name, a URL's scheme and user) and drops only the secret.
const SECRET_PATTERNS = [
  // Private key blocks (PEM / OpenSSH), whole block.
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  // OpenAI / Anthropic / MidBrain style keys (sk-..., sk-ant-..., sk-proj-...).
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g },
  // Stripe secret and restricted keys.
  { re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
  // Bearer and Basic credentials in pasted headers or curl commands. A
  // credential holds a digit or a base64 `+/=`, or is 20+ characters long;
  // "bearer authentication" is neither.
  { re: /\bBearer\s+(?=[A-Za-z._~-]*[0-9+/=]|[A-Za-z._~-]{20})[A-Za-z0-9._~+/=-]{8,}/gi },
  { re: /\bBasic\s+(?=[A-Za-z]*[0-9+/=])[A-Za-z0-9+/]{12,}={0,2}/g },
  // JSON Web Tokens.
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // GitHub tokens.
  { re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  // GitLab personal access tokens.
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  // Slack tokens.
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  // AWS access key ids.
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // Google API keys.
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // npm tokens.
  { re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // Passwords in URLs: scheme://user:PASSWORD@host (database URLs, DSNs).
  { re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s/@]{3,})(?=@)/gi, keep: 1 },
  // `password=...`, `api_key: ...`, `SECRET_TOKEN="..."` and JSON
  // `"password": "..."` assignments: keep the name, drop the value. The
  // keyword must be a whole name part, so `max_tokens=4096` or
  // `tokenizer: ...` are left alone, and an all-digit value (a count) is not
  // a secret. Quotes around the value are kept, so JSON stays JSON; an
  // unquoted value that is code (CODE_VALUE) is left alone.
  {
    re: /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|secret|password|passwd|token)(?:[_-][A-Za-z0-9]+)*["']?\s*[:=]\s*)(["']?)(?!\d+\2(?:[\s,;}\]]|$))([^\s"']{6,})\2/gi,
    keep: 1,
    quote: 2,
    value: 3,
  },
];

/**
 * @param {string} text
 * @returns {{text: string, count: number}} The redacted text and how many
 *   values were replaced.
 */
export function redactSecrets(text) {
  let count = 0;
  let result = String(text ?? "");
  for (const { re, keep, quote, value } of SECRET_PATTERNS) {
    result = result.replace(re, (...match) => {
      if (value && !match[quote] && CODE_VALUE.test(match[value])) return match[0];
      count += 1;
      if (!keep) return REDACTED;
      const q = quote ? match[quote] : "";
      return `${match[keep]}${q}${REDACTED}${q}`;
    });
  }
  return { text: result, count };
}
