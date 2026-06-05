/**
 * Codex client adapter.
 *
 * Encapsulates Codex-specific config handling:
 * - ~/.codex/config.toml (MCP server config)
 * - ~/.codex/hooks.json (global capture hooks)
 * - ~/.config/codex/.midbrain-key (per-client key)
 * - <project>/.codex/config.toml (project MCP config only)
 */

import { BaseClient, readKeyFile } from './base.mjs';

const KEY_FILENAME = ".midbrain-key";
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';

function home() { return os.homedir(); }
function codexDir() { return path.join(home(), '.codex'); }
function configPath() { return path.join(codexDir(), 'config.toml'); }
function cfgDir() { return path.join(home(), '.config', 'codex'); }
function keyFilePath() { return path.join(cfgDir(), KEY_FILENAME); }

/** Write a key file with chmod 600. */
async function writeSecure(filePath, key) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, key + '\n', 'utf8');
  await fs.chmod(filePath, 0o600);
}

export class Codex extends BaseClient {
  get id() { return 'codex'; }
  get displayName() { return 'Codex'; }

  isInstalled() {
    return existsSync(configPath()) || existsSync(codexDir());
  }

  async resolveClientKey() {
    const source = keyFilePath();
    const key = await readKeyFile(source);
    return key ? { key, source } : null;
  }

  async writeKey(key) {
    const kfp = keyFilePath();
    await writeSecure(kfp, key);
    return `Key: ~/.config/codex/${KEY_FILENAME} (chmod 600)`;
  }

  async installGlobal(_opts = {}) {
    return [];
  }

  async installProject(_projectDir, _opts = {}) {
    return [];
  }

  projectConfigFiles(_projectDir) {
    return ['.codex/config.toml'];
  }
}
