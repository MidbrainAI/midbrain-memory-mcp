/**
 * shared/clients/shim.mjs — stable hook-shim machinery (PRD-034 S2/S3).
 *
 * One place for every client's ~/.midbrain/bin/<client>-hook shim: body
 * templates, shell quoting, Windows path guarding, dev-marker detection, and
 * the install/repair write path. Replaces the duplicated writers that lived
 * in codex.mjs and hermes.mjs.
 *
 * POSIX bodies retain their existing format; Windows uses Node launchers.
 *
 * Dev-ness lives in the shim BODY, not in client config: hook entries always
 * point at the stable shim path, and a `# midbrain-dev` / `// midbrain-dev`
 * marker line identifies a checkout-pointing body. Repair preserves dev
 * bodies; explicit install always rewrites per its flags.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PKG_NAME, REPO_ROOT, writeFileIfChanged } from './utils.mjs';
import { shimBinDir, stateBaseDir } from '../state-dir.mjs';

export const DEV_MARKER_POSIX = '# midbrain-dev';
export const DEV_MARKER_WIN = '// midbrain-dev';
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
 * Filename for a client's stable shim: .cjs on Windows, sh elsewhere.
 */
export function shimFilename(client, platform = process.platform) {
  if (platform === 'win32') return `${client}-hook.cjs`;
  return `${client}-hook`;
}

/**
 * Absolute path of the client's stable shim. Default: ~/.midbrain/bin/…;
 * relocated under MIDBRAIN_STATE_DIR/bin when set. The relocated base keeps the
 * `.midbrain/bin/<client>-hook` tail, so commandReferencesShim() ownership
 * matching and self-repair rewrite need no change.
 */
export function stableShimPath(client, platform = process.platform) {
  return path.join(shimBinDir(), shimFilename(client, platform));
}

/** Build a hook invocation for the host shell without POSIX quoting on Windows. */
export function shimCommand(client, role, platform = process.platform) {
  const target = stableShimPath(client, platform);
  if (platform === 'win32') {
    return `node "${target.replace(/\\/g, "/")}" ${role}`;
  }
  return `${shellQuote(target)} ${role}`;
}

/** Historical pre-relocation path retained for the first cached hook command. */
export function historicalShimPath(client, platform = process.platform) {
  return path.join(os.homedir(), '.midbrain', 'bin', shimFilename(client, platform));
}

function statefulDevBody(content, stateDir, platform) {
  if (!stateDir || typeof content !== 'string') return content;
  if (platform === 'win32') {
    const line = `process.env.MIDBRAIN_STATE_DIR = ${JSON.stringify(stateDir)};\n`;
    const marker = `${DEV_MARKER_WIN}\n`;
    if (!content.includes(marker)) return content;
    const start = content.indexOf(marker) + marker.length;
    const remainder = content.slice(start).replace(/^process\.env\.MIDBRAIN_STATE_DIR = .*;\r?\n/, '');
    return `${content.slice(0, start)}${line}${remainder}`;
  }
  const lines = `MIDBRAIN_STATE_DIR=${shellQuote(stateDir)}\nexport MIDBRAIN_STATE_DIR\n`;
  const marker = `${DEV_MARKER_POSIX}\n`;
  if (!content.includes(marker)) return content;
  const start = content.indexOf(marker) + marker.length;
  const remainder = content.slice(start).replace(/^MIDBRAIN_STATE_DIR=.*\nexport MIDBRAIN_STATE_DIR\n/, '');
  return `${content.slice(0, start)}${lines}${remainder}`;
}

/**
 * Build a shim body.
 *
 * @param {string} client - Registered capture client id.
 * @param {object} [opts]
 * @param {boolean} [opts.isDev] - Point at the local checkout instead of npx.
 * @param {string} [opts.platform] - Injectable platform (default process.platform).
 * @param {string} [opts.execPath] - Node binary for dev bodies.
 * @param {string} [opts.repoRoot] - Checkout root for dev bodies.
 * @param {string|null} [opts.stateDir] - Nonsecret state root to propagate.
 * @returns {string}
 */
