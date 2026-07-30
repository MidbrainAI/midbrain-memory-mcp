/**
 * Generic (fallback) client adapter.
 *
 * Near-noop: inherits the full key resolution chain from BaseClient.
 * Provides project key CRUD for the installer and global key write.
 * Config-writing methods are no-ops (only named clients write configs).
 */

import { homedir } from 'os';
import { join } from 'path';
import { BaseClient } from './base.mjs';
import { writeCredential } from './credential-writer.mjs';
import { KEY_FILENAME, MIDBRAIN_DIR, resolveProjectKey } from './utils.mjs';

export class Generic extends BaseClient {
  get id() { return 'generic'; }
  get displayName() { return 'Generic'; }

  isInstalled() { return true; }

  /** Write the global key. Returns a summary line. */
  async writeKey(key, { replaceApproved = false } = {}) {
    const gp = join(homedir(), '.config', 'midbrain', KEY_FILENAME);
    await writeCredential({
      clientId: this.id,
      scope: 'global',
      targetPath: gp,
      key,
      replaceApproved,
    });
    return `Key: ~/.config/midbrain/${KEY_FILENAME} (chmod 600)`;
  }

  // --- Project key CRUD (used by installer) ---

  /** Check if a project-level key file exists. */
  async getProjectKey(projectDir) {
    return resolveProjectKey(projectDir);
  }

  /** Write the project-level key. Returns the file path written. */
  async setProjectKey(projectDir, key) {
    const keyPath = join(projectDir, MIDBRAIN_DIR, KEY_FILENAME);
    await writeCredential({
      clientId: this.id,
      scope: 'project',
      targetPath: keyPath,
      projectDir,
      key,
    });
    return keyPath;
  }

  // --- No-op config methods (only named clients write configs) ---

  async installGlobal(_opts) { return []; }
  async installProject(_projectDir, _opts) { return []; }
  projectConfigFiles(_projectDir) { return []; }
}
