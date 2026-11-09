// Codex app-server inventory API; never sends turn/start or another model operation.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { SMOKE_TOOLS } from './dry-smoke-fixture.mjs';

const child = spawn(process.argv[2], ['app-server', '--stdio'], { env: process.env, cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map(); let sequence = 0; let stderr = ''; const events = [];
child.stdin.on('error', error => { for (const p of pending.values()) p.reject(error); });
child.stderr.on('data', chunk => { stderr += chunk; });
const closed = new Promise(resolve => {
  child.once('error', error => { for (const p of pending.values()) p.reject(error); resolve(); });
  child.once('close', () => { for (const p of pending.values()) p.reject(new Error('Codex app-server exited')); resolve(); });
});
createInterface({ input: child.stdout }).on('line', line => {
  try {
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) pending.get(message.id).resolve(message);
    else if (message.method) events.push(message.method);
  } catch { stderr += `\nUnexpected stdout: ${line}`; }
});
const allowed = new Set(['initialize', 'mcpServerStatus/list']);
async function request(method, params) {
  if (!allowed.has(method)) throw new Error('Model-free Codex probe refused an unapproved method');
  const id = ++sequence;
  const response = await new Promise((resolve, reject) => {
    const finish = fn => value => { clearTimeout(timer); pending.delete(id); fn(value); };
    const timer = setTimeout(() => finish(reject)(new Error(`Codex ${method} timed out`)), 20000);
    pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  if (response.error) throw new Error(JSON.stringify(response.error));
  return response.result;
}
let receipt;
try {
  await request('initialize', { clientInfo: { name: 'midbrain_dry_smoke', version: '1.0.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const servers = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const result = await request('mcpServerStatus/list', { ...(cursor ? { cursor } : {}), limit: 100 });
    servers.push(...result.data);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  const midbrain = servers.find(s => s.name === 'midbrain-memory');
  const names = Object.keys(midbrain?.tools || {});
  const missing = SMOKE_TOOLS.filter(tool => !names.includes(tool));
  receipt = { ok: missing.length === 0, detail: missing.length ? `Codex native inventory did not expose: ${missing.join(', ')}` : 'Codex app-server connected and discovered all 12 MCP tools. No thread or model turn was created.', tools: names };
} catch (error) { receipt = { ok: false, blocked: /method not found|unknown variant|experimental/i.test(error.message), detail: error.message }; }
finally {
  child.stdin.end();
  const kill = setTimeout(() => child.kill('SIGKILL'), 2000);
  await closed; clearTimeout(kill);
}
console.log(JSON.stringify({ ...receipt, events, stderr }));
