#!/usr/bin/env node
/**
 * install.mjs — MidBrain Memory MCP automated installer
 *
 * Interactive: node install.mjs
 * Project:     node install.mjs --project /absolute/path/to/project
 *
 * Detects installed AI clients via the client registry, resolves API keys,
 * writes global key file, and delegates config setup to client adapters.
 * Idempotent.
 *
 * --project mode is non-interactive: copies global key into the project,
 * writes project-level MCP configs, outputs JSON to stdout.
 *
 * Architecture: All client-specific logic lives in shared/clients/*.mjs.
 * This file only orchestrates detection, key resolution, and delegation.
 * Adding a new client requires zero changes here.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { readKeyFile } from './shared/clients/base.mjs';
import {
  writeCredential,
  CredentialReplaceNotApprovedError,
  CredentialReadError,
} from './shared/clients/credential-writer.mjs';
import { detectClients, allClients, getClient } from './shared/clients/registry.mjs';
import { globalConfigDir } from './shared/state-dir.mjs';
import { MidbrainApi } from './shared/midbrain-api.mjs';
import { runFlush } from './shared/flush-runner.mjs';
import {
  beginSpoolFlush,
  finishSpoolFlush,
  hasSpooledEntries,
  readCooldownUntil,
  writeCooldownUntil,
  clearCooldown,
} from './shared/claude-spool.mjs';
import {
  listCacheBindings,
  beginCacheFlush,
  finishCacheFlush,
  readCacheCooldownUntil,
  writeCacheCooldownUntil,
  clearCacheCooldown,
  hasAnyCachedEntries,
} from './shared/episodic-cache.mjs';
import { writeGlobalRules, writeProjectRules } from './shared/agent-rules.mjs';
import { deviceCodeLogin } from './shared/device-auth.mjs';
import { readGlobalKeystore, writeGlobalKeystore, globalKeystorePath } from './shared/keystore.mjs';
import { KEY_FILENAME, PKG_NAME, REPO_ROOT } from './shared/clients/utils.mjs';
import { classifyInstallContext, shouldSkipSelfRepair } from './shared/install-context.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Package version ---

const _require = createRequire(import.meta.url);
let PKG_VERSION = 'unknown';
try {
  const pkg = _require('./package.json');
  if (pkg && typeof pkg.version === 'string' && pkg.version) PKG_VERSION = pkg.version;
} catch { /* swallow */ }

export { PKG_VERSION };

// --- Update check + hook freshness ---

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/midbrain-memory-mcp/latest';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CACHE_FILENAME = '.midbrain-update-check.json';
const UPDATE_FETCH_TIMEOUT_MS = 5000;
const NPX_DIR_NAME = '_npx';
const SELF_PKG_SUBPATH = path.join('node_modules', PKG_NAME, 'package.json');
const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;
const GLOBAL_KEY_SOURCE_WARNING =
  'global credential already exists; --key-source ignored — remove it explicitly first if you intend replacement';
const NO_KEY_MESSAGE =
  'No API key found. Run the installer interactively first or set MIDBRAIN_API_KEY.';
const GLOBAL_CANDIDATE_SCOPES = new Set(['client', 'environment', 'entered']);

function isStableVersion(version) {
  return typeof version === 'string' && STABLE_VERSION_RE.test(version);
}

