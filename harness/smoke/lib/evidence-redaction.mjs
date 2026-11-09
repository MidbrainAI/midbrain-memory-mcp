import os from 'node:os';

const secretKey = /(?:api[_-]?key|authorization|password|secret|(?:access|refresh|id|auth)[_-]?token|cookie|private[_-]?key)/i;

export function redactor(secrets, root) {
  function text(value) {
    for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
    return value
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
      .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|npm_[\w]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[REDACTED]')
      .replace(/\b(Bearer|Basic)\s+[\w.+/=-]+/gi, '$1 [REDACTED]')
      .replace(/((?:[\w-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)|authorization)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
      .split(root).join('<run>')
      .split(root.replace(/^\/private(?=\/var\/|\/tmp\/)/, '')).join('<run>')
      .split(os.homedir()).join('<host-home>')
      .replace(/\/(?:Users|home)\/[^/\s"']+/g, '/<home>');
  }
  function scrub(value) {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [text(k), secretKey.test(k) ? '[REDACTED]' : scrub(v)]));
    return value;
  }
  return scrub;
}
