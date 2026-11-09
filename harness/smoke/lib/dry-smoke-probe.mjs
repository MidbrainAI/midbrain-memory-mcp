// Runs in the existing harness's isolated home. No client/model prompt is ever sent.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { READ_RECOVERY_CASES } from './dry-smoke-recovery.mjs';
import { SMOKE_CASES } from './dry-smoke-cases.mjs';
import { createSmokeRecorder } from './dry-smoke-trace.mjs';
import { SMOKE_KEYS, SMOKE_TOOLS, redactSmoke } from './dry-smoke-fixture.mjs';
import { TOOL_CONTRACTS, checkToolSchema } from './tool-contracts.mjs';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const emitTrace = event => { if (input.tracePath) appendFileSync(input.tracePath, JSON.stringify(JSON.parse(redactSmoke(event))) + '\n'); };
const emitProtocol = event => { if (input.tracePath) appendFileSync(path.join(path.dirname(input.tracePath), 'protocol-events.ndjson'), JSON.stringify(JSON.parse(redactSmoke(event))) + '\n'); };
const recorder = createSmokeRecorder({ onEvent: emitTrace });
const evidence = { schemaVersion: 2, kind: input.entry.bridge ? 'installed Pi bridge driven by harness' : 'configured stdio driven by harness', checks: [], calls: recorder.calls, discoveries: [], stderr: '', protocolErrors: [] };
let client;
let activeCase; let connection = 0;
let transport; let shutdown; let call; let tools;
const text = result => (result.content || []).map(c => c.text || '').join('\n');
async function step(id, run) {
  const spec = SMOKE_CASES.find(c => c.id === id);
  if (!spec) throw new Error(`Unknown dry-smoke check: ${id}`);
  const started = Date.now();
  activeCase = id;
  try { await run(); evidence.checks.push({ ...spec, ok: true, detail: id === 'protocol' ? (evidence.protocolAudit?.compatibilityNotes || []).join(' ') : '', durationMs: Date.now() - started }); }
  catch (e) { evidence.checks.push({ ...spec, ok: false, detail: e.message, durationMs: Date.now() - started }); }
}
const invoke = (name, args = {}) => recorder.invoke(name, args, () => call(name, args), { caseId: activeCase, connection });
const write = (name, content) => { mkdirSync(path.dirname(name), { recursive: true }); writeFileSync(name, content, { mode: 0o600 }); };

async function expectFailure(name, args, pattern) {
  let result;
  try { result = await invoke(name, args); }
  catch (error) {
    // Pi intentionally translates MCP isError into a thrown native tool error.
    // Keep that rejection intact in the trace; verify the wire envelope separately.
    assert.ok(input.entry.bridge, `Expected MCP tool error, received transport rejection: ${error.message}`);
    assert.match(error.message, pattern); return;
  }
  assert.equal(result.isError, true, `${name}: expected explicit tool error (isError=true); received ${String(result.isError)}`); assert.match(text(result), pattern);
}
const faults = value => { assert.ok(input.faultFile, 'Missing isolated fixture fault controller'); write(input.faultFile, JSON.stringify(value)); };

