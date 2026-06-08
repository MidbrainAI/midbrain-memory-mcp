/**
 * NanoClaw client adapter.
 *
 * NanoClaw runs Claude Code inside Docker containers. This adapter detects
 * a NanoClaw installation on the host and copies the /add-midbrain skill
 * into the NanoClaw skills directory. The skill handles all container-side
 * setup (MCP server wiring, hook installation, API key configuration).
 *
 * Detection: looks for a nanoclaw repo with container/Dockerfile and
 * .claude/skills/ directory. Uses NANOCLAW_HOME env var if set, otherwise
 * scans common locations.
 */

import { BaseClient, readKeyFile } from './base.mjs';
import { KEY_FILENAME, REPO_ROOT, home, writeSecure } from './utils.mjs';

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const SKILL_NAME = 'add-midbrain';
const SKILL_SRC = path.join(REPO_ROOT, 'skills', 'nanoclaw', 'SKILL.md');

// Common NanoClaw install locations to scan.
const NANOCLAW_DIRS = ['nanoclaw-v2', 'nanoclaw', 'NanoClaw'];

function cfgDir() { return path.join(home(), '.config', 'nanoclaw'); }
function keyFilePath() { return path.join(cfgDir(), KEY_FILENAME); }
function skillDir(root) { return path.join(root, '.claude', 'skills', SKILL_NAME); }
function skillFile(root) { return path.join(skillDir(root), 'SKILL.md'); }

/**
 * Resolve the NanoClaw project root directory.
 * Priority: NANOCLAW_HOME env > common locations under $HOME.
 * Returns null if not found.
 */
function resolveNanoClawRoot() {
  const envDir = process.env.NANOCLAW_HOME?.trim();
  if (envDir && isNanoClawDir(envDir)) return envDir;

  for (const dir of NANOCLAW_DIRS) {
    const candidate = path.join(home(), dir);
    if (isNanoClawDir(candidate)) return candidate;
  }
  return null;
}

/** Check if a directory looks like a NanoClaw installation. */
function isNanoClawDir(dir) {
  return existsSync(path.join(dir, 'container', 'Dockerfile'))
    && existsSync(path.join(dir, '.claude', 'skills'));
}

export class NanoClaw extends BaseClient {
  get id() { return 'nanoclaw'; }
  get displayName() { return 'NanoClaw'; }

  isInstalled() { return resolveNanoClawRoot() !== null; }

  async resolveClientKey() {
    const source = keyFilePath();
    const key = await readKeyFile(source);
    return key ? { key, source } : null;
  }

  async writeKey(key) {
    const kfp = keyFilePath();
    await writeSecure(kfp, key);
    return `Key: ~/.config/nanoclaw/${KEY_FILENAME} (chmod 600)`;
  }

  async installGlobal(_opts = {}) {
    const summary = [];
    const root = resolveNanoClawRoot();
    if (!root) return summary;

    // Copy the /add-midbrain skill into NanoClaw's skills directory
    const skillDst = skillDir(root);
    await fs.mkdir(skillDst, { recursive: true });
    await fs.copyFile(SKILL_SRC, skillFile(root));
    summary.push(`  + Skill installed: ${skillFile(root)}`);
    summary.push('  -> Open Claude Code in your NanoClaw directory and run /add-midbrain');

    return summary;
  }

  async installProject(_projectDir, _opts) { return []; }
  projectConfigFiles(_projectDir) { return []; }

  /** NanoClaw skill freshness is based on packaged skill content. */
  async isFresh() {
    const root = resolveNanoClawRoot();
    if (!root) return true; // not installed = nothing to repair
    const installed = skillFile(root);
    if (!existsSync(installed)) return false;
    try {
      const [source, current] = await Promise.all([
        fs.readFile(SKILL_SRC, 'utf8'),
        fs.readFile(installed, 'utf8'),
      ]);
      return source === current;
    } catch { return false; }
  }

  /** Repair = re-copy the skill file. */
  async repairSkill() {
    const root = resolveNanoClawRoot();
    if (!root) return [];
    const skillDst = skillDir(root);
    await fs.mkdir(skillDst, { recursive: true });
    await fs.copyFile(SKILL_SRC, skillFile(root));
    return ['  ~ NanoClaw skill repaired (SKILL.md re-copied)'];
  }
}
