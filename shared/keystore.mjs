/**
 * shared/keystore.mjs
 *
 * Structured, versioned keystore for account credentials and agent records:
 *   - user_key   Account-level user API key (mints agents + agent keys).
 *   - agents{}   Per-agent catalog records:
 *       { key_provider, agent_key, alias,
 *         client_key?, inner_keys? }   (client_key/inner_keys reserved for e2ee)
 *
 * The keystore is NOT an agent selector. Agent selection is owned entirely by
 * the `.midbrain-key` files (project overrides global) via BaseClient.
 * resolveKey(). The keystore is where the user key and the agent catalog live
 * — e.g. `set_agent` reads an agent's key from here and writes it into a
 * project `.midbrain-key`.
 *
 * Design rules:
 *   - Stored as JSON with chmod 600 (same permission posture as key files).
 *   - Fail-closed on unparseable content: readKeystore throws (callers decide),
 *     mirroring the codex TOML / hermes YAML adapters — never silently reset a
 *     user's keystore.
 *   - No npm deps. Node 20 + Bun compatible.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export const KEYSTORE_FILENAME = '.midbrain-keystore.json';
export const KEYSTORE_VERSION = 1;

/** Absolute path to the global keystore (~/.config/midbrain/.midbrain-keystore.json). */
export function globalKeystorePath() {
  return path.join(os.homedir(), '.config', 'midbrain', KEYSTORE_FILENAME);
}

/** Read the global keystore, or an empty keystore if absent. */
export async function readGlobalKeystore() {
  return (await readKeystore(globalKeystorePath())) || emptyKeystore();
}

/** Write the global keystore (chmod 600, creates dirs). */
export async function writeGlobalKeystore(ks) {
  await writeKeystore(globalKeystorePath(), ks);
}

// In-process serialization for read-modify-write cycles so concurrent updates
// (e.g. two account tool calls) cannot clobber each other by interleaving a
// read against a stale copy. Cross-process safety still relies on the atomic
// rename in the guarded writer.
let keystoreMutation = Promise.resolve();

/**
 * Atomically read-modify-write the global keystore under an in-process lock.
 * @param {(ks: object) => object|Promise<object>} mutate  Returns the new keystore.
 * @returns {Promise<object>} The written keystore.
 */
export async function mutateGlobalKeystore(mutate) {
  const run = keystoreMutation.then(async () => {
    const current = await readGlobalKeystore();
    const next = await mutate(current);
    await writeGlobalKeystore(next);
    return next;
  });
  // Keep the chain alive even if this mutation rejects.
  keystoreMutation = run.catch(() => {});
  return run;
}

/** An empty, well-formed keystore object. */
export function emptyKeystore() {
  return { version: KEYSTORE_VERSION, agents: {} };
}

/**
 * Read and parse a keystore file.
 * @param {string} filePath
 * @returns {Promise<object|null>} Parsed keystore, or null if the file is absent.
 * @throws If the file exists but cannot be parsed (fail-closed).
 */
export async function readKeystore(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse keystore ${filePath}: ${err.message}`, { cause: err });
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Invalid keystore ${filePath}: expected a JSON object at root`);
  }
  return normalize(data);
}

/**
 * Write a keystore object through the guarded writer (symlink-reject, 0700
 * parent dir, atomic mode-0600 write, backup-before-replace, test-sandbox
 * guard). The guarded writer is imported lazily to avoid a module-eval import
 * cycle (base.mjs -> keystore.mjs), since it transitively imports base.mjs.
 * @param {string} filePath
 * @param {object} data
 */
export async function writeKeystore(filePath, data) {
  const normalized = normalize(data);
  const { writeKeystoreFile } = await import('./clients/credential-writer.mjs');
  await writeKeystoreFile(filePath, normalized);
}

/** Ensure required shape (version + agents object) without dropping unknown keys. */
function normalize(data) {
  const out = { ...data };
  if (typeof out.version !== 'number') out.version = KEYSTORE_VERSION;
  if (!out.agents || typeof out.agents !== 'object' || Array.isArray(out.agents)) {
    out.agents = {};
  }
  return out;
}

// --- Accessors / mutators (pure over a keystore object) ---

/** @returns {string|null} The stored user API key, or null. */
export function getUserKey(ks) {
  return ks && typeof ks.user_key === 'string' && ks.user_key ? ks.user_key : null;
}

/** Return a new keystore with the user key set. */
export function setUserKey(ks, key) {
  return { ...normalize(ks || emptyKeystore()), user_key: key };
}

/** @returns {object|null} A specific agent record (with agent_id), or null. */
export function getAgent(ks, agentId) {
  const agent = ks?.agents?.[agentId];
  return agent ? { agent_id: agentId, ...agent } : null;
}

/** @returns {Array<object>} All agent records, each including agent_id. */
export function listAgents(ks) {
  const agents = ks?.agents || {};
  return Object.entries(agents).map(([agent_id, rec]) => ({ agent_id, ...rec }));
}

/**
 * Insert or update an agent record. `agent_id` is required; other fields are
 * merged over any existing record. Returns a new keystore.
 */
export function upsertAgent(ks, { agent_id, ...fields }) {
  if (!agent_id) throw new Error('upsertAgent requires an agent_id');
  const base = normalize(ks || emptyKeystore());
  const existing = base.agents[agent_id] || {};
  return {
    ...base,
    agents: { ...base.agents, [agent_id]: { ...existing, ...fields } },
  };
}

// --- Agent resolution filter ---

/**
 * Resolve a free-form agent reference (name/alias or id) to a single agent.
 *
 * Precedence (first tier that yields exactly one match wins):
 *   1. Exact agent_id.
 *   2. Exact name/alias (case-insensitive).
 *   3. Unique case-insensitive substring of name/alias.
 *
 * On zero matches or an ambiguous (2+) match, no agent is returned and the
 * caller is expected to list candidates and ask the user to disambiguate.
 *
 * @param {Array<object>} agents  Agent records (agent_id + optional name/alias).
 * @param {string} query          Free-form reference.
 * @returns {{status:'ok', agent:object}
 *          |{status:'none'}
 *          |{status:'ambiguous', candidates:Array<object>}}
 */
export function resolveAgentRef(agents, query) {
  const list = Array.isArray(agents) ? agents : [];
  const q = String(query ?? '').trim();
  if (!q) return { status: 'none' };

  // Tier 1: exact agent_id.
  const byId = list.filter((a) => a.agent_id === q);
  if (byId.length === 1) return { status: 'ok', agent: byId[0] };
  if (byId.length > 1) return { status: 'ambiguous', candidates: byId };

  const label = (a) => a.alias || a.name || '';
  const lc = q.toLowerCase();

  // Tier 2: exact name/alias (case-insensitive).
  const byExactName = list.filter((a) => label(a).toLowerCase() === lc);
  if (byExactName.length === 1) return { status: 'ok', agent: byExactName[0] };
  if (byExactName.length > 1) return { status: 'ambiguous', candidates: byExactName };

  // Tier 3: unique substring of name/alias (case-insensitive).
  const bySubstr = list.filter((a) => label(a).toLowerCase().includes(lc));
  if (bySubstr.length === 1) return { status: 'ok', agent: bySubstr[0] };
  if (bySubstr.length > 1) return { status: 'ambiguous', candidates: bySubstr };

  return { status: 'none' };
}
