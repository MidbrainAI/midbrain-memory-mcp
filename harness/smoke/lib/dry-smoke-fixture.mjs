import http from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const SMOKE_KEYS = { global: 'mb-dry-smoke-global-fixture', project: 'mb-dry-smoke-project-fixture', user: 'sk-dry-smoke-user-fixture', minted: 'mb-dry-smoke-minted-fixture' };
export const SMOKE_TOOLS = ['check_session_status', 'create_agent', 'get_episodic_memories_by_date', 'grep', 'list_agents', 'list_files', 'memory_diagnostics', 'memory_search', 'memory_setup_project', 'read_file', 'set_agent', 'set_user_api_key'];

export function redactSmoke(value) {
  let result = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  for (const key of Object.values(SMOKE_KEYS)) result = result.split(key).join('[synthetic key]');
  return result;
}

/** No storage or retrieval engine. Only explicit, recorded HTTP contracts. */
export async function startSmokeApi({ allowCapture = false, faultFile } = {}) {
  const requests = []; const unexpected = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : null;
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const key = Object.keys(SMOKE_KEYS).find(k => SMOKE_KEYS[k] === token) || 'unknown';
      const row = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, key };
      requests.push(row);
      const send = (value, status = 200) => { row.status = status; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      const account = url.pathname.startsWith('/api/v1/account/');
      if (key === 'unknown' || (account ? key !== 'user' : key === 'user')) return send({ detail: 'fixture auth rejected' }, 401);
      const p = url.pathname; const get = req.method === 'GET';
      if (faultFile && existsSync(faultFile)) {
        const faults = JSON.parse(readFileSync(faultFile, 'utf8'));
        const index = faults.findIndex(f => f.method === req.method && f.path === p);
        if (index >= 0) {
          const [fault] = faults.splice(index, 1);
          writeFileSync(faultFile, JSON.stringify(faults));
          row.injectedFault = fault.id;
          return send({ detail: `controlled fixture failure: ${fault.id}` }, fault.status);
        }
      }
      if (allowCapture && req.method === 'POST' && p === '/api/v1/memories/episodic') { row.kind = 'capture-discarded'; return send({ id: 'discarded-scripted-capture' }); }
      if (get && p === '/api/v1/memories/search/semantic') {
        const query = url.searchParams.get('query');
        if (query === 'DRY_SMOKE_DISCONNECT') { row.status = 'connection-reset'; req.socket.destroy(); return; }
        if (query?.startsWith('DRY_SMOKE_PARALLEL_')) await new Promise(resolve => setTimeout(resolve, (6 - Number(query.match(/PARALLEL_(\d)/)[1])) * 12));
        if (query === 'DRY_SMOKE_ERROR') return send({ detail: 'intentional fixture failure' }, 401);
        if (query === 'DRY_SMOKE_UNAVAILABLE') return send({ detail: 'intentional fixture outage' }, 503);
        if (query === 'DRY_SMOKE_MALFORMED') { row.status = 200; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{invalid'); }
        if (query === 'DRY_SMOKE_FALLBACK') return send({ detail: 'legacy endpoint' }, 405);
        if (query === 'DRY_SMOKE_EMPTY') return send([]);
        return send([{ role: 'external', text: `fixture reply: ${query}`, score: 0.8, occurred_at: '2026-01-01T12:00:00Z', memory_metadata: { source: 'guide.md', line_start: 2 } }]);
      }
      if (req.method === 'POST' && p === '/api/v1/memories/search/semantic' && body.query === 'DRY_SMOKE_FALLBACK') return send([{ role: 'external', text: 'fixture legacy response', score: 0.8 }]);
      if (get && p === '/api/v1/memories/search/lexical') return send([{ source: 'guide.md', line_number: 2, text: 'fixture lexical match' }]);
      if (get && p === '/api/v1/memories/episodic') return send({ items: [], total: 0 });
      if (get && p === '/api/v1/memories/semantic/files') return send([{ source: 'guide.md', chunk_count: 1 }]);
      if (get && p === '/api/v1/memories/semantic/files/guide.md') return send({ path: 'guide.md', start_line: 2, content: '2: fixture file content' });
      if (get && p === '/api/v1/account/agents') return send([{ agent_id: 'dry-agent', name: 'Dry smoke agent' }]);
      if (req.method === 'POST' && p === '/api/v1/account/agents') return send({ agent_id: body.name === 'Dry smoke failed mint' ? 'dry-mint-failure' : 'dry-agent', name: body.name });
      if (req.method === 'POST' && p === '/api/v1/account/keys' && body.agent_id === 'dry-agent') return send({ key: SMOKE_KEYS.minted });
      if (req.method === 'DELETE' && ['/api/v1/account/agents/dry-agent', '/api/v1/account/agents/dry-mint-failure'].includes(p)) return send(null);
      unexpected.push(row); return send({ detail: 'unexpected dry-smoke request' }, 500);
    } catch (error) { unexpected.push({ error: error.message }); res.writeHead(500); res.end('fixture failure'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests, unexpected,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
