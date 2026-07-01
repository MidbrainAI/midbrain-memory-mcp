/**
 * Client registry — single entry point for all client adapter operations.
 *
 * Adding a new client: import the class, add to CLIENTS.
 * That's it — the installer and server pick it up automatically.
 */

import { OpenCode } from './opencode.mjs';
import { Claude } from './claude.mjs';
import { Codex } from './codex.mjs';
import { NanoClaw } from './nanoclaw.mjs';
import { Hermes } from './hermes.mjs';
import { Generic } from './generic.mjs';

const CLIENTS = [new OpenCode(), new Claude(), new Codex(), new NanoClaw(), new Hermes()];
const FALLBACK = new Generic();

/** Returns all registered client adapters (excludes generic fallback). */
export function allClients() {
  return CLIENTS;
}

/** Returns only clients detected as installed on this system. */
export function detectClients() {
  return CLIENTS.filter((c) => c.isInstalled());
}

/**
 * Infer client id from MIDBRAIN_CONFIG_DIR for pre-MIDBRAIN_CLIENT installs.
 * Old installs wrote MIDBRAIN_CONFIG_DIR=~/.config/opencode (or claude) but
 * not MIDBRAIN_CLIENT. Inferring from the path lets us drop MIDBRAIN_CONFIG_DIR
 * from the key resolution chain entirely.
 */
function inferClientId() {
  const dir = process.env.MIDBRAIN_CONFIG_DIR || '';
  if (!dir) return null;
  if (dir.includes('opencode')) {
    console.error('[midbrain] WARN: MIDBRAIN_CLIENT not set, inferred "opencode" from MIDBRAIN_CONFIG_DIR. Re-run: npx midbrain-memory-mcp install');
    return 'opencode';
  }
  if (dir.includes('claude')) {
    console.error('[midbrain] WARN: MIDBRAIN_CLIENT not set, inferred "claude" from MIDBRAIN_CONFIG_DIR. Re-run: npx midbrain-memory-mcp install');
    return 'claude';
  }
  if (dir.includes('codex')) {
    console.error('[midbrain] WARN: MIDBRAIN_CLIENT not set, inferred "codex" from MIDBRAIN_CONFIG_DIR. Re-run: npx midbrain-memory-mcp install');
    return 'codex';
  }
  if (dir.includes('nanoclaw')) {
    console.error('[midbrain] WARN: MIDBRAIN_CLIENT not set, inferred "nanoclaw" from MIDBRAIN_CONFIG_DIR. Re-run: npx midbrain-memory-mcp install');
    return 'nanoclaw';
  }
  if (dir.includes('hermes')) {
    console.error('[midbrain] WARN: MIDBRAIN_CLIENT not set, inferred "hermes" from MIDBRAIN_CONFIG_DIR. Re-run: npx midbrain-memory-mcp install');
    return 'hermes';
  }
  return null;
}

/** Get a client by id. Falls back to inference from MIDBRAIN_CONFIG_DIR, then generic. */
export function getClient(id) {
  const resolvedId = id || inferClientId();
  if (!resolvedId) return FALLBACK;
  return CLIENTS.find((c) => c.id === resolvedId) || FALLBACK;
}