export function buildShimBody(client, opts = {}) {
  const {
    isDev = false,
    platform = process.platform,
    execPath = process.execPath,
    repoRoot = REPO_ROOT,
    stateDir = (client === 'claude' || client === 'codex') ? stateBaseDir() : null,
  } = opts;
  // Join with the TARGET platform's separator so injected win32 fixtures
  // build win32 bodies even when the test host is POSIX.
  const indexPath = (platform === 'win32' ? path.win32 : path.posix).join(repoRoot, 'index.js');

  if (platform === 'win32') {
    const marker = isDev ? `${DEV_MARKER_WIN}\n` : '';
    const stateLine = stateDir ? `process.env.MIDBRAIN_STATE_DIR = ${JSON.stringify(stateDir)};\n` : '';
    const executable = isDev ? JSON.stringify(execPath) : 'process.env.ComSpec || "cmd.exe"';
    const args = isDev
      ? `[${JSON.stringify(indexPath)}, "hook", ${JSON.stringify(client)}, role]`
      : `["/d", "/s", "/c", "npx.cmd -y midbrain-memory-mcp@latest hook ${client} " + role]`;
    return `// MidBrain Windows hook launcher\n${marker}${stateLine}const { spawnSync } = require("node:child_process");
const role = process.argv[2];
if (!["user", "assistant", "tool", "session", "session-end", "watch", "sync"].includes(role)) process.exit(0);
const child = spawnSync(${executable}, ${args}, {
  stdio: "inherit", windowsHide: true, windowsVerbatimArguments: ${!isDev},
});
if (child.error) console.error("MidBrain hook failed to start:", child.error.message);
if (${JSON.stringify(client)} === "codex" && (child.error || child.status !== 0) && ["assistant", "tool"].includes(role)) process.stdout.write("{}");
process.exit(0);
`;
  }
  const marker = isDev ? `${DEV_MARKER_POSIX}\n` : '';
  const command = isDev
    ? `${shellQuote(execPath)} ${shellQuote(indexPath)}`
    : 'npx -y midbrain-memory-mcp@latest';

  if (client === 'codex') {
    // Byte-parity with the PRD-017 codex shim: Codex's protocol requires {}
    // on stdout when an assistant/tool hook fails.
    return `#!/bin/sh
${marker}${stateDir ? `MIDBRAIN_STATE_DIR=${shellQuote(stateDir)}\nexport MIDBRAIN_STATE_DIR\n` : ''}set +e
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

  const stateLines = client === 'claude' && stateDir
    ? `MIDBRAIN_STATE_DIR=${shellQuote(stateDir)}\nexport MIDBRAIN_STATE_DIR\n`
    : '';
  return `#!/bin/sh
${marker}${stateLines}set +e
${command} hook ${client} "$@"
exit 0
`;
}

/** True when shim content carries the dev marker in its opening lines. */
export function isDevShimContent(content) {
  if (typeof content !== 'string') return false;
  return content
    .split(/\r?\n/, 3)
    .some((line) => line === DEV_MARKER_POSIX || line === DEV_MARKER_WIN || line === '@rem midbrain-dev');
}

// ---------------------------------------------------------------------------
// Hook ownership (AC-12, PRD-034 rev4 simplification)
//
// Repair may only claim hook commands that are positively OURS. The previous
// implementation hand-rolled a POSIX shell tokenizer to match path *words*;
// this replaces it with boundary-anchored substring matching on the
// slash-normalized command. Three signals, each a real regex with word/segment
// boundaries so near-names never match:
//
//   1. references the client's own stable shim under ~/.midbrain/bin
//   2. is a legacy pre-shim capture script under plugins/<dir>/
//   3. is a midbrain package invocation (npx or a checkout index.js) that
//      dispatches `hook <client>`
//
// Everything keys on `.midbrain/bin/<client>-hook` (our private dir, ours by
// construction) or `midbrain-memory-mcp` as a package boundary — a user's
// `claude-hook-wrapper`, `myplugins/...`, or `midbrain-memory-mcp-wrapper`
// never matches. Signals 2 and 3 are transitional (pre-0.4.7 installs) and
// can be removed once those installs age out.
// ---------------------------------------------------------------------------

/** Slash-normalize (win32 backslashes -> forward slashes) for matching. */
function normalizeCommand(command) {
  return String(command).replace(/\\/g, '/');
}

/** Escape a string for safe embedding in a RegExp. */
function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when a hook command references the client's stable shim
 * (~/.midbrain/bin/<client>-hook[.cmd|.cjs]). The basename is anchored so
 * `<client>-hook-wrapper` (a user hook) never matches. Absolute, `~`, and
 * `$HOME` forms all normalize to a `.midbrain/bin/<client>-hook` substring,
 * so the private-dir path alone is a sufficient, safe ownership signal.
 */
export function commandReferencesShim(command, client) {
  if (typeof command !== 'string') return false;
  const normalized = normalizeCommand(command);
  // `.midbrain/bin/<client>-hook` optionally followed by `.cmd` or `.cjs`, then a path
  // boundary (end, whitespace, or closing quote) — never a trailing `-wrapper`.
  const re = new RegExp(`\\.midbrain/bin/${escapeRe(client)}-hook(?:\\.(?:cmd|cjs))?(?=$|['"\\s])`);
  return re.test(normalized);
}

/**
 * True when `command` is a legacy pre-shim capture script for this client:
 * a `plugins/<dir>/<script>` path (checkout or npx-cache location), or a
 * midbrain package invocation paired with a bare `<script>` filename. The
 * leading `/` (or start) before `plugins/` prevents `myplugins/...` from
 * matching (no substring prefixes).
 *
 * @param {string} command
 * @param {string} legacyDir - e.g. 'claude-code', 'codex', 'hermes'.
 * @param {string[]} scripts - legacy capture script filenames.
 */
export function commandHasLegacyScriptPath(command, legacyDir, scripts) {
  if (typeof command !== 'string') return false;
  const normalized = normalizeCommand(command);
  return scripts.some((script) => {
    const pathRe = new RegExp(`(?:^|/)plugins/${escapeRe(legacyDir)}/${escapeRe(script)}(?=$|['"\\s])`);
    if (pathRe.test(normalized)) return true;
    // Package ref + bare script filename as a standalone word (left boundary:
    // start, whitespace, quote, or path separator; right boundary: word end).
    const bareRe = new RegExp(`(?:^|[\\s'"/])${escapeRe(script)}(?=$|['"\\s])`);
    return commandHasMidbrainPackageRef(command) && bareRe.test(normalized);
  });
}

/**
 * True when `command` positively references this package as a boundary-anchored
 * token: `midbrain-memory-mcp` as a whole word, a versioned
 * `midbrain-memory-mcp@...` (npx forms), or `midbrain-memory-mcp` as an exact
 * path segment (checkout, node_modules, npx-cache). Never a substring —
 * `midbrain-memory-mcp-wrapper` is somebody else's binary.
 */
export function commandHasMidbrainPackageRef(command) {
  if (typeof command !== 'string') return false;
  const normalized = normalizeCommand(command);
  // Left boundary: start, whitespace, quote, or path separator.
  // Right boundary: `@` (versioned), `/` (path segment), or a word boundary
  // (end/space/quote) — but NOT `-` (rejects `...-mcp-wrapper`).
  const re = new RegExp(`(?:^|[\\s'"/])${escapeRe(PKG_NAME)}(?:@|/|(?=$|['"\\s]))`);
  return re.test(normalized);
}

/**
 * True when `command` is a midbrain package invocation dispatching
 * `hook <client>` (npx form or a checkout index.js form). Complements the
 * shim + legacy signals for the pre-shim invocation shapes.
 */
export function commandHasMidbrainInvocation(command, client) {
  if (typeof command !== 'string') return false;
  if (!commandHasMidbrainPackageRef(command)) return false;
  const normalized = normalizeCommand(command).replace(/['"]/g, ' ').replace(/\s+/g, ' ');
  return new RegExp(`\\bhook\\s+${escapeRe(client)}\\b`).test(normalized);
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
export function validateShimPaths(client, {
  isDev = false,
  platform = process.platform,
  targetPath = stableShimPath(client, platform),
  stateDir = (client === 'claude' || client === 'codex') ? stateBaseDir() : null,
} = {}) {
  windowsPathGuard(targetPath, `${client} hook shim path`, platform);
  if ((client === 'claude' || client === 'codex') && stateDir) windowsPathGuard(stateDir, 'MIDBRAIN_STATE_DIR', platform);
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
export async function installShim(client, {
  isDev = false,
  mode = 'install',
  targetPath = stableShimPath(client),
  stateDir = (client === 'claude' || client === 'codex') ? stateBaseDir() : null,
} = {}) {
  validateShimPaths(client, { isDev, targetPath, stateDir });
  const shimPath = targetPath;

  if (mode === 'repair' && process.platform === 'win32') {
    const current = await fs.readFile(shimPath, 'utf8').catch(() => null);
    const legacyPath = shimPath.replace(/\.cjs$/, client === 'codex' ? '' : '.cmd');
    const legacy = current === null ? await fs.readFile(legacyPath, 'utf8').catch(() => null) : null;
    if (isDevShimContent(legacy)) {
      throw new Error('Legacy Windows development hook found; run npx midbrain-memory-mcp@latest install --dev to migrate it.');
    }
  }

  if (mode === 'repair') {
    try {
      const current = await fs.readFile(shimPath, 'utf8');
      if (isDevShimContent(current)) {
        const updated = (client === 'claude' || client === 'codex')
          ? statefulDevBody(current, stateDir, process.platform) : current;
        const written = updated !== current ? await writeFileIfChanged(shimPath, updated) : false;
        // Dev command/marker bytes are preserved, but the shim must still run.
        await restoreExecBit(shimPath);
        return { written, preservedDev: true, path: shimPath };
      }
    } catch { /* missing or unreadable -> write canonical below */ }
  }

  const body = buildShimBody(client, { isDev, stateDir });
  const written = await writeFileIfChanged(shimPath, body);
  // chmod even when content was unchanged: restores a stripped exec bit
  // without touching mtime (chmod updates ctime only), so the no-churn
  // guarantee holds while the shim stays executable.
  await restoreExecBit(shimPath);
  return { written, path: shimPath };
}