async function connect() {
  connection++;
  if (input.entry.bridge) {
    const handlers = {}; const registered = [];
    const { registerMidbrain } = await import(pathToFileURL(input.entry.bridge));
    registerMidbrain({ on: (name, handler) => { handlers[name] = handler; }, registerTool: tool => registered.push(tool) }, input.entry);
    shutdown = () => handlers.session_shutdown();
    await handlers.session_start({}, { cwd: input.project, ui: { notify: message => { evidence.stderr += message; } } });
    tools = registered.map(tool => ({ name: tool.name.replace(/^midbrain_/, ''), exposedName: tool.name, description: tool.description, inputSchema: tool.parameters }));
    call = async (name, args) => {
      const tool = registered.find(t => t.name === `midbrain_${name}`);
      if (!tool) throw new Error(`Pi bridge did not register ${name}`);
      return tool.execute('dry-smoke', args);
    };
  } else {
    // Hermes expands this workspace placeholder at launch. The direct harness
    // probe supplies that context explicitly; native discovery is scored separately.
    const env = { ...process.env, ...input.entry.env };
    if (env.MIDBRAIN_PROJECT_DIR === '${TERMINAL_CWD}') env.MIDBRAIN_PROJECT_DIR = input.project;
    client = new Client({ name: 'midbrain-dry-smoke', version: '1.0.0' });
    client.onerror = error => { evidence.protocolErrors.push(error.message); };
    transport = new StdioClientTransport({ command: input.entry.command, args: input.entry.args,
      cwd: input.project, env, stderr: 'pipe' });
    transport.stderr?.on('data', data => { evidence.stderr += data.toString(); });
    await client.connect(transport, { timeout: 10000 });
    tools = (await client.listTools({}, { timeout: 10000 })).tools;
    call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
    shutdown = () => client.close();
  }
  const discovery = { connection, recordedAt: new Date().toISOString(), tools };
  evidence.discoveries.push(discovery);
  emitTrace({ type: 'tools.discovered', discovery });
}

