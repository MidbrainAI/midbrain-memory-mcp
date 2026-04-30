/**
 * Abstract base class for MCP client adapters.
 *
 * Each supported client (OpenCode, Claude Code, future clients) implements
 * this interface. The installer, server, and migration logic call only
 * these methods — never client-specific branching.
 *
 * ## Adding a new client
 *
 * 1. Create `shared/clients/<name>.mjs` extending BaseClient.
 * 2. Implement all abstract methods/getters (see JSDoc below).
 * 3. Import and instantiate in `shared/clients/registry.mjs`:
 *      import { MyClient } from './myclient.mjs';
 *      const CLIENTS = [new OpenCode(), new Claude(), new MyClient()];
 * 4. Done. The installer and server pick it up automatically.
 *    No changes to install.mjs, index.js, or existing tests.
 */

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

// --- Base client class ---

const KEY_FILENAME = ".midbrain-key";
const MIDBRAIN_DIR = '.midbrain';
const ENV_VAR = 'MIDBRAIN_API_KEY';

/**
 * Read a key file. Returns trimmed content, or null on ENOENT.
 * Throws on EACCES (permission denied) or empty file.
 */
async function tryReadKey(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'EACCES') throw new Error(`Permission denied reading key file: ${filePath}`, { cause: err });
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const key = raw.trim();
  if (!key) throw new Error(`Key file is empty: ${filePath}`);
  return key;
}

export class BaseClient {
  /** @returns {string} Machine-readable identifier ("opencode", "claude") */
  get id() { throw new Error("BaseClient.id not implemented"); }

  /** @returns {string} Human-readable name for user-facing output */
  get displayName() { throw new Error("BaseClient.displayName not implemented"); }

  /** @returns {boolean} Whether this client is installed on the system */
  isInstalled() { throw new Error("BaseClient.isInstalled not implemented"); }

  /**
   * Resolves the API key from this client's own storage.
   * Override in concrete clients (OpenCode, Claude) to check client-specific
   * key file locations. Default returns null (no client-specific key).
   * @returns {Promise<{key: string, source: string} | null>}
   */
  async resolveClientKey() { return null; }

  /**
   * Resolves the API key using the standard priority chain:
   *   1. Project key (<projectDir>/.midbrain/.midbrain-key, then flat .midbrain-key)
   *   2. Client's own storage (resolveClientKey())
   *   3. Global (~/.config/midbrain/.midbrain-key)
   *   4. MIDBRAIN_API_KEY env var
   *
   * @param {string} [projectDir] - Explicit project directory (overrides MIDBRAIN_PROJECT_DIR env).
   * @returns {Promise<{key: string, source: string} | null>}
   */
  async resolveKey(projectDir) {
    const projDir = projectDir || process.env.MIDBRAIN_PROJECT_DIR;
    if (projDir) {
      const key = await this.#resolveProjectKey(projDir);
      if (key) return key;
      console.error(`WARN: no project key found in "${projDir}", falling through to global key.`);
    }

    const own = await this.resolveClientKey();
    if (own) return own;

    const global_ = await this.#resolveGlobalKey();
    if (global_) return global_;

    if (process.env[ENV_VAR]) {
      const key = process.env[ENV_VAR].trim();
      if (key) return { key, source: `env:${ENV_VAR}` };
    }

    return null;
  }

  async #resolveProjectKey(projDir) {
    const subPath = join(projDir, MIDBRAIN_DIR, KEY_FILENAME);
    const subKey = await tryReadKey(subPath);
    if (subKey) return { key: subKey, source: subPath };

    const flatPath = join(projDir, KEY_FILENAME);
    const flatKey = await tryReadKey(flatPath);
    if (flatKey) return { key: flatKey, source: flatPath };

    return null;
  }

  async #resolveGlobalKey() {
    const globalPath = join(homedir(), '.config', 'midbrain', KEY_FILENAME);
    const key = await tryReadKey(globalPath);
    return key ? { key, source: globalPath } : null;
  }

  static maskKey(key) {
    if (!key || key.length < 4) return '****';
    return `...${key.slice(-4)}`;
  }

  async writeKey(_key) { throw new Error("BaseClient.writeKey not implemented"); }
  async installGlobal(_opts) { throw new Error("BaseClient.installGlobal not implemented"); }
  async installProject(_projectDir, _opts) { throw new Error("BaseClient.installProject not implemented"); }
  projectConfigFiles(_projectDir) { throw new Error("BaseClient.projectConfigFiles not implemented"); }
}
