/**
 * shared/clients/shim.mjs — stable hook-shim machinery (PRD-034 S2/S3).
 *
 * One place for every client's ~/.midbrain/bin/<client>-hook shim: body
 * templates, shell quoting, Windows path guarding, dev-marker detection, and
 * the install/repair write path. Replaces the duplicated writers that lived
 * in codex.mjs and hermes.mjs.
 *
 * Canonical bodies are byte-identical to the shims shipped at e0abf99
 * (pinned by tests/shim.test.mjs) so existing installs see no rewrite.
 *
 * Dev-ness lives in the shim BODY, not in client config: hook entries always
 * point at the stable shim path, and a `# midbrain-dev` / `@rem midbrain-dev`
 * marker line identifies a checkout-pointing body. Repair preserves dev
 * bodies; explicit install always rewrites per its flags.
 */

import fs from 'fs/promises';
import path from 'path';
import { REPO_ROOT, home, writeFileIfChanged } from './utils.mjs';

export const DEV_MARKER_POSIX = '# midbrain-dev';
export const DEV_MARKER_WIN = '@rem midbrain-dev';
const WINDOWS_UNSUPPORTED_RE = /[&^()%!]/;

/** POSIX single-quote escaping for generated sh commands. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Reject paths containing cmd.exe metacharacters when generating .cmd shims.
 * @param {string} filePath - Path to embed in a generated script.
 * @param {string} label - Human-readable name for the error message.
 * @param {string} [platform] - Injectable for tests (default process.platform).
 */
export function windowsPathGuard(filePath, label, platform = process.platform) {
  if (platform === 'win32' && WINDOWS_UNSUPPORTED_RE.test(filePath)) {
    throw new Error(`${label} contains unsupported Windows command characters: ${filePath}`);
  }
}

/**
 * Filename for a client's stable shim. Codex ships a sh script on every
 * platform (unchanged from PRD-017); hermes/claude use .cmd on Windows.
 */
export function shimFilename(client, platform = process.platform) {
  if (platform === 'win32' && client !== 'codex') return `${client}-hook.cmd`;
  return `${client}-hook`;
}

/** Absolute path of the client's stable shim under the current home. */
export function stableShimPath(client, platform = process.platform) {
  return path.join(home(), '.midbrain', 'bin', shimFilename(client, platform));
}

/**
 * Build a shim body.
 *
 * @param {string} client - 'claude' | 'codex' | 'hermes'.
 * @param {object} [opts]
 * @param {boolean} [opts.isDev] - Point at the local checkout instead of npx.
 * @param {string} [opts.platform] - Injectable platform (default process.platform).
 * @param {string} [opts.execPath] - Node binary for dev bodies.
 * @param {string} [opts.repoRoot] - Checkout root for dev bodies.
 * @returns {string}
 */