try {
  await connect();
  await step('discovery', () => {
    assert.deepEqual(tools.map(t => t.name).sort(), SMOKE_TOOLS);
    assert.ok(tools.every(t => t.inputSchema.type === 'object'));
  });
  for (const spec of TOOL_CONTRACTS) {
    await step(`schema:${spec.name}`, () => assert.deepEqual(checkToolSchema(spec.name, tools.find(t => t.name === spec.name)?.inputSchema), []));
    if (spec.invalid) await step(`invalid:${spec.name}`, async () => {
      try {
        const response = await invoke(spec.name, spec.invalid);
        assert.equal(response.isError, true, `${spec.name}: invalid arguments must return isError=true; received ${String(response.isError)}`);
        assert.match(text(response), /invalid|validation|expected|required/i);
      } catch (error) {
        if (error.code === 'ERR_ASSERTION') throw error;
        assert.ok(error.code === -32602 || /invalid.*(?:argument|input)|validation|expected.*(?:string|boolean)/i.test(error.message), `Expected input validation, received: ${error.message}`);
      }
    });
  }
  await step('search', async () => {
    const result = await invoke('memory_search', { query: 'DRY_SMOKE Ω & exact', limit: 3, memory_type: 'semantic' });
    assert.notEqual(result.isError, true); assert.match(text(result), /fixture reply: DRY_SMOKE Ω & exact/); assert.match(text(result), /guide.md:2/);
  });
  await step('grep', async () => { assert.match(text(await invoke('grep', { pattern: 'fixture.*', memory_type: 'semantic', limit: 2 })), /guide.md:2: fixture lexical match/); });
  await step('date', async () => { assert.match(text(await invoke('get_episodic_memories_by_date', { date: '2026-01-01', offset_days: 2 })), /2026-01-01.*2026-01-03/); });
  await step('files', async () => {
    assert.match(text(await invoke('list_files')), /guide.md/);
    assert.match(text(await invoke('read_file', { file_path: 'guide.md', start_line: 2, num_lines: 1 })), /2: fixture file content/);
  });
  await step('session', async () => { assert.match(text(await invoke('check_session_status')), /No episodic memories/); });
  await step('diagnostics', async () => { assert.ok(text(await invoke('memory_diagnostics', { probe: false })).includes(input.apiUrl)); });
  await step('validation', async () => {
    for (const args of [{ query: 'invalid', limit: 0 }, { query: 'invalid', limit: 51 }, { query: 'invalid', limit: '3' }, { limit: 3 }]) {
      try { const result = await invoke('memory_search', args); assert.equal(result.isError, true); }
      catch (error) { if (error.code === 'ERR_ASSERTION') throw error; assert.match(error.message, /invalid|validation|greater|>=1|too_small|required|number/i); }
    }
  });
  await step('auth', async () => {
    await expectFailure('memory_search', { query: 'DRY_SMOKE_ERROR' }, /401/);
    assert.match(text(await invoke('memory_search', { query: 'DRY_SMOKE_EMPTY' })), /No memories found/);
  });
  await step('backend', async () => {
    for (const query of ['DRY_SMOKE_UNAVAILABLE', 'DRY_SMOKE_MALFORMED']) {
      await expectFailure('memory_search', { query }, /failed/i);
      assert.match(text(await invoke('memory_search', { query: 'DRY_SMOKE_EMPTY' })), /No memories found/);
    }
  });
  await step('fallback', async () => {
    assert.match(text(await invoke('memory_search', { query: 'DRY_SMOKE_FALLBACK', memory_type: 'semantic' })), /fixture legacy response/);
  });
  await step('credentials', async () => {
    const key = path.join(process.env.HOME, '.config/midbrain/.midbrain-key');
    const original = readFileSync(key, 'utf8');
    try {
      rmSync(key);
      await expectFailure('memory_search', { query: 'DRY_SMOKE_NO_KEY' }, /key|setup|configured/i);
      write(key, '');
      await expectFailure('memory_search', { query: 'DRY_SMOKE_EMPTY_KEY' }, /empty|key.*failed|failed.*key/i);
    } finally { write(key, original); }
    assert.match(text(await invoke('memory_search', { query: 'DRY_SMOKE_EMPTY' })), /No memories found/);
  });
  await step('account', async () => {
    assert.match(text(await invoke('set_user_api_key', { user_api_key: SMOKE_KEYS.user })), /saved/i);
    assert.match(text(await invoke('list_agents')), /dry-agent/);
    assert.match(text(await invoke('create_agent', { name: 'Dry smoke agent' })), /Created agent/);
    const store = JSON.parse(readFileSync(path.join(process.env.HOME, '.config/midbrain/.midbrain-keystore.json'), 'utf8'));
    assert.equal(store.agents['dry-agent'].agent_key, SMOKE_KEYS.minted);
  });
  for (const test of READ_RECOVERY_CASES) await step(`recovery:${test.name}`, async () => {
    faults([{ id: `recovery:${test.name}`, method: 'GET', path: `/api/v1${test.path}`, status: 503 }]);
    try {
      await expectFailure(test.name, test.args, /503/);
      assert.deepEqual(JSON.parse(readFileSync(input.faultFile, 'utf8')), []);
      const result = await invoke(test.name, test.args);
      assert.notEqual(result.isError, true); assert.match(text(result), test.contains);
    } finally { faults([]); }
  });
  await step('mint-rollback', async () => {
    const store = path.join(process.env.HOME, '.config/midbrain/.midbrain-keystore.json');
    const original = readFileSync(store, 'utf8');
    for (const rollbackFails of [false, true]) {
      faults([
        { id: 'mint-failure', method: 'POST', path: '/api/v1/account/keys', status: 503 },
        ...(rollbackFails ? [{ id: 'rollback-failure', method: 'DELETE', path: '/api/v1/account/agents/dry-mint-failure', status: 503 }] : []),
      ]);
      try {
        await expectFailure('create_agent', { name: 'Dry smoke failed mint' }, rollbackFails ? /dry-mint-failure.*rollback also failed/ : /rolled back/);
        assert.deepEqual(JSON.parse(readFileSync(input.faultFile, 'utf8')), []);
        assert.equal(readFileSync(store, 'utf8'), original);
        assert.match(text(await invoke('list_agents')), /dry-agent/);
      } finally { faults([]); }
    }
    const recovered = await invoke('create_agent', { name: 'Dry smoke agent' });
    assert.notEqual(recovered.isError, true); assert.match(text(recovered), /Created agent/);
  });
  await step('replace', async () => {
    const project = path.join(input.project, 'selected-agent'); mkdirSync(project, { recursive: true });
    const key = path.join(project, '.midbrain/.midbrain-key'); write(key, SMOKE_KEYS.project);
    await expectFailure('set_agent', { agent: 'dry-agent', project_dir: project }, /replace: true/);
    assert.equal(readFileSync(key, 'utf8').trim(), SMOKE_KEYS.project);
    assert.match(text(await invoke('set_agent', { agent: 'dry-agent', project_dir: project, replace: true })), /now set/);
    assert.equal(readFileSync(key, 'utf8').trim(), SMOKE_KEYS.minted);
  });
  await step('keystore', async () => {
    const file = path.join(process.env.HOME, '.config/midbrain/.midbrain-keystore.json');
    const original = readFileSync(file, 'utf8');
    try {
      write(file, '{invalid');
      await expectFailure('list_agents', {}, /corrupt|invalid|failed/i);
      assert.equal(readFileSync(file, 'utf8'), '{invalid');
    } finally { write(file, original); }
    assert.match(text(await invoke('list_agents')), /dry-agent/);
  });
  await step('setup', async () => {
    const project = path.join(input.project, 'setup'); mkdirSync(project, { recursive: true });
    assert.match(text(await invoke('memory_setup_project', { project_dir: project, api_key: SMOKE_KEYS.project })), /restart/i);
    assert.equal(readFileSync(path.join(project, '.midbrain/.midbrain-key'), 'utf8').trim(), SMOKE_KEYS.project);
    assert.equal(readFileSync(path.join(process.env.HOME, '.config/midbrain/.midbrain-key'), 'utf8').trim(), SMOKE_KEYS.global);
  });
  await step('precedence', async () => {
    write(path.join(input.project, '.midbrain/.midbrain-key'), SMOKE_KEYS.project);
    assert.match(text(await invoke('memory_search', { query: 'DRY_SMOKE_PROJECT' })), /fixture reply/);
  });
  await step('parallel', async () => {
    const queries = Array.from({ length: 6 }, (_, i) => `DRY_SMOKE_PARALLEL_${i} Ω & exact`);
    const results = await Promise.all(queries.map(query => invoke('memory_search', { query })));
    for (let i = 0; i < queries.length; i++) assert.ok(text(results[i]).includes(`fixture reply: ${queries[i]}`));
  });
  await step('disconnect', async () => {
    await expectFailure('memory_search', { query: 'DRY_SMOKE_DISCONNECT' }, /failed/i);
    assert.match(text(await invoke('memory_search', { query: 'DRY_SMOKE_EMPTY' })), /No memories found/);
  });
  await step('restart', async () => {
    await shutdown(); shutdown = null;
    await connect();
    assert.deepEqual(tools.map(t => t.name).sort(), SMOKE_TOOLS);
    assert.match(text(await invoke('memory_search', { query: 'DRY_SMOKE_RESTART' })), /fixture reply/);
    assert.match(text(await invoke('list_agents')), /dry-agent/);
  });
  await step('privacy', () => {
    const returned = JSON.stringify(evidence.calls.map(c => c.result));
    for (const key of Object.values(SMOKE_KEYS)) assert.ok(!returned.includes(key));
  });
} catch (error) { evidence.error = error.message; }
finally {
  await step('shutdown', async () => { if (shutdown) await shutdown(); else if (transport) await transport.close(); });
  await step('protocol', async () => {
    // A separate SDK connection audits the wire even when Pi owns its parser.
    // This remains harness-driven evidence, not a native-client interaction.
    const wire = new Client({ name: 'midbrain-dry-smoke-wire', version: '1.0.0' });
    wire.onerror = error => { evidence.protocolErrors.push(error.message); };
    const env = { ...process.env, ...input.entry.env, MIDBRAIN_DEV: input.entry.dev ? '1' : process.env.MIDBRAIN_DEV || '' };
    if (env.MIDBRAIN_PROJECT_DIR === '${TERMINAL_CWD}') env.MIDBRAIN_PROJECT_DIR = input.project;
    const stdio = new StdioClientTransport({ command: input.entry.command, args: input.entry.args, cwd: input.project, env, stderr: 'pipe' });
    stdio.stderr?.on('data', data => { evidence.stderr += data.toString(); });
    const audit = evidence.protocolAudit = { schemaVersion: 1, driver: 'harness SDK over configured stdio', exchanges: [], recovered: false };
    // The SDK invokes this optional transport hook only after validating the
    // server's initialize response. Record the actual negotiated version.
    stdio.setProtocolVersion = version => { audit.protocolVersion = version; };
    const exchange = async (method, params, run) => {
      const event = { method, params, startedAt: new Date().toISOString() };
      audit.exchanges.push(event);
      emitProtocol({ type: 'protocol.started', exchange: event });
      try { event.result = await run(); return event.result; }
      catch (error) { event.error = { code: error.code, message: error.message }; throw error; }
      finally { event.completedAt = new Date().toISOString(); emitProtocol({ type: 'protocol.finished', exchange: event }); }
    };
    try {
      await wire.connect(stdio, { timeout: 10000 });
      audit.serverInfo = wire.getServerVersion(); audit.capabilities = wire.getServerCapabilities();
      emitProtocol({ type: 'protocol.initialized', protocolVersion: audit.protocolVersion, serverInfo: audit.serverInfo, capabilities: audit.capabilities });
      assert.ok(audit.protocolVersion && audit.serverInfo?.name && audit.serverInfo?.version);
      assert.ok(audit.capabilities?.tools && typeof audit.capabilities.tools === 'object');
      const ping = () => exchange('ping', {}, () => wire.ping({ timeout: 10000 }));
      const list = () => exchange('tools/list', {}, () => wire.listTools({}, { timeout: 10000 }));
      await ping();
      const before = await list();
      assert.deepEqual(before.tools.map(t => t.name).sort(), SMOKE_TOOLS);
      assert.ok(!before.nextCursor, 'Fixed catalog unexpectedly requires pagination');
      await assert.rejects(exchange('dry-smoke/unsupported', {}, () => wire.request({ method: 'dry-smoke/unsupported', params: {} }, EmptyResultSchema, { timeout: 10000 })), error => error.code === -32601);
      const unknown = { name: 'dry_smoke_nonexistent_tool', arguments: {} };
      try {
        const result = await exchange('tools/call', unknown, () => wire.callTool(unknown, undefined, { timeout: 10000 }));
        assert.equal(result.isError, true);
        assert.match(text(result), /dry_smoke_nonexistent_tool.*not found|unknown tool/i);
        audit.compatibilityNotes = ['Unknown tool is returned as isError:true by the installed SDK, rather than the JSON-RPC error described by the MCP specification. This recovery check is not full protocol conformance.'];
      } catch (error) {
        assert.equal(error.code, -32602);
        audit.compatibilityNotes = [];
      }
      const failedSearch = { name: 'memory_search', arguments: { query: 'DRY_SMOKE_UNAVAILABLE' } };
      const failed = await exchange('tools/call', failedSearch, () => wire.callTool(failedSearch, undefined, { timeout: 10000 }));
      assert.equal(failed.isError, true, `memory_search: injected outage must return isError=true; received ${String(failed.isError)}`); assert.match(text(failed), /503/);
      const goodSearch = { name: 'memory_search', arguments: { query: 'DRY_SMOKE_EMPTY' } };
      const good = await exchange('tools/call', goodSearch, () => wire.callTool(goodSearch, undefined, { timeout: 10000 }));
      assert.notEqual(good.isError, true); assert.match(text(good), /No memories found/);
      await ping();
      assert.deepEqual(await list(), before, 'Tool catalog changed after rejected requests');
      audit.recovered = true;
    } finally { await wire.close(); await stdio.close(); }
    assert.deepEqual(evidence.protocolErrors, []);
  });
  console.log(JSON.stringify(evidence));
}
