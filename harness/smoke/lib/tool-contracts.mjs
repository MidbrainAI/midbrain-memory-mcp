// Reviewed contract baseline. Keep separate from product code so a breaking
// schema change cannot silently update its own expected result.
const string = { type: 'string' };
const integer = (minimum, maximum, value) => ({ type: 'integer', minimum, ...(maximum === null ? {} : { maximum }), default: value });
const memoryType = { type: 'string', enum: ['all', 'semantic', 'episodic'], default: 'all' };
export const TOOL_CONTRACTS = [
  { name: 'memory_search', positive: 'search', recovery: ['auth', 'backend', 'credentials', 'disconnect'], required: ['query'], properties: { query: string, limit: integer(1, 50, 10), memory_type: memoryType }, invalid: { query: 17 } },
  { name: 'grep', recovery: ['recovery:grep'], positive: 'grep', required: ['pattern'], properties: { pattern: string, source: string, limit: integer(1, 500, 50), memory_type: memoryType }, invalid: { pattern: 17 } },
  { name: 'get_episodic_memories_by_date', recovery: ['recovery:get_episodic_memories_by_date'], positive: 'date', required: ['date'], properties: { date: string, offset_days: integer(1, null, 1) }, invalid: { date: 17 } },
  { name: 'list_files', recovery: ['recovery:list_files'], positive: 'files', required: [], properties: {} },
  { name: 'read_file', recovery: ['recovery:read_file'], positive: 'files', required: ['file_path'], properties: { file_path: string, start_line: integer(1, null, 1), num_lines: integer(1, 5000, 200) }, invalid: { file_path: 17 } },
  { name: 'check_session_status', recovery: ['recovery:check_session_status'], positive: 'session', required: [], properties: {} },
  { name: 'memory_diagnostics', positive: 'diagnostics', required: [], properties: { probe: { type: 'boolean', default: true } }, invalid: { probe: 'yes' } },
  { name: 'memory_setup_project', positive: 'setup', required: ['project_dir'], properties: { project_dir: string, api_key: string }, invalid: { project_dir: 17 } },
  { name: 'list_agents', positive: 'account', recovery: ['keystore', 'recovery:list_agents'], required: [], properties: {} },
  { name: 'create_agent', recovery: ['mint-rollback'], positive: 'account', required: ['name'], properties: { name: string, description: string }, invalid: { name: 17 } },
  { name: 'set_agent', positive: 'replace', recovery: ['replace'], required: ['agent', 'project_dir'], properties: { agent: string, project_dir: string, replace: { type: 'boolean' } }, invalid: { agent: 17, project_dir: 17 } },
  { name: 'set_user_api_key', positive: 'account', required: ['user_api_key'], properties: { user_api_key: string }, invalid: { user_api_key: 17 } },
];

export function checkToolSchema(name, schema) {
  const expected = TOOL_CONTRACTS.find(t => t.name === name);
  if (!expected) return [`Unknown tool ${name}`];
  return checkSchemaContract(expected, schema);
}

export function checkSchemaContract(expected, schema) {
  const issues = [];
  if (schema?.type !== 'object') issues.push('Input schema must be an object');
  if (JSON.stringify(Object.keys(schema?.properties || {}).sort()) !== JSON.stringify(Object.keys(expected.properties).sort())) issues.push('Argument names changed');
  if (JSON.stringify([...(schema?.required || [])].sort()) !== JSON.stringify([...expected.required].sort())) issues.push('Required arguments changed');
  for (const [key, fields] of Object.entries(expected.properties)) for (const [field, value] of Object.entries(fields)) {
    if (JSON.stringify(schema?.properties?.[key]?.[field]) !== JSON.stringify(value)) issues.push(`${key}.${field}: expected ${JSON.stringify(value)}`);
  }
  return issues;
}

export function textEnvelope(result) {
  return result?.isError !== true && Array.isArray(result?.content) && result.content.length > 0 && result.content.every(c => c.type === 'text' && typeof c.text === 'string');
}

export function toolCoverage({ checks = [], calls = [], discoveries = [] } = {}) {
  const status = id => { const found = checks.filter(c => c.id === id); return found.length === 0 ? 'NOT RECORDED' : found.length === 1 && found[0].ok === true ? 'PASS' : 'FAIL'; };
  return TOOL_CONTRACTS.map(tool => {
    const observed = calls.filter(c => c.name === tool.name && c.caseId === tool.positive);
    const positive = status(tool.positive) === 'NOT RECORDED' || !observed.length ? 'NOT RECORDED' : status(tool.positive) === 'PASS' && observed.some(c => c.status === 'returned' && textEnvelope(c.result)) ? 'PASS' : 'FAIL';
    const recovery = tool.recovery?.map(status);
    return { name: tool.name, discovered: discoveries.some(d => d.tools?.some(t => t.name === tool.name)), schema: status(`schema:${tool.name}`), positive,
      invalid: tool.invalid ? status(`invalid:${tool.name}`) : 'N/A — no arguments',
      recovery: !recovery ? 'NOT COVERED' : recovery.every(s => s === 'PASS') ? 'PASS' : recovery.includes('FAIL') ? 'FAIL' : 'NOT RECORDED',
      calls: calls.filter(c => c.name === tool.name).map(c => c.id),
    };
  });
}

export function reportToolCoverage(report, client) {
  const preview = report.contextPreviews?.[client];
  return toolCoverage({ checks: report.cells.filter(c => c.client === client).flatMap(c => c.checks || []), calls: preview?.calls || [], discoveries: preview?.discoveries || [] });
}