export function buildShimBody(client, opts = {}) {
  const {
    isDev = false,
    platform = process.platform,
    execPath = process.execPath,
    repoRoot = REPO_ROOT,
  } = opts;
  // Join with the TARGET platform's separator so injected win32 fixtures
  // build win32 bodies even when the test host is POSIX.
  const indexPath = (platform === 'win32' ? path.win32 : path.posix).join(repoRoot, 'index.js');

  if (platform === 'win32' && client !== 'codex') {
    const marker = isDev ? `${DEV_MARKER_WIN}\r\n` : '';
    const command = isDev
      ? `"${execPath}" "${indexPath}" hook ${client} "%~1"`
      : `call npx.cmd -y midbrain-memory-mcp@latest hook ${client} "%~1"`;
    return `@echo off\r\n${marker}${command}\r\nexit /b 0\r\n`;
  }

  const marker = isDev ? `${DEV_MARKER_POSIX}\n` : '';
  const command = isDev
    ? `${shellQuote(execPath)} ${shellQuote(indexPath)}`
    : 'npx -y midbrain-memory-mcp@latest';

  if (client === 'codex') {
    // Byte-parity with the PRD-017 codex shim: Codex's protocol requires {}
    // on stdout when an assistant/tool hook fails.
    return `#!/bin/sh
${marker}set +e
${command} hook codex "$@"
status=$?
case "$1" in
  assistant|tool)
    if [ "$status" -ne 0 ]; then
      printf '{}'
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
  }

  return `#!/bin/sh
${marker}set +e
${command} hook ${client} "$@"
exit 0
`;
}

/** True when shim content carries the dev marker in its opening lines. */
export function isDevShimContent(content) {
  if (typeof content !== 'string') return false;
  return content
    .split(/\r?\n/, 3)
    .some((line) => line === DEV_MARKER_POSIX || line === DEV_MARKER_WIN);
}

/** chmod 0755 (POSIX only, best-effort). mtime-safe: chmod touches ctime only. */
async function restoreExecBit(shimPath) {
  if (process.platform !== 'win32') {
    await fs.chmod(shimPath, 0o755).catch(() => {});
  }
}

/**
 * Inspect an installed shim without writing (AC-11, B14/B15).
 *
 * Fresh requires BOTH: content is the exact canonical body (or any dev-marked
 * body — dev bytes are the developer's, never judged stale) AND the file is
 * executable (POSIX; mode is not meaningful on win32). Missing or unreadable
 * shims are stale. Existence alone is never freshness.
 *
 * @param {string} client
 * @returns {Promise<{fresh: boolean, isDev: boolean}>}
 */
export async function shimStatus(client) {
  const shimPath = stableShimPath(client);
  let content;
  try {
    content = await fs.readFile(shimPath, 'utf8');
  } catch {
    return { fresh: false, isDev: false };
  }
  const isDev = isDevShimContent(content);
  if (!isDev && content !== buildShimBody(client, { isDev: false })) {
    return { fresh: false, isDev };
  }
  if (process.platform !== 'win32') {
    try {
      const { mode } = await fs.stat(shimPath);
      if ((mode & 0o111) === 0) return { fresh: false, isDev };
    } catch {
      return { fresh: false, isDev };
    }
  }
  return { fresh: true, isDev };
}

/** Validate every path a shim body would embed (throws on win32 metachars). */
export function validateShimPaths(client, { isDev = false, platform = process.platform } = {}) {
  windowsPathGuard(stableShimPath(client, platform), `${client} hook shim path`, platform);
  if (!isDev) return;
  windowsPathGuard(process.execPath, `${client} development Node path`, platform);
  windowsPathGuard(path.join(REPO_ROOT, 'index.js'), `${client} development index path`, platform);
}

/**
 * Write (or preserve) a client's stable shim.
 *
 * mode 'repair' (automatic self-repair): an existing dev-marked body is left
 * untouched — repair never reverts a developer's explicit checkout wiring.
 * mode 'install' (explicit user action): always writes the body implied by
 * isDev; content-compared, so an identical body is a no-write (AC-5).
 *
 * @param {string} client
 * @param {object} [opts]
 * @param {boolean} [opts.isDev]
 * @param {'install'|'repair'} [opts.mode]
 * @returns {Promise<{written: boolean, preservedDev?: boolean, path: string}>}
 */
export async function installShim(client, { isDev = false, mode = 'install' } = {}) {
  validateShimPaths(client, { isDev });
  const shimPath = stableShimPath(client);

  if (mode === 'repair') {
    try {
      const current = await fs.readFile(shimPath, 'utf8');
      if (isDevShimContent(current)) {
        // Dev bytes are preserved, but the shim must still be runnable.
        await restoreExecBit(shimPath);
        return { written: false, preservedDev: true, path: shimPath };
      }
    } catch { /* missing or unreadable -> write canonical below */ }
  }

  const body = buildShimBody(client, { isDev });
  const written = await writeFileIfChanged(shimPath, body);
  // chmod even when content was unchanged: restores a stripped exec bit
  // without touching mtime (chmod updates ctime only), so the no-churn
  // guarantee holds while the shim stays executable.
  await restoreExecBit(shimPath);
  return { written, path: shimPath };
}
