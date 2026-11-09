// Real-home isolation check. Reuses the Vitest tripwire's surface list and adds
// the surfaces a LIVE client can touch. ~/.claude.json and ~/.claude/settings.json
// are compared semantically (only MidBrain-relevant keys) because a live host
// Claude session legitimately rewrites other keys in those files.
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tripwireSurfaces } from './surfaces.mjs';

const SEMANTIC = {
  '.claude.json': (json) => ({
    mcpServers: json.mcpServers ?? null,
    projects: Object.fromEntries(
      Object.entries(json.projects || {})
        .filter(([, v]) => v && v.mcpServers && Object.keys(v.mcpServers).length > 0)
        .map(([k, v]) => [k, v.mcpServers]),
    ),
  }),
  '.claude/settings.json': (json) => ({ hooks: json.hooks ?? null, permissions: json.permissions ?? null }),
};

export function extraSurfaces(home) {
  return [
    '.claude/.credentials.json',
    '.claude/CLAUDE.md',
    '.claude/.midbrain-capture-client',
    '.codex/auth.json',
    '.codex/AGENTS.md',
    '.npmrc',
    '.config/opencode/AGENTS.md',
    '.hermes/SOUL.md',
    '.config/midbrain/config.json',
    '.config/midbrain/.midbrain-keystore.json',
    '.midbrain-key',
  ].map((r) => path.join(home, r));
}

export function allSurfaces(home = os.homedir()) {
  return [...new Set([...tripwireSurfaces(home), ...extraSurfaces(home)])];
}

function hashOf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function hashSurface(file, home) {
  if (!existsSync(file)) return 'ABSENT';
  let st;
  try { st = statSync(file); } catch { return 'UNREADABLE'; }
  if (st.isDirectory()) return 'DIR';
  let content;
  try { content = readFileSync(file); } catch { return 'UNREADABLE'; }
  const rel = path.relative(home, file).split(path.sep).join('/');
  const sem = SEMANTIC[rel];
  if (sem) {
    try {
      return `semantic:${hashOf(JSON.stringify(sem(JSON.parse(content.toString('utf8')))))}`;
    } catch {
      return `raw:${hashOf(content)}`;
    }
  }
  return `raw:${hashOf(content)}`;
}

export function snapshot(home = os.homedir()) {
  const hashes = {};
  for (const f of allSurfaces(home)) hashes[f] = hashSurface(f, home);
  return { home, takenAt: new Date().toISOString(), hashes };
}

export function diff(before, after) {
  const drift = [];
  const keys = new Set([...Object.keys(before.hashes), ...Object.keys(after.hashes)]);
  for (const k of keys) {
    const a = before.hashes[k] ?? 'ABSENT';
    const b = after.hashes[k] ?? 'ABSENT';
    if (a !== b) drift.push({ surface: k, before: a.slice(0, 24), after: b.slice(0, 24) });
  }
  return drift;
}

/** Does the harness key hash-match any key file in the real home? (never logs contents) */
export function keyCollidesWithRealHome(key, home = os.homedir()) {
  const files = [
    '.config/midbrain/.midbrain-key',
    '.config/claude/.midbrain-key',
    '.config/codex/.midbrain-key',
    '.config/opencode/.midbrain-key',
    '.config/hermes/.midbrain-key',
    '.config/nanoclaw/.midbrain-key',
    '.config/pi/.midbrain-key',
  ].map((r) => path.join(home, r));
  const target = hashOf(String(key).trim());
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      if (hashOf(readFileSync(f, 'utf8').trim()) === target) return f;
    } catch { /* unreadable: ignore */ }
  }
  return null;
}
