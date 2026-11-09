import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../mcp.mjs';
import { makeTestEnv } from './helpers/test-env.mjs';

let env; let server; let client; let fetchSpy;
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
beforeEach(async () => {
  env = await makeTestEnv({ env: { MIDBRAIN_API_KEY: 'error-envelope-agent-fixture', MIDBRAIN_CLIENT: 'generic' } });
  vi.stubEnv('MIDBRAIN_USER_API_KEY', 'error-envelope-user-fixture');
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ detail: 'controlled outage' }, 503));
  server = createServer('test');
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); client = new Client({ name: 'error-envelope-tests', version: '1' }); await client.connect(ct);
});
afterEach(async () => {
  await client?.close(); await server?.close();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); await env?.restore();
});
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const assertError = result => { expect(result.isError).toBe(true); expect(result.content[0]).toMatchObject({ type: 'text', text: expect.any(String) }); expect(result.content[0].text.length).toBeGreaterThan(0); };

describe('machine-readable MCP operational failures', () => {
  it.each([
    ['memory_search', { query: 'outage' }], ['grep', { pattern: 'outage' }],
    ['get_episodic_memories_by_date', { date: '2026-01-01' }], ['list_files', {}],
    ['read_file', { file_path: 'guide.md' }], ['check_session_status', {}],
    ['list_agents', {}], ['create_agent', { name: 'Requested fixture agent' }],
  ])('%s returns an error envelope and keeps the connection usable', async (name, args) => {
    assertError(await call(name, args));
    expect(fetchSpy).toHaveBeenCalled();
    await expect(client.ping()).resolves.toEqual({});
    fetchSpy.mockResolvedValue(response([]));
    const recovered = await call('list_files');
    expect(recovered.isError).not.toBe(true);
    expect(recovered.content[0].text).toContain('No files found');
  });
  it('marks invalid dates and setup paths as errors before side effects', async () => {
    assertError(await call('get_episodic_memories_by_date', { date: 'not-a-date' }));
    assertError(await call('memory_setup_project', { project_dir: 'relative/path' }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('marks missing file content and invalid regex as errors', async () => {
    fetchSpy.mockResolvedValue(response({ detail: 'Not found' }, 404));
    assertError(await call('read_file', { file_path: 'missing.md' }));
    fetchSpy.mockResolvedValue(response({ detail: 'Invalid regex' }, 400));
    assertError(await call('grep', { pattern: '[invalid' }));
  });
  it('marks unknown agent selection as an error without writing a project key', async () => {
    assertError(await call('set_agent', { agent: 'unknown-agent', project_dir: env.root }));
    expect(fs.existsSync(path.join(env.root, '.midbrain/.midbrain-key'))).toBe(false);
  });
  it('marks credential-store failure as an error and preserves the corrupt store', async () => {
    const store = path.join(env.home, '.config/midbrain/.midbrain-keystore.json');
    fs.mkdirSync(path.dirname(store), { recursive: true }); fs.writeFileSync(store, '{corrupt');
    assertError(await call('set_user_api_key', { user_api_key: 'new-fixture-key' }));
    expect(fs.readFileSync(store, 'utf8')).toBe('{corrupt');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('keeps successful empty searches distinct from operational failures', async () => {
    fetchSpy.mockResolvedValue(response([]));
    for (const [name, args] of [['memory_search', { query: 'empty' }], ['grep', { pattern: 'empty' }], ['list_files', {}]]) {
      expect((await call(name, args)).isError).not.toBe(true);
    }
  });
});
