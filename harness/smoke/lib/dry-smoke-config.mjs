import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as jsonc } from 'jsonc-parser';
import { parse as toml, stringify as tomlString } from 'smol-toml';
import { parse as yaml, stringify as yamlString } from 'yaml';

const peerScript = fileURLToPath(new URL('./dry-smoke-peer.mjs', import.meta.url));
const file = (ctx, rel) => path.join(ctx.dirs.home, rel);
const write = (name, value) => { mkdirSync(path.dirname(name), { recursive: true }); writeFileSync(name, value); };
const spec = {
  claude: { rel: '.claude.json', parse: JSON.parse, stringify: value => JSON.stringify(value, null, 2), section: 'mcpServers' },
  codex: { rel: '.codex/config.toml', parse: toml, stringify: tomlString, section: 'mcp_servers' },
  opencode: { rel: '.config/opencode/opencode.jsonc', parse: jsonc, stringify: value => '// Existing user configuration\n' + JSON.stringify(value, null, 2), section: 'mcp' },
  hermes: { rel: '.hermes/config.yaml', parse: yaml, stringify: yamlString, section: 'mcp_servers' },
};

/** Add a real, harmless sibling integration before installing MidBrain. */
export function seedSmokeConflict(ctx, id) {
  if (id === 'pi') {
    const target = file(ctx, '.pi/agent/extensions/dry-smoke-peer/index.ts');
    const content = 'export default function(pi) { pi.registerCommand("dry-smoke-peer", { description: "Dry smoke coexistence fixture", handler: async () => {} }); }\n';
    write(target, content);
    return { target, content };
  }
  const s = spec[id];
  if (!s) throw new Error(`No dry-smoke configuration adapter for ${id}`);
  const target = file(ctx, s.rel);
  const data = existsSync(target) ? s.parse(readFileSync(target, 'utf8')) : {};
  const peer = id === 'opencode' ? { type: 'local', command: [process.execPath, peerScript], enabled: true }
    : { command: process.execPath, args: [peerScript] };
  data[s.section] ||= {};
  data[s.section]['dry-smoke-peer'] = peer;
  write(target, s.stringify(data));
  return { target, section: s.section, peer };
}

export function smokeConflictPreserved(id, sentinel) {
  if (id === 'pi') return readFileSync(sentinel.target, 'utf8') === sentinel.content;
  const parsed = spec[id].parse(readFileSync(sentinel.target, 'utf8'));
  return JSON.stringify(parsed[sentinel.section]?.['dry-smoke-peer']) === JSON.stringify(sentinel.peer);
}

/** Read what the real installer wrote. Never substitute a hard-coded launch command. */
export function installedSmokeEntry(ctx, id) {
  if (id === 'pi') {
    const dir = file(ctx, '.pi/agent/extensions/midbrain-memory');
    const source = readFileSync(path.join(dir, 'index.ts'), 'utf8');
    const options = source.match(/registerMidbrain\(pi, (\{.*\})\)/);
    if (!options) throw new Error('Cannot read installed Pi bridge options');
    return { ...JSON.parse(options[1]), bridge: path.join(dir, 'runtime.mjs'), env: { MIDBRAIN_CLIENT: 'pi' } };
  }
  const s = spec[id];
  const data = s.parse(readFileSync(file(ctx, s.rel), 'utf8'));
  const entry = data[s.section]?.['midbrain-memory'];
  if (!entry || entry.enabled === false) throw new Error(`Missing or disabled MidBrain entry in ${s.rel}`);
  if (id === 'opencode') return { command: entry.command[0], args: entry.command.slice(1), env: entry.environment || {} };
  return { command: entry.command, args: entry.args || [], env: entry.env || {} };
}

/** Instrument only the launch command in a run-owned integration; preserve its env. */
export function instrumentSmokeEntry(ctx, id, command, args) {
  const target = id === 'pi' ? file(ctx, '.pi/agent/extensions/midbrain-memory/index.ts') : file(ctx, spec[id].rel);
  const original = readFileSync(target, 'utf8');
  if (id === 'pi') {
    const match = original.match(/registerMidbrain\(pi, (\{.*\})\)/);
    if (!match) throw new Error('Cannot instrument installed Pi bridge');
    const options = { ...JSON.parse(match[1]), command, args };
    write(target, original.replace(match[0], `registerMidbrain(pi, ${JSON.stringify(options)})`));
  } else {
    const s = spec[id]; const data = s.parse(original); const entry = data[s.section]['midbrain-memory'];
    if (id === 'opencode') entry.command = [command, ...args];
    else { entry.command = command; entry.args = args; }
    write(target, s.stringify(data));
  }
  return () => write(target, original);
}
