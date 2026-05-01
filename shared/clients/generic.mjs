/**
 * Generic (fallback) client adapter.
 *
 * Near-noop: inherits the full key resolution chain from BaseClient.
 * Provides project key CRUD for the installer and global key write.
 * Config-writing methods are no-ops (only named clients write configs).
 */

import { writeFile, mkdir, chmod, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { BaseClient } from './base.mjs';

const KEY_FILENAME = ".midbrain-key";

const MIDBRAIN_DIR = '.midbrain';

/** Write a key file with chmod 600 (creates parent dirs). */
async function writeSecure(filePath, key) {
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, key + '\n', 'utf8');
  await chmod(filePath, 0o600);
}

export class Generic extends BaseClient {
  get id() { return 'generic'; }
  get displayName() { return 'Generic'; }

  isInstalled() { return true; }

  /** Write the global key. Returns a summary line. */
  async writeKey(key) {
    const gp = join(homedir(), '.config', 'midbrain', KEY_FILENAME);
    await writeSecure(gp, key);
    return `Key: ~/.config/midbrain/${KEY_FILENAME} (chmod 600)`;
  }

  // --- Project key CRUD (used by installer) ---

  /** Check if a project-level key file exists. */
  async getProjectKey(projectDir) {
    const tryRead = async (p) => {
      try { const r = (await readFile(p, 'utf8')).trim(); return r || null; } catch { return null; }
    };
    const subPath = join(projectDir, MIDBRAIN_DIR, KEY_FILENAME);
    const subKey = await tryRead(subPath);
    if (subKey) return { key: subKey, source: subPath };

    const flatPath = join(projectDir, KEY_FILENAME);
    const flatKey = await tryRead(flatPath);
    if (flatKey) return { key: flatKey, source: flatPath };

    return null;
  }

  /** Write the project-level key. Returns the file path written. */
  async setProjectKey(projectDir, key) {
    const keyPath = join(projectDir, MIDBRAIN_DIR, KEY_FILENAME);
    await writeSecure(keyPath, key);
    return keyPath;
  }

  // --- No-op config methods (only named clients write configs) ---

  async installGlobal(_opts) { return []; }
  async installProject(_projectDir, _opts) { return []; }
  projectConfigFiles(_projectDir) { return []; }
}
