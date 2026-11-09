// Stable IDs are the evidence contract. Display names may change without changing scoring.
import { READ_RECOVERY_CASES } from './dry-smoke-recovery.mjs';
import { TOOL_CONTRACTS } from './tool-contracts.mjs';
const transport = 'Configured MCP transport';
const contracts = 'MCP tool contracts';
const recovery = 'MCP failure recovery';
const isolation = 'Project and global isolation';
export const SMOKE_CASES = [
  ...TOOL_CONTRACTS.map(t => [`schema:${t.name}`, contracts, `${t.name}: argument schema matches the reviewed contract`]),
  ...TOOL_CONTRACTS.filter(t => t.invalid).map(t => [`invalid:${t.name}`, contracts, `${t.name}: invalid argument types are rejected`]),
  ...READ_RECOVERY_CASES.map(t => [`recovery:${t.name}`, recovery, `${t.name}: explicit tool error on outage, then same-connection recovery`]),
  ['mint-rollback', recovery, 'Failed key minting rolls back the new agent; cleanup failures identify the orphan'],
  ['discovery', transport, 'All expected tools expose object schemas'],
  ['protocol', transport, 'MCP initialization, capabilities, ping and recovery from unsupported requests'],
  ['search', contracts, 'Search preserves Unicode, exact query and source location'],
  ['grep', contracts, 'Lexical search returns source and line number'],
  ['date', contracts, 'Date lookup preserves the explicit range'],
  ['files', contracts, 'File listing and line-range reads'],
  ['session', contracts, 'Empty session status is handled'],
  ['diagnostics', contracts, 'Diagnostics report the configured host'],
  ['validation', recovery, 'Invalid arguments are rejected'],
  ['auth', recovery, 'Authentication failure is visible and the next call succeeds'],
  ['backend', recovery, 'Unavailable and malformed responses do not kill the server'],
  ['fallback', recovery, 'Legacy GET-to-POST fallback succeeds'],
  ['credentials', recovery, 'Missing and empty keys fail visibly, then recover'],
  ['account', contracts, 'User key, agent creation and key minting use the account contract'],
  ['replace', isolation, 'Project key replacement requires explicit permission'],
  ['keystore', recovery, 'Corrupt account store fails closed without replacement'],
  ['setup', isolation, 'Project setup preserves the global credential'],
  ['precedence', isolation, 'Project credential takes precedence'],
  ['parallel', contracts, 'Concurrent requests retain their own responses'],
  ['disconnect', recovery, 'Backend connection loss is visible and recoverable'],
  ['restart', transport, 'Fresh MCP process discovers tools and uses persisted project state'],
  ['privacy', contracts, 'Tool responses do not disclose credentials'],
  ['shutdown', transport, 'MCP transport closes cleanly'],
].map(([id, row, name]) => ({ id, row, name }));

export function validateProbeEvidence(value) {
  const problems = [];
  if (value?.schemaVersion !== 2) problems.push('Missing or unsupported probe schema version');
  const checks = Array.isArray(value?.checks) ? value.checks : [];
  for (const expected of SMOKE_CASES) {
    const matching = checks.filter(c => c?.id === expected.id);
    if (matching.length !== 1) problems.push(`${expected.id}: expected one result, received ${matching.length}`);
    else if (typeof matching[0].ok !== 'boolean') problems.push(`${expected.id}: result is not a boolean`);
  }
  for (const actual of checks) if (!SMOKE_CASES.some(c => c.id === actual?.id)) problems.push(`Unexpected check: ${actual?.id}`);
  return { id: 'evidence-integrity', name: 'Complete, uniquely identified probe evidence', ok: problems.length === 0, detail: problems.join('; ') };
}

export function probeChecksForRow(evidence, row) {
  return SMOKE_CASES.filter(c => c.row === row).map(expected => {
    const matching = evidence?.checks?.filter(c => c.id === expected.id) || [];
    const actual = matching.length === 1 ? matching[0] : null;
    return { ...expected, ok: actual?.ok === true, detail: actual ? String(actual.detail || '') : 'Required check was not recorded exactly once', durationMs: actual?.durationMs };
  });
}
