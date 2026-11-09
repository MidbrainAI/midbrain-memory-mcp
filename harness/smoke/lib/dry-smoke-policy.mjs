import { childEnv } from './context.mjs';

export const DRY_SMOKE_CLIENTS = ['opencode', 'claude', 'codex', 'hermes', 'pi'];
export const DRY_SMOKE_ROWS = ['Clean install', 'Configuration preservation', 'Configured MCP transport', 'MCP tool contracts', 'MCP failure recovery', 'Project and global isolation', 'Native client discovery', 'Reproducibility'];
export const DRY_SMOKE_SCOPE = 'Dry-smoke: zero model prompts; synthetic credentials and a local fixture API. Direct MCP/bridge checks are harness-driven. Native client evidence is labelled separately. Memory quality, model tool selection, native capture events, upgrades and arbitrary third-party conflicts are not verified.';

export function validateDrySmokeFlags(flags) {
  const allowed = new Set(['_', 'clients', 'root', 'install-clients', 'candidate-tarball', 'candidate-sha256', 'candidate-version', 'candidate-source-sha']);
  for (const key of Object.keys(flags)) if (!allowed.has(key)) throw new Error(`dry-smoke does not accept --${key}; use the behavioral run command for model-backed scenarios`);
  if (flags._?.length) throw new Error('dry-smoke does not accept positional arguments');
  for (const key of ['clients', 'root']) if (flags[key] !== undefined && (typeof flags[key] !== 'string' || !flags[key].trim())) throw new Error(`dry-smoke --${key} requires a value`);
  if (flags['install-clients'] !== undefined && flags['install-clients'] !== true) throw new Error('dry-smoke --install-clients is a boolean flag');
  const archiveKeys=['candidate-sha256','candidate-version','candidate-source-sha'];
  if(!flags['candidate-tarball']&&archiveKeys.some(key=>flags[key]!==undefined))throw new Error('Candidate identity requires --candidate-tarball');
  if(flags['candidate-tarball']!==undefined){
    if(typeof flags['candidate-tarball']!=='string'||!flags['candidate-tarball'].trim())throw new Error('Candidate tarball requires a local path');
    if(!/^[a-f0-9]{64}$/.test(flags['candidate-sha256']||''))throw new Error('Candidate requires its exact lowercase SHA-256');
    if(flags['candidate-source-sha']!==undefined&&!/^[a-f0-9]{40}$/.test(flags['candidate-source-sha']))throw new Error('Candidate source SHA must be a full commit');
    if(flags['candidate-version']!==undefined&&(typeof flags['candidate-version']!=='string'||!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(flags['candidate-version'])))throw new Error('Candidate version must be explicit semver');
  }
}

export function smokeEnv(ctx, extra = {}) {
  return childEnv(ctx, {
    // Honor existing credential-writer guards, but never reuse real host login/config.
    MIDBRAIN_TEST_SANDBOX: ctx.dirs.home, MIDBRAIN_ENABLE_PK_INJECTION: undefined,
    APPDATA: `${ctx.dirs.home}/AppData/Roaming`, LOCALAPPDATA: `${ctx.dirs.home}/AppData/Local`,
    ...extra,
  });
}

export function nativeProbe(id) {
  return {
    claude: { args: ['mcp', 'list'], level: 'connection' },
    codex: { args: ['app-server', '--stdio'], level: 'discovery' },
    opencode: { args: ['mcp', 'list'], level: 'connection' },
    hermes: { args: ['mcp', 'test', 'midbrain-memory'], level: 'discovery' },
    pi: { args: [], level: 'installed SDK runtime' },
  }[id] || null;
}

export function missingSmokeCoverage(cells, clientIds) {
  return clientIds.flatMap(client => DRY_SMOKE_ROWS.filter(row => !cells.some(c => c.client === client && c.row === row)).map(row => ({ client, row })));
}

export function drySmokeExitCode(cells, isolationOk, complete, clientIds = []) {
  const covered = missingSmokeCoverage(cells, clientIds).length === 0;
  const asserted = !clientIds.length || cells.every(c => c.checks?.length && c.checks.every(ch => ch.ok === true));
  return complete && isolationOk && covered && asserted && cells.length > 0 && cells.every(c => c.status === 'PASS') ? 0 : 1;
}

export function drySmokeOutcome(cells, isolationOk, complete, clientIds = []) {
  if (!complete) return 'INCOMPLETE';
  if (!isolationOk || cells.some(c => c.status === 'FAIL' || (c.status === 'PASS' && c.checks?.some(ch => ch.ok !== true)))) return 'FAIL';
  return drySmokeExitCode(cells, isolationOk, complete, clientIds) ? 'BLOCKED' : 'PASS';
}
