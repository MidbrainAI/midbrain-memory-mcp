import path from 'node:path';
import os from 'node:os';
const NANOCLAW_DIRS = ['nanoclaw-v2', 'nanoclaw', 'NanoClaw'];
const NANOCLAW_SKILL_REL = path.join('.claude', 'skills', 'add-midbrain', 'SKILL.md');

/** Every real-home surface the suite must never mutate. */
export function tripwireSurfaces(home = os.homedir()) {
  const hermesHome = process.env.HERMES_HOME?.trim()
    ? path.resolve(process.env.HERMES_HOME.trim())
    : path.join(home, '.hermes');
  const piDir = process.env.PI_CODING_AGENT_DIR?.trim() ? path.resolve(process.env.PI_CODING_AGENT_DIR.trim()) : path.join(home, '.pi', 'agent');
  const opencodeDir = path.join(home, '.config', 'opencode');
  // Mirrors openclaw.mjs state/config resolution from the ambient env,
  // including the profile-suffixed state dir.
  const openclawProfile = process.env.OPENCLAW_PROFILE?.trim();
  const openclawStateName = openclawProfile && openclawProfile !== 'default'
    ? `.openclaw-${openclawProfile}`
    : '.openclaw';
  const openclawState = process.env.OPENCLAW_STATE_DIR?.trim()
    ? path.resolve(process.env.OPENCLAW_STATE_DIR.trim())
    : path.join(process.env.OPENCLAW_HOME?.trim() || home, openclawStateName);
  const openclawConfig = process.env.OPENCLAW_CONFIG_PATH?.trim()
    ? path.resolve(process.env.OPENCLAW_CONFIG_PATH.trim())
    : path.join(openclawState, 'openclaw.json');
  const openclawPlugin = path.join(home, '.config', 'openclaw', 'midbrain-plugin');
  const nanoclawRoots = NANOCLAW_DIRS.map((dir) => path.join(home, dir));
  if (process.env.NANOCLAW_HOME?.trim()) {
    nanoclawRoots.unshift(path.resolve(process.env.NANOCLAW_HOME.trim()));
  }
  return [
    ...['AGENTS.md', 'settings.json', 'auth.json', 'extensions/midbrain-memory/index.ts', 'extensions/midbrain-memory/runtime.mjs'].map(file => path.join(piDir, file)),
    path.join(home, '.config', 'pi', '.midbrain-key'),
    path.join(home, '.claude.json'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.codex', 'config.toml'),
    path.join(home, '.codex', 'hooks.json'),
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.cursor', 'hooks.json'),
    openclawConfig,
    path.join(openclawState, 'workspace', 'AGENTS.md'),
    openclawPlugin,
    ...['index.js', 'openclaw.plugin.json', 'package.json', 'midbrain-shared.mjs', '.midbrain-repo-root']
      .map((name) => path.join(openclawPlugin, name)),
    path.join(hermesHome, 'config.yaml'),
    path.join(opencodeDir, 'opencode.json'),
    path.join(opencodeDir, 'opencode.jsonc'),
    path.join(opencodeDir, 'plugins', 'midbrain-memory.ts'),
    path.join(opencodeDir, 'plugins', 'midbrain-shared.mjs'),
    path.join(opencodeDir, 'plugins', '.midbrain-repo-root'),
    // OpenCode cleanup targets (AC-13/AC-15): the legacy tree cleanup may
    // delete — the dir registers via the DIR sentinel so deletion is drift.
    path.join(opencodeDir, 'plugins', 'clients'),
    path.join(opencodeDir, 'plugins', 'logger.mjs'),
    path.join(opencodeDir, 'plugins', 'midbrain-api.mjs'),
    path.join(opencodeDir, 'plugins', 'midbrain-common.mjs'),
    path.join(home, '.midbrain', 'bin', 'claude-hook'),
    path.join(home, '.midbrain', 'bin', 'claude-hook.cmd'),
    path.join(home, '.midbrain', 'bin', 'codex-hook'),
    path.join(home, '.midbrain', 'bin', 'hermes-hook'),
    path.join(home, '.midbrain', 'bin', 'hermes-hook.cmd'),
    path.join(home, '.midbrain', 'bin', 'cursor-hook'),
    path.join(home, '.midbrain', 'bin', 'cursor-hook.cmd'),
    // NanoClaw installed-skill destinations (AC-15): every root the adapter
    // could resolve.
    ...nanoclawRoots.map((root) => path.join(root, NANOCLAW_SKILL_REL)),
    path.join(home, '.config', 'midbrain', '.midbrain-key'),
    path.join(home, '.config', 'claude', '.midbrain-key'),
    path.join(home, '.config', 'codex', '.midbrain-key'),
    path.join(home, '.config', 'opencode', '.midbrain-key'),
    path.join(home, '.config', 'hermes', '.midbrain-key'),
    path.join(home, '.config', 'nanoclaw', '.midbrain-key'),
    path.join(home, '.config', 'cursor', '.midbrain-key'),
    path.join(home, '.config', 'openclaw', '.midbrain-key'),
  ];
}