export function isNewerVersion(current, latest) {
  if (!isStableVersion(current) || !isStableVersion(latest)) return false;
  const c = current.split('.').map((s) => parseInt(s, 10));
  const l = latest.split('.').map((s) => parseInt(s, 10));
  for (let i = 0; i < 3; i++) {
    if ((l[i] || 0) > (c[i] || 0)) return true;
    if ((l[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

/**
 * Given a directory (typically this module's __dirname), find the
 * `_npx/<hash>` cache directory that resolved the running process.
 *
 * npx installs each `<pkg>@<spec>` invocation under a stable hash dir inside
 * `<npm-cache>/_npx/`. We walk up from `dirname` until the *parent* segment is
 * `_npx`; that child is the hash dir. Works with POSIX and drive-letter Windows
 * paths. UNC prefixes are not preserved and normally fail closed at the package
 * metadata check. Returns null when not running from an npx cache.
 *
 * @param {string} dirname - Absolute path inside a package install.
 * @returns {string|null} Absolute path to the `_npx/<hash>` dir, or null.
 */
export function selfNpxCacheDir(dirname) {
  if (typeof dirname !== 'string' || !dirname) return null;
  const segments = dirname.split(/[\\/]+/);
  const idx = segments.lastIndexOf(NPX_DIR_NAME);
  // Need a hash segment after `_npx`.
  if (idx === -1 || idx + 1 >= segments.length) return null;
  // Preserve the separator style of the input path so a POSIX path stays POSIX
  // even when this runs on Windows (and vice versa).
  const sep = dirname.includes('\\') && !dirname.includes('/') ? '\\' : '/';
  const hashDir = segments.slice(0, idx + 2).join(sep);
  // Preserve a leading separator that split() dropped on absolute POSIX paths.
  if (/^[\\/]/.test(dirname) && !/^[\\/]/.test(hashDir)) return `${dirname[0]}${hashDir}`;
  return hashDir;
}

/**
 * Self-heal the npx cache when the running version is stale.
 *
 * npx `<pkg>@latest` caches per spec-string and reuses the cached install as
 * long as it satisfies the recorded semver range, so it never re-resolves the
 * registry on a warm cache. Removing this process's own `_npx/<hash>` dir forces
 * the next cold start to re-resolve `@latest` and pick up the newer version.
 *
 * Parses the hash dir's package metadata and requires our exact package name
 * before removing it. Best-effort: never throws.
 *
 * @param {string} dirname - This module's __dirname.
 * @param {string} latest - Latest version from the registry.
 * @returns {Promise<boolean>} True when a stale cache dir was removed.
 */
export async function clearStaleSelfNpxCache(dirname, latest) {
  try {
    const hashDir = selfNpxCacheDir(dirname);
    if (!hashDir) return false;
    // Self-verification: only remove a dir with our package metadata.
    try {
      const packageJson = JSON.parse(
        await fs.readFile(path.join(hashDir, SELF_PKG_SUBPATH), 'utf8'),
      );
      if (packageJson?.name !== PKG_NAME) return false;
    } catch { return false; }
    await fs.rm(hashDir, { recursive: true, force: true });
    console.error(
      `[midbrain] Cleared stale npx cache (${PKG_VERSION} -> ${latest}); next start will use v${latest}.`,
    );
    return true;
  } catch { return false; }
}

async function isUpdateCacheFresh(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    const cache = JSON.parse(raw);
    return (Date.now() - cache.lastCheck) < UPDATE_CHECK_INTERVAL_MS;
  } catch { return false; }
}

/**
 * Fetch the latest published version from npm, honoring a 24h throttle cache.
 * Every completed attempt tries to record lastCheck, including failures, so an
 * unavailable registry cannot delay every hook when cache state is writable.
 * Returns the latest version string, or null when throttled/unavailable. Never
 * throws.
 *
 * @returns {Promise<string|null>}
 */
async function fetchLatestVersion() {
  const cachePath = path.join(os.tmpdir(), UPDATE_CACHE_FILENAME);
  if (await isUpdateCacheFresh(cachePath)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS);
  let latestVersion = null;
  try {
    const response = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
    if (!response.ok) return null;
    const { version } = await response.json();
    if (!isStableVersion(version)) return null;
    latestVersion = version;
    return latestVersion;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    const cache = { lastCheck: Date.now() };
    if (latestVersion) cache.latestVersion = latestVersion;
    await fs.writeFile(
      cachePath,
      JSON.stringify(cache),
      'utf8',
    ).catch(() => {});
  }
}

/**
 * Detect and repair stale hooks/plugins for all installed clients.
 * Best-effort: never throws, logs repairs to stderr.
 */
async function ensureHooksFresh() {
  const { detectClients } = await import('./shared/clients/registry.mjs');
  const clients = detectClients();
  for (const client of clients) {
    try {
      if (typeof client.isFresh !== 'function') continue;
      if (await client.isFresh()) continue;

      // Client has stale hooks/plugins — repair
      let lines = [];
      if (typeof client.repairHooks === 'function') {
        lines = await client.repairHooks();
      } else if (typeof client.repairPlugins === 'function') {
        lines = await client.repairPlugins();
      } else if (typeof client.repairSkill === 'function') {
        lines = await client.repairSkill();
      }
      for (const line of lines) console.error(`[midbrain]${line}`);
    } catch { /* never crash — skip this client */ }
  }
}

/**
 * Persist the MCP server's env credential for hook child processes (PRD-039).
 *
 * NanoClaw containers pass MIDBRAIN_API_KEY only to the MCP server process:
 * hook children get no env, and after the 0.4.7 shim migration dropped the
 * inline hook key they had no key source at all (issue #46). Writing the env
 * key to the global key file — the lowest-precedence file in the resolution
 * chain — lets hooks resolve it without shadowing client or project keys.
 *
 * Guards (PR #47 Phase-7 review):
 * - Skipped when MIDBRAIN_API_URL is set: an env-bound self-host key must
 *   never be stranded on the default origin for env-less hook children.
 * - Skipped unless this server's own resolution selects the environment key:
 *   an active project/client/global file credential always wins, so a merely
 *   ambient env value is never promoted to machine scope.
 * - Absence-only: an existing global credential is never replaced, and an
 *   unreadable existing file is never touched.
 *
 * Locally never-throwing: everything, including path/scope resolution, runs
 * inside the try so no failure here can affect the rest of startup.
 */
async function ensureHookCredential() {
  try {
    const key = (process.env.MIDBRAIN_API_KEY || '').trim();
    if (!key) return;
    if ((process.env.MIDBRAIN_API_URL || '').trim()) return;
    const resolved = await getClient(process.env.MIDBRAIN_CLIENT)
      .resolveKey(undefined, { includeScope: true });
    if (resolved?.scope !== 'environment') return;
    const targetPath = path.join(globalConfigDir(), KEY_FILENAME);
    const { action } = await writeCredential({
      clientId: 'generic',
      scope: 'global',
      targetPath,
      key,
    });
    if (action === 'written') {
      console.error('[midbrain] hook credential persisted (global scope)');
    }
  } catch (error) {
    if (error instanceof CredentialReplaceNotApprovedError) return; // different key installed: keep it
    if (error instanceof CredentialReadError) return; // unreadable existing file: leave untouched
    // Any other failure (resolution read errors on empty/denied key files,
    // target validation, sandbox guard) is equally non-fatal at startup.
  }
}

// Capture-client label slug — mirrors CLIENT_LABEL_RE in
// plugins/claude-code/common.mjs so a value this migration writes is one the
// hook will accept, and a pre-existing value we must preserve is recognized.
const CAPTURE_CLIENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CAPTURE_CLIENT_MARKER = '.midbrain-capture-client';
const NANOCLAW_CAPTURE_LABEL = 'nanoclaw';

/**
 * Migrate an existing NanoClaw group to the `nanoclaw` capture label (issue
 * #51). Groups configured before v0.4.8 have no `.midbrain-capture-client`
 * marker, so on a natural MCP upgrade the env-stripped Claude hook falls back
 * to `claude`. This seeds the marker on the only durable in-container surface
 * (~/.claude, host `.claude-shared`) so the hook resolves `nanoclaw`.
 *
 * Ownership gate: the migration runs only when this MCP server process itself
 * sees MIDBRAIN_CAPTURE_CLIENT=nanoclaw. NanoClaw supplies that via the group's
 * container.json `mcpServers.<name>.env`, which reaches the server process
 * (hook children do not inherit it — hence the durable marker). A plain host
 * Claude install never sets it, so it is never relabeled.
 *
 * Safe and idempotent:
 * - Absence-only: an existing marker with any other valid value (user/dev) is
 *   preserved untouched.
 * - No churn: a marker already equal to `nanoclaw\n` is left as-is (no rewrite,
 *   no mtime change).
 * - Symlink-reject + atomic temp-rename write at mode 0600.
 *
 * Never throws — self-repair is fail-open.
 */
async function ensureCaptureClientMarker() {
  try {
    const label = (process.env.MIDBRAIN_CAPTURE_CLIENT || '').trim();
    if (label !== NANOCLAW_CAPTURE_LABEL) return;

    const claudeDir = path.join(os.homedir(), '.claude');
    const markerPath = path.join(claudeDir, CAPTURE_CLIENT_MARKER);
    const desired = `${NANOCLAW_CAPTURE_LABEL}\n`;

    // Preserve any existing marker: identical → no-op (no churn); a different
    // valid slug is user/dev-authored and must not be clobbered. Only an
    // absent (ENOENT) marker is seeded.
    let existing = null;
    try {
      existing = await fs.readFile(markerPath, 'utf8');
    } catch (readErr) {
      if (readErr?.code !== 'ENOENT') return; // unreadable/EACCES: leave untouched
    }
    if (existing !== null) {
      if (existing === desired) return; // already migrated — no rewrite
      const firstLine = existing.split('\n', 1)[0].trim();
      if (CAPTURE_CLIENT_RE.test(firstLine)) return; // user/dev value — preserve
      // else: malformed marker → fall through and seed the canonical value
    }

    await fs.mkdir(claudeDir, { recursive: true });

    // Reject a symlink at the target: never follow it to write elsewhere.
    try {
      const lst = await fs.lstat(markerPath);
      if (lst.isSymbolicLink()) return;
    } catch { /* absent — normal path */ }

    const tmp = `${markerPath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, desired, { mode: 0o600 });
    try {
      await fs.rename(tmp, markerPath);
    } catch (renameErr) {
      try { await fs.unlink(tmp); } catch { /* ignore */ }
      throw renameErr;
    }
    try { await fs.chmod(markerPath, 0o600); } catch { /* best effort */ }
    console.error('[midbrain] capture-client marker migrated (nanoclaw)');
  } catch {
    // Non-fatal: marker migration must never affect the rest of startup.
  }
}

// Default cooldown applied when the flush is rate-limited (ms). The production
// edge protection is a moving target, so this is a conservative back-off, not a
// mirror of any specific WAF window. Env-tunable for tests.
const SPOOL_COOLDOWN_MS = 5 * 60_000;
// Small spacing between spool POSTs so a recovered backlog drips into the edge
// rather than bursting. Env-tunable (0 in tests).
const SPOOL_POST_SPACING_MS = 150;

function spoolCooldownMs() {
  const raw = Number(process.env.MIDBRAIN_SPOOL_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : SPOOL_COOLDOWN_MS;
}

function spoolPostSpacingMs() {
  const raw = Number(process.env.MIDBRAIN_SPOOL_POST_SPACING_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : SPOOL_POST_SPACING_MS;
}

// Default cooldown/spacing for the offline episodic-cache drain (#53). Same
// discipline as the spool; separate env knobs so they can be tuned apart.
const CACHE_COOLDOWN_MS = 5 * 60_000;
const CACHE_POST_SPACING_MS = 150;

function cacheCooldownMs() {
  const raw = Number(process.env.MIDBRAIN_CACHE_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : CACHE_COOLDOWN_MS;
}

function cachePostSpacingMs() {
  const raw = Number(process.env.MIDBRAIN_CACHE_POST_SPACING_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : CACHE_POST_SPACING_MS;
}

/**
 * Server-start flush of the keyless recovery spool (issue #52).
 *
 * On a cold NanoClaw wake the opener's hook may have spooled its payload to the
 * durable ~/.claude surface because the key hadn't been persisted yet. Once
 * ensureHookCredential() has run (it precedes this call in runSelfRepair), the
 * key is available, so we drain the spool through the shared disciplined runner
 * (single-pass, WAF-aware, cooldown-gated). Never throws.
 */
async function flushClaudeSpool() {
  try {
    if (!hasSpooledEntries()) return;

    let api;
    try {
      api = await MidbrainApi.create(getClient(process.env.MIDBRAIN_CLIENT || 'claude'));
    } catch {
      return; // No key yet — leave the spool for a later start.
    }

    await runFlush({
      source: {
        begin: beginSpoolFlush,
        finish: finishSpoolFlush,
        readCooldownUntil,
        writeCooldownUntil,
        clearCooldown,
      },
      post: (e) => api.postEpisodicResult(e.text, e.role, e.memory_metadata),
      spacingMs: spoolPostSpacingMs(),
      cooldownMs: spoolCooldownMs(),
      log: (msg) => console.error(msg),
      label: 'spool flush',
    });
  } catch {
    // Non-fatal: spool flush must never affect the rest of startup.
  }
}

/**
 * Server-start drain of the offline episodic cache (issue #53).
 *
 * The cache no longer flushes on every capture (that amplification replayed the
 * whole backlog per hook and produced the 1,610-error incident). Instead we
 * drain it once at boot, throttled, through the same shared runner as the
 * spool. There is no permanent failure: a rotated/absent key, a 4xx, a 5xx, or
 * a WAF rejection all leave the entry cached to retry on the next start —
 * nothing is dropped, capped, or quarantined.
 *
 * Drains EVERY scope binding in the cache dir (not just the current scope) with
 * the current authenticated key, so entries orphaned by a past key rotation are
 * recovered automatically.
 *
 * Never throws — fail-open like the rest of self-repair.
 */
async function flushEpisodicCache() {
  try {
    if (!hasAnyCachedEntries()) return;

    let api;
    try {
      api = await MidbrainApi.create(getClient(process.env.MIDBRAIN_CLIENT || 'claude'));
    } catch {
      return; // No key yet — leave the cache for a later start.
    }

    const post = (e) => api.postEpisodicResult(e.text, e.role, e.memory_metadata);
    const spacingMs = cachePostSpacingMs();
    const cooldownMs = cacheCooldownMs();

    // Drain every binding (current scope + orphans from past keys/hosts).
    for (const scope of listCacheBindings()) {
      const result = await runFlush({
        source: {
          begin: () => beginCacheFlush(scope),
          finish: (flush, survivors) => finishCacheFlush(flush, survivors),
          readCooldownUntil: () => readCacheCooldownUntil(scope),
          writeCooldownUntil: (until) => writeCacheCooldownUntil(scope, until),
          clearCooldown: () => clearCacheCooldown(scope),
        },
        post,
        spacingMs,
        cooldownMs,
        log: (msg) => console.error(msg),
        label: 'cache drain',
      });
      // Stop touching further bindings once the edge signals rate-limiting —
      // one cooldown protects the whole drain, no cross-binding burst.
      if (result.rateLimited) break;
    }
  } catch {
    // Non-fatal: cache drain must never affect the rest of startup.
  }
}

/**
 * Context-gated self-repair (PRD-034 S1). Automatic repair may only run from
 * a durable location: instances launched from temp dirs, git worktrees, or CI
 * must never write their own paths — or anything else — into permanent
 * user-scope config (the 2026-07 /private/tmp + npx-cache incident).
 * npx-cache launches proceed: they are the canonical install mode and all
 * writes are canonical-only values. Never throws.
 *
 * @param {object} [opts]
 * @param {{kind: string, path: string}} [opts.context] - Injectable
 *   classification for tests; defaults to classifying this instance.
 * @param {string} [opts.repoRoot] - Root to classify when no context is
 *   given (default: this package's own root). Lets tests drive the real
 *   classification seam with real fixture directories.
 * @returns {Promise<{skipped: boolean, kind: string}>}
 */
export async function runSelfRepair({ context, repoRoot = REPO_ROOT } = {}) {
  try {
    const ctx = context ?? classifyInstallContext(repoRoot);
    if (shouldSkipSelfRepair(ctx)) {
      console.error(
        `[midbrain] self-repair skipped: running from ${ctx.kind} (${ctx.path}); ` +
        `run 'npx midbrain-memory-mcp install' to repair configs from a durable install`,
      );
      return { skipped: true, kind: ctx.kind };
    }
    // Hook/shim repair first: a hung or slow credential store (network home,
    // FIFO at the key path) must never delay or suppress config repair.
    await ensureHooksFresh();
    await ensureHookCredential();
    await ensureCaptureClientMarker();
    await flushClaudeSpool();
    await flushEpisodicCache();
    return { skipped: false, kind: ctx.kind };
  } catch {
    return { skipped: false, kind: 'unknown' };
  }
}

/**
 * Combined startup check: repair stale hooks (context-gated), then check for
 * npm updates. Started from index.js after server.connect(); never throws.
 *
 * @param {object} [opts] - Forwarded to runSelfRepair (context injection).
 */
export async function checkForUpdate(opts = {}) {
  try {
    // Phase 1: Hook/plugin freshness (context-gated, local I/O only)
    await runSelfRepair(opts);

    // Phase 2: npm version check (throttled). Applies to npx AND global installs.
    const latestVersion = await fetchLatestVersion();
    if (!latestVersion || !isNewerVersion(PKG_VERSION, latestVersion)) return;

    if (selfNpxCacheDir(__dirname)) {
      // npx cache freezes per spec-string; self-heal so the next cold start
      // re-resolves @latest instead of reusing the stale cached install.
      await clearStaleSelfNpxCache(__dirname, latestVersion);
    } else {
      // Global (npm -g) install: cache clearing does not apply; advise update.
      console.error(
        `[midbrain] Update available: ${PKG_VERSION} -> ${latestVersion}. Run: npm update -g midbrain-memory-mcp`,
      );
    }
  } catch { /* never crash */ }
}

/**
 * Lightweight self-update check for capture hooks. Unlike checkForUpdate(),
 * it skips hook/plugin freshness repair (hooks don't need it) and only
 * self-heals a stale npx cache. Throttled via the shared 24h cache file.
 * Hook callers await it only after capture and required stdout complete, so it
 * may delay hook exit by up to UPDATE_FETCH_TIMEOUT_MS. Never throws or writes
 * to stdout.
 *
 * @returns {Promise<void>}
 */
export async function maybeSelfUpdate() {
  try {
    const latestVersion = await fetchLatestVersion();
    if (!latestVersion || !isNewerVersion(PKG_VERSION, latestVersion)) return;
    await clearStaleSelfNpxCache(__dirname, latestVersion);
  } catch { /* never crash */ }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Prompt the user for input via readline. */
async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Step 1: Key resolution — ask each client, prompt if missing
// ---------------------------------------------------------------------------

/**
 * Resolves keys for all detected clients. When no key is found and running
 * interactively, offers device-code login (browser-based) or manual key paste.
 *
 * In non-interactive mode (explicit flag or no TTY), skips prompts — uses
 * existing key files or env var only.
 *
 * @param {object[]} clients - Detected client instances.
 * @param {object} [opts]
 * @param {boolean} [opts.nonInteractive] - Skip all prompts.
 * @param {boolean} [opts.forceLogin] - Force device-code flow even if a key exists.
 * @param {boolean} [opts.noLogin] - Skip browser/device auth and use manual key entry.
 * @returns {Promise<{
 *   keys: Map<string, {key: string, scope: string, source: string}>,
 *   perClient: boolean,
 *   existingClientKeys: Set<string>,
 * }>}
 *   keys: Map<clientId, {key, scope, source}>.
 *   perClient: true when the interactive user wants a distinct per-client key
 *   written (or distinct keys already exist on disk); false for a single shared
 *   key that only needs the global key file.
 *   existingClientKeys: client IDs whose distinct key files already exist and
 *   must not be rewritten.
 */
async function resolveKeys(clients, { nonInteractive = false, forceLogin = false, noLogin = false } = {}) {
  const interactive = !nonInteractive && process.stdin.isTTY;
  const keys = new Map();
  const existingClientKeys = new Set();

  // Check if any client already has a key
  let anyKeyFound = false;
  for (const client of clients) {
    const existing = await client.resolveKey(undefined, { includeScope: true });
    if (existing) {
      console.log(`Found ${client.displayName} key: ${existing.source}`);
      keys.set(client.id, existing);
      if (existing.scope === 'client') existingClientKeys.add(client.id);
      anyKeyFound = true;
    }
  }

  // If --login flag is set and running interactively, force device-code flow.
  // A single freshly-issued key is shared across clients; ask whether to keep
  // it shared (global key only) or split into per-client keys.
  if (forceLogin && !noLogin && interactive) {
    const result = await deviceCodeLogin();
    return await distributeSharedKey(clients, result.apiKey, {
      interactive,
      source: 'device-login',
      existingClientKeys,
    });
  }

  // If all clients already have keys on disk, honor them. Distinct values mean
  // the interactive user deliberately set per-client keys; identical values can
  // stay global. Non-interactive installs never write per-client key files.
  if (keys.size === clients.length) {
    return { keys, perClient: interactive && hasDistinctKeys(keys), existingClientKeys };
  }

  // Fresh interactive install (no key found anywhere). Obtain a single key —
  // via browser login or a manual paste — then ask whether to share it across
  // all detected clients. This keeps every auth entry point consistent: one
  // key, one share decision.
  if (interactive && !anyKeyFound) {
    // --no-login skips the browser option but still uses the single-key +
    // share flow rather than prompting separately for every client.
    if (noLogin) {
      const key = await promptForKey();
      return await distributeSharedKey(clients, key, {
        interactive,
        source: 'manual-entry',
        existingClientKeys,
      });
    }

    console.log('');
    console.log('No API key found. How would you like to authenticate?');
    console.log('  [1] Log in via browser (recommended)');
    console.log('  [2] Paste an existing API key');
    console.log('');
    const choice = await prompt('Select (1-2): ');

    if (choice === '1') {
      try {
        const result = await deviceCodeLogin();
        return await distributeSharedKey(clients, result.apiKey, {
          interactive,
          source: 'device-login',
          existingClientKeys,
        });
      } catch (err) {
        console.error(`Device login failed: ${err.message}`);
        console.error('Falling back to manual key entry.');
        console.error('');
      }
    }

    // Choice [2], a blank choice, or a failed login: paste a single key.
    const key = await promptForKey();
    return await distributeSharedKey(clients, key, {
      interactive,
      source: 'manual-entry',
      existingClientKeys,
    });
  }

  // Partial fill: some clients already have keys on disk, others don't.
  // Prompt only for the missing ones (or warn in non-interactive mode).
  for (const client of clients) {
    if (keys.has(client.id)) continue;

    if (interactive) {
      const key = await promptForKey(`Enter MidBrain API key for ${client.displayName}: `);
      keys.set(client.id, {
        key,
        scope: 'entered',
        source: 'manual-entry',
      });
    } else {
      console.error(`WARN: no key found for ${client.displayName} (non-interactive mode, skipping)`);
    }
  }

  return { keys, perClient: hasDistinctKeys(keys), existingClientKeys };
}

/** Prompt for a single API key, rejecting empty input. */
async function promptForKey(label = 'Enter MidBrain API key: ') {
  const key = await prompt(label);
  if (!key) throw new Error('MidBrain API key is required. Aborting.');
  return key;
}

/** True if the map holds more than one distinct key value. */
function hasDistinctKeys(keys) {
  return new Set([...keys.values()].map(({ key }) => key)).size > 1;
}

/**
 * Given a single shared key (from device login or a single paste), decide
 * whether to keep it shared across all clients (global key only) or to prompt
 * for a distinct key per detected client.
 *
 * @returns {Promise<{
 *   keys: Map<string, {key: string, scope: string, source: string}>,
 *   perClient: boolean,
 *   existingClientKeys: Set<string>,
 * }>}
 */
async function distributeSharedKey(
  clients,
  sharedKey,
  { interactive, source, existingClientKeys = new Set() },
) {
  const keys = new Map();
  const entered = { key: sharedKey, scope: 'entered', source };

  // Non-interactive or a single client: nothing to split — share the key.
  if (!interactive || clients.length < 2) {
    for (const client of clients) keys.set(client.id, entered);
    return { keys, perClient: false, existingClientKeys };
  }

  const names = clients.map((c) => c.displayName).join(', ');
  const answer = await prompt(
    `Use the same key for all detected clients (${names})? [Y/n] `
  );

  // Default (empty) and anything other than an explicit "n" means: share it.
  if (answer.toLowerCase() !== 'n') {
    for (const client of clients) keys.set(client.id, entered);
    return { keys, perClient: false, existingClientKeys };
  }

  // User opted out — prompt for a distinct key per client.
  for (const client of clients) {
    const key = await promptForKey(`Enter MidBrain API key for ${client.displayName}: `);
    keys.set(client.id, { key, scope: 'entered', source: 'manual-entry' });
  }
  return { keys, perClient: true, existingClientKeys };
}

function eligibleGlobalCandidates(resolved) {
  return [...resolved.entries()]
    .filter(([, entry]) => GLOBAL_CANDIDATE_SCOPES.has(entry.scope))
    .map(([clientId, entry]) => ({ clientId, ...entry }));
}

function selectedKeySource(resolved, keySourceFlag) {
  const entry = resolved.get(keySourceFlag);
  if (!entry) throw new Error(`--key-source "${keySourceFlag}" has no resolved credential.`);
  if (!GLOBAL_CANDIDATE_SCOPES.has(entry.scope)) {
    throw new Error(
      `--key-source "${keySourceFlag}" cannot use a ${entry.scope}-scope credential.`,
    );
  }
  return { action: 'write', clientId: keySourceFlag, ...entry };
}

/**
 * Decide whether a resolved credential may be promoted to the global scope.
 */
function decideGlobalKey({
  resolved,
  existingGlobal,
  interactive,
  keySourceFlag,
}) {
  const candidates = eligibleGlobalCandidates(resolved);
  if (existingGlobal !== null) {
    if (keySourceFlag) {
      return { action: 'keep', warning: GLOBAL_KEY_SOURCE_WARNING };
    }
    const fresh = candidates.filter(({ scope }) => scope === 'entered');
    if (!interactive || fresh.length === 0) return { action: 'keep' };
    const distinctFresh = new Set(fresh.map(({ key }) => key));
    return distinctFresh.size === 1
      ? { action: 'confirm-replace', ...fresh[0] }
      : { action: 'choose-replace', candidates: fresh };
  }
  if (keySourceFlag) return selectedKeySource(resolved, keySourceFlag);
  if (candidates.length === 0) return { action: 'none', reason: 'no eligible candidate' };
  if (new Set(candidates.map(({ key }) => key)).size === 1) {
    return { action: 'write', ...candidates[0] };
  }
  return interactive
    ? { action: 'choose', candidates }
    : { action: 'error', reason: 'distinct eligible credentials', candidates };
}

// ---------------------------------------------------------------------------
// Rules helpers
// ---------------------------------------------------------------------------

/** Convert writeProjectRules() results to human-readable status lines. */
function formatRulesLines(results) {
  return results.map(({ action, path: filePath, error, reason }) => {
    const name = path.basename(filePath);
    if (action === 'created') return `Rules written: ${name}`;
    if (action === 'updated') return `Rules updated: ${name}`;
    if (action === 'skipped') return `Rules already current: ${name}`;
    if (action === 'preserved') {
      return `Rules preserved for manual review (${reason}): ${filePath}`;
    }
    return `Rules error (${error?.code || error?.message || 'unknown'}): ${name}`;
  });
}

function rulesOptions(clients) {
  return {
    clients: clients.map((client) => client.id),
    nanoclawRoot: getClient('nanoclaw').resolveRoot?.() || null,
  };
}

// ---------------------------------------------------------------------------
// Step 2: Print summary
// ---------------------------------------------------------------------------
function printSummary(keyLines, clientSummaries) {
  console.log('');
  console.log('MidBrain Memory MCP — Installation Complete');
  console.log('');
  keyLines.forEach((l) => console.log(l));
  console.log('');

  for (const [displayName, lines] of clientSummaries) {
    console.log(`${displayName}:`);
    lines.forEach((l) => console.log(l));
    console.log('');
  }

  if (clientSummaries.size === 0) {
    console.log('No supported AI tools detected.');
    console.log('  Install a supported client, then re-run this script.');
  }
}

// ---------------------------------------------------------------------------
// Rules prompt helper for global main() flow
// ---------------------------------------------------------------------------

const PROJECT_MARKERS = ['.git', 'package.json', 'opencode.json', 'opencode.jsonc'];

/**
 * Write or prompt for MidBrain rules in the user's CWD.
 * process.cwd() is the user's intended project root when running the global
 * interactive installer — it is not derived from user-controlled input.
 */
async function writeRulesForMainMode(nonInteractive, clients) {
  const opts = rulesOptions(clients);
  const globalResults = await writeGlobalRules(opts);
  const globalLines = formatRulesLines(globalResults);
  globalLines.forEach((line) => {
    if (nonInteractive || !process.stdin.isTTY) {
      console.error(`[midbrain] ${line}`);
    } else {
      console.log(line);
    }
  });

  // Justified use of process.cwd(): this is the global installer; the user
  // runs it from their project root. CWD is the natural target.
  const cwd = process.cwd();
  const isProject = PROJECT_MARKERS.some((m) => existsSync(path.join(cwd, m)));

  if (!isProject) {
    console.log('Note: to add MidBrain memory rules to a project\'s instruction files, run:');
    console.log('  npx midbrain-memory-mcp install --project <absolute-path>');
    return;
  }

  const interactive = !nonInteractive && process.stdin.isTTY;
  if (interactive) {
    const answer = await prompt(
      `MidBrain memory rules will be added to:\n  AGENTS.md\n  CLAUDE.md\nin ${cwd}. Proceed? [Y/n] `
    );
    if (answer.toLowerCase() === 'n') {
      console.log('Skipped. Add rules manually — see README §Memory-First Agent Rules.');
      return;
    }
  }

  const results = await writeProjectRules(cwd, opts);
  const lines = formatRulesLines(results);
  if (interactive) {
    lines.forEach((l) => console.log(l));
  } else {
    lines.forEach((l) => console.error(`[midbrain] ${l}`));
  }
}

// ---------------------------------------------------------------------------
// Main (interactive mode)
// ---------------------------------------------------------------------------
function globalKeyPath() {
  return path.join(globalConfigDir(), KEY_FILENAME);
}

function candidateLabel(candidate, clients) {
  const client = clients.find(({ id }) => id === candidate.clientId);
  return `${client?.displayName || candidate.clientId} (${candidate.scope}, ${candidate.source})`;
}

function ambiguityError(candidates, clients) {
  const found = candidates.map((candidate) => `  - ${candidateLabel(candidate, clients)}`).join('\n');
  return [
    'Distinct eligible credentials were found; no global credential was written:',
    found,
    'Resolve by running interactively or passing --key-source <clientId>.',
  ].join('\n');
}

async function promptForGlobalCandidate(candidates, clients) {
  console.log('');
  console.log('Choose the credential to use globally:');
  candidates.forEach((candidate, index) => {
    console.log(`  [${index + 1}] ${candidateLabel(candidate, clients)}`);
  });
  console.log(`  [${candidates.length + 1}] Keep per-client only (no global credential)`);
  console.log(`  [${candidates.length + 2}] Enter a different credential manually`);
  const answer = await prompt(`Select (1-${candidates.length + 2}): `);
  const selected = Number.parseInt(answer, 10);
  if (selected >= 1 && selected <= candidates.length) return candidates[selected - 1];
  if (selected === candidates.length + 2) {
    const key = await promptForKey();
    return { clientId: 'manual', key, scope: 'entered', source: 'manual-entry' };
  }
  return null;
}

async function confirmGlobalReplacement(candidate) {
  const answer = await prompt('Replace existing global credential? [y/N] ');
  return answer.toLowerCase() === 'y' ? candidate : null;
}

async function writeGlobalDecision(decision, clients) {
  if (decision.warning) console.error(`WARN: ${decision.warning}`);
  if (decision.action === 'keep' || decision.action === 'none') return [];
  if (decision.action === 'error') throw new Error(ambiguityError(decision.candidates, clients));

  let candidate = decision;
  if (decision.action === 'choose' || decision.action === 'choose-replace') {
    candidate = await promptForGlobalCandidate(decision.candidates, clients);
  }
  if (!candidate) return [];
  const replacement = decision.action === 'confirm-replace' || decision.action === 'choose-replace';
  if (replacement) candidate = await confirmGlobalReplacement(candidate);
  if (!candidate) return [];
  return [await getClient('generic').writeKey(candidate.key, {
    replaceApproved: replacement,
  })];
}

async function main(opts = {}) {
  const {
    isDev = false,
    nonInteractive = false,
    skipRules = false,
    forceLogin = false,
    noLogin = false,
    keySourceFlag,
  } = opts;
  const clients = detectClients();

  if (clients.length === 0) {
    console.log('No supported AI tools detected.');
    console.log('Install a supported client and re-run: node install.mjs');
    process.exit(0);
  }

  // Resolve and write keys
  const { keys, perClient, existingClientKeys } =
    await resolveKeys(clients, { nonInteractive, forceLogin, noLogin });
  if (keys.size === 0) throw new Error(NO_KEY_MESSAGE);

  const existingGlobal = await readKeyFile(globalKeyPath());
  const interactive = !nonInteractive && process.stdin.isTTY;
  const decision = decideGlobalKey({
    resolved: keys,
    existingGlobal,
    interactive,
    keySourceFlag,
  });
  if (decision.action === 'none') throw new Error(NO_KEY_MESSAGE);
  const keyLines = await writeGlobalDecision(decision, clients);

  // Per-client key files are only written when the user opted into distinct
  // keys (or distinct keys already existed). Otherwise the global key alone
  // serves every client via the resolution chain.
  if (perClient) {
    for (const client of clients) {
      const entry = keys.get(client.id);
      if (!entry) continue;
      if (existingClientKeys.has(client.id)) {
        keyLines.push(`Key preserved: existing ${client.displayName} client credential`);
        continue;
      }
      keyLines.push(await client.writeKey(entry.key));
    }
  }

  // Install each detected client
  const clientSummaries = new Map();
  for (const client of clients) {
    try {
      const lines = await client.installGlobal({ isDev });
      clientSummaries.set(client.displayName, lines);
    } catch (err) {
      clientSummaries.set(client.displayName, [`  ! Install error: ${err.message}`]);
    }
  }

  printSummary(keyLines, clientSummaries);

  if (isDev) {
    const { REPO_ROOT } = await import('./shared/clients/utils.mjs');
    console.log('DEV INSTALL: the files listed above point at this checkout and carry the MIDBRAIN_DEV marker.');
    console.log(`  Checkout: ${REPO_ROOT}`);
    console.log('  Automatic self-repair will preserve them; explicit install wins.');
    console.log('  Revert to the canonical npx install with: npx midbrain-memory-mcp install');
  }

  if (!skipRules) {
    await writeRulesForMainMode(nonInteractive, clients);
  }
}

// ---------------------------------------------------------------------------
// Project setup (shared core — used by both CLI and MCP tool)
// ---------------------------------------------------------------------------

/**
 * Core project setup logic. Validates the path, ensures the project has a
 * key file, and writes client-level MCP configs for all detected clients.
 *
 * Throws on fatal errors (caller decides how to surface them).
 *
 * @param {string} rawPath - Project path (will be resolved + validated).
 * @param {{apiKey?: string, isDev?: boolean}} [opts]
 * @returns {Promise<{lines: string[], keyCreated: boolean, configsWritten: string[], projectDir: string}>}
 */
async function setupProject(rawPath, opts = {}) {
  const { apiKey: apiKeyParam, isDev = false, skipRules = false } = opts;
  const lines = [];
  const configsWritten = [];

  // --- Validate and resolve path ---
  if (!path.isAbsolute(rawPath)) {
    throw new Error(`project_dir must be an absolute path. Got: "${rawPath}"`);
  }
  const resolved = path.resolve(rawPath);
  let projectDir;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`"${resolved}" is not a directory.`);
    }
    projectDir = await fs.realpath(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`Directory does not exist: "${resolved}"`, { cause: err });
    if (err.message.includes('is not a directory')) throw err;
    throw new Error(`Cannot access "${resolved}": ${err.message}`, { cause: err });
  }

  // --- Resolve key ---
  const generic = getClient('generic');
  let apiKey;
  if (apiKeyParam) {
    apiKey = apiKeyParam.trim();
  } else {
    const client = getClient(process.env.MIDBRAIN_CLIENT);
    const result = await client.resolveKey(projectDir);
    if (!result) {
      throw new Error("No API key found. Run the installer first (npx midbrain-memory-mcp install).");
    }
    apiKey = result.key;
    lines.push(`Key resolved from: ${result.source}`);
  }

  // --- Ensure project has its own key file ---
  let keyCreated = false;
  const existingProjectKey = await generic.getProjectKey(projectDir);
  if (existingProjectKey) {
    lines.push("Existing project key preserved.");
  } else {
    const keyPath = await generic.setProjectKey(projectDir, apiKey);
    keyCreated = true;
    lines.push(`Key file created: ${keyPath} (chmod 600)`);
  }

  // --- Write client configs ---
  const clients = detectClients();

  for (const client of clients) {
    try {
      const clientLines = await client.installProject(projectDir, { isDev });
      lines.push(...clientLines);
      configsWritten.push(...client.projectConfigFiles(projectDir));
    } catch (err) {
      lines.push(`Error (${client.displayName}): ${err.message}`);
    }
  }

  if (clients.length === 0) {
    lines.push("Warning: no supported AI clients detected. No configs written.");
  }

  let rulesWritten = [];
  if (!skipRules) {
    const opts = rulesOptions(clients);
    const globalResults = await writeGlobalRules(opts);
    const projectResults = await writeProjectRules(projectDir, opts);
    const rulesResults = [...globalResults, ...projectResults];
    lines.push(...formatRulesLines(rulesResults));
    rulesWritten = rulesResults
      .filter((r) => r.action === 'created' || r.action === 'updated')
      .map((r) => r.path);
  }

  return { lines, keyCreated, configsWritten, projectDir, rulesWritten };
}

// ---------------------------------------------------------------------------
// CLI wrapper for --project mode
// ---------------------------------------------------------------------------

async function projectSetup(rawPath, opts = {}) {
  try {
    const result = await setupProject(rawPath, opts);
    console.error('[project] Setup complete. Restart your AI client for the new project memory to take effect.');
    console.log(JSON.stringify({
      success: true,
      project_dir: result.projectDir,
      key_created: result.keyCreated,
      configs_written: result.configsWritten,
      rules_written: result.rulesWritten,
      restart_required: true,
    }, null, 2));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI help
// ---------------------------------------------------------------------------

const HELP_TEXT = `\
MidBrain Memory MCP — installer

Usage:
  npx midbrain-memory-mcp install                            Interactive install
  npx midbrain-memory-mcp install --login                    Force browser-based login
  npx midbrain-memory-mcp install --project <absolute-path>  Per-project setup (non-interactive)
  npx midbrain-memory-mcp install --non-interactive           Non-interactive install (uses existing keys/env)
  npx midbrain-memory-mcp install --non-interactive --key-source <clientId>
  npx midbrain-memory-mcp install --help                     Show this help

Development (clone-local):
  node install.mjs [--help | --project <path> | --dev | --non-interactive | --key-source <clientId> | --no-rules]

Flags:
  --login             Authenticate via browser (opens your default browser).
                      Creates an agent and API key automatically. This is the
                      default when no existing API key is found.
  --no-login          Skip browser-based auth. Only use existing key files,
                      env var, or manual paste.
  --project <path>    Absolute path to the project root directory.
  --dev               Write absolute-path configs pointing at this clone.
                      (For repository contributors. Default is npx @latest,
                      which is auto-updating and portable across machines.)
  --non-interactive   Skip all prompts. Uses existing key files or
                      MIDBRAIN_API_KEY env var. Useful for Docker entrypoints
                      and CI environments.
  --key-source <id>   Explicitly select one detected client's eligible key for
                      global use when non-interactive candidates differ.
  --no-rules          Skip writing MidBrain memory rules to AGENTS.md and
                      CLAUDE.md. Use when managing instruction files manually.
  --help, -h          Show this help text.

By default, the installer writes 'npx -y midbrain-memory-mcp@latest' as the
MCP command, so every MCP client cold-start re-resolves @latest against the
npm registry. This gives non-technical users a self-updating install with
zero maintenance.
`;

function printHelp() {
  console.log(HELP_TEXT);
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    throw new Error(`${flag} requires a client ID argument.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI entry point for the installer. Used by:
 *   - install.mjs's own isMain block (direct `node install.mjs`)
 *   - index.js's `install` subcommand dispatch (PRD-011)
 *
 * Parses argv flags (--help, -h, --project <path>, --dev) and runs the
 * matching installer flow. Writes all progress/debug to stderr.
 *
 * @param {string[]} argv  Installer flags only (no node/script path).
 * @returns {Promise<void>}
 */
async function runInstallerCli(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }
  const isDev = argv.includes('--dev');
  const nonInteractive = argv.includes('--non-interactive');
  const skipRules = argv.includes('--no-rules');
  const forceLogin = argv.includes('--login');
  const noLogin = argv.includes('--no-login');
  const projectFlagIdx = argv.indexOf('--project');
  if (projectFlagIdx !== -1) {
    const projectArg = argv[projectFlagIdx + 1];
    if (!projectArg || projectArg.startsWith('-')) {
      console.error('Error: --project requires a path argument.');
      console.error('Usage: node install.mjs --project /absolute/path/to/project');
      process.exit(1);
    }
    if (projectArg.trim() === '') {
      console.error('Error: --project path cannot be empty.');
      process.exit(1);
    }
    try {
      await projectSetup(projectArg, { isDev, skipRules });
    } catch (err) {
      console.error(`Fatal error: ${err.message}`);
      process.exit(1);
    }
  } else {
    try {
      const keySourceFlag = flagValue(argv, '--key-source');
      await main({
        isDev,
        nonInteractive,
        skipRules,
        forceLogin,
        noLogin,
        keySourceFlag,
      });
    } catch (err) {
      console.error('Fatal error:', err.message);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// user-key subcommand: set/reroll the account-level user API key
// ---------------------------------------------------------------------------

/** Prompt for a line of input, echoing the prompt to stderr (keeps stdout clean). */
async function promptStderr(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * `user-key set [key]` — store the account-level user API key in the global
 * keystore. Prefer the no-argument form: it prompts on stderr so the secret
 * never lands in shell history or an assistant transcript. Passing the key
 * inline is supported for scripts/CI but records it in shell history.
 *
 * @param {string[]} argv  Subcommand args (after "user-key").
 */
async function runUserKeyCli(argv) {
  const sub = argv[0];
  if (sub === 'set') {
    let key = argv[1];
    if (!key) key = await promptStderr('Enter your MidBrain user API key: ');
    if (!key) {
      console.error('No key provided. Aborting.');
      process.exit(1);
    }
    // Store unconditionally — this is a local file write, not a validation
    // step. If the key is bad, the account operations that use it will fail
    // with the real server error at the point they are invoked.
    const ks = await readGlobalKeystore();
    await writeGlobalKeystore({ ...ks, user_key: key });
    // Never echo any part of the secret (privacy contract).
    console.error(`User API key saved to ${globalKeystorePath()}`);
    return;
  }

  console.error('Usage: midbrain-memory-mcp@latest user-key set');
  console.error('  Runs interactively and prompts for the key (recommended).');
  console.error('  Optionally: user-key set <key>  (records the key in shell history)');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Exports (for testability)
// ---------------------------------------------------------------------------
export {
  main,
  setupProject,
  projectSetup,
  runInstallerCli,
  runUserKeyCli,
  printHelp,
  decideGlobalKey,
  // Re-exports from registry for test convenience
  detectClients,
  allClients,
  getClient,
};

// ---------------------------------------------------------------------------
// Dispatch: --project mode vs interactive (only when run directly)
// ---------------------------------------------------------------------------
import { realpathSync, existsSync } from 'fs';
const isMain = process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  await runInstallerCli(process.argv.slice(2));
}
