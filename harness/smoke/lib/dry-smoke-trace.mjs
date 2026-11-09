import { SMOKE_CASES } from './dry-smoke-cases.mjs';
import { redactSmoke } from './dry-smoke-fixture.mjs';

/** Preserve requests at invocation time, including rejected and concurrent calls. */
export function createSmokeRecorder({ onEvent = () => {} } = {}) {
  const calls = [];
  return {
    calls,
    async invoke(name, args, run, context = {}) {
      const start = Date.now();
      const entry = { id: `call-${calls.length + 1}`, name, args: JSON.parse(JSON.stringify(args)), ...context,
        startedAt: new Date(start).toISOString(), status: 'pending' };
      calls.push(entry);
      onEvent({ type: 'call.started', call: entry });
      try {
        const result = await run();
        entry.result = result;
        entry.status = result?.isError === true ? 'tool-error' : 'returned';
        return result;
      } catch (error) {
        entry.status = 'rejected';
        entry.error = { message: error.message, ...(error.code === undefined ? {} : { code: error.code }) };
        throw error;
      } finally {
        entry.completedAt = new Date().toISOString();
        entry.durationMs = Date.now() - start;
        onEvent({ type: 'call.finished', call: entry });
      }
    },
  };
}

export const SMOKE_PREVIEW_SCOPE = 'Observed MCP context preview, not a native model request. These definitions, arguments and results were recorded from harness-driven checks. No model request was created or sent. Native system prompts, conversation assembly, tokenization and provider formatting are not captured. Synthetic credentials are redacted. A returned result is not necessarily a successful tool operation; inspect its content and the test assertions.';

export function buildSmokeContextPreview(client, evidence, { complete = true } = {}) {
  const calls = (evidence.calls || []).map(call => {
    const spec = SMOKE_CASES.find(c => c.id === call.caseId);
    const result = evidence.checks?.find(c => c.id === call.caseId);
    return { ...call, scenario: spec ? { id: spec.id, name: spec.name, outcome: result ? result.ok === true ? 'PASS' : 'FAIL' : 'NOT RECORDED' } : null };
  });
  const issues = evidence.issues || [];
  const discoveries = evidence.discoveries || [];
  return JSON.parse(redactSmoke({ schemaVersion: 1, kind: 'mcp-context-preview', client, scope: SMOKE_PREVIEW_SCOPE,
    modelRequest: { created: false, sent: false }, recordingComplete: complete && !issues.length && discoveries.length > 0 && calls.length > 0 && calls.every(c => c.status !== 'pending'),
    protocolAudit: evidence.protocolAudit, source: evidence.kind || 'harness-driven MCP probe', discoveries, calls, issues,
  }));
}

/** Recover valid records while making damage, duplication and request changes explicit. */
export function replaySmokeTrace(events) {
  const calls = new Map(); const discoveries = []; const issues = [];
  const request = call => JSON.stringify([call.name, call.args, call.caseId, call.connection]);
  for (const [index, event] of events.entries()) {
    const problem = message => issues.push(`Event ${index + 1}: ${message}`);
    if (event?.type === 'tools.discovered') {
      const d = event.discovery;
      if (!Number.isInteger(d?.connection) || !Array.isArray(d.tools) || discoveries.some(v => v.connection === d.connection)) problem('Invalid or duplicate discovery');
      else discoveries.push(d);
      continue;
    }
    const c = event?.call;
    if (!['call.started', 'call.finished'].includes(event?.type) || typeof c?.id !== 'string' || typeof c.name !== 'string' || !c.args || typeof c.args !== 'object' || Array.isArray(c.args)) { problem('Unrecognized or malformed event'); continue; }
    const previous = calls.get(c.id);
    if (event.type === 'call.started') {
      if (previous || c.status !== 'pending') problem(`Invalid or duplicate start for ${c.id}`);
      else calls.set(c.id, c);
    } else {
      if (!previous || previous.status !== 'pending') problem(`Orphaned or duplicate finish for ${c.id}`);
      else if (request(previous) !== request(c)) problem(`Request changed for ${c.id}`);
      else if (!['returned', 'tool-error', 'rejected'].includes(c.status) || (c.status === 'rejected' ? !c.error : !c.result)) problem(`Invalid result for ${c.id}`);
      else calls.set(c.id, c);
    }
  }
  return { discoveries, calls: [...calls.values()], issues };
}

export function parseSmokeTrace(text) {
  const events = []; const issues = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); }
    catch { issues.push(`Line ${index + 1}: incomplete or invalid JSON; other valid records were retained`); }
  }
  const trace = replaySmokeTrace(events);
  trace.issues.push(...issues);
  return trace;
}

export function smokePreviewStats(preview) {
  const counts = { returned: 0, 'tool-error': 0, rejected: 0, pending: 0 };
  for (const call of preview.calls) counts[call.status] = (counts[call.status] || 0) + 1;
  return { attempts: preview.calls.length, tools: new Set(preview.discoveries.flatMap(d => d.tools.map(t => t.name))).size, connections: preview.discoveries.length, ...counts };
}

export function renderSmokeContextMarkdown(preview) {
  const block = value => {
    const json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const fence = '`'.repeat(Math.max(3, ...[...json.matchAll(/`+/g)].map(m => m[0].length + 1)));
    return `${fence}${typeof value === 'string' ? 'text' : 'json'}\n${json}\n${fence}`;
  };
  const stats = smokePreviewStats(preview);
  return [`# MCP context preview — ${preview.client}`, '', preview.scope, '',
    `**${stats.attempts} attempts · ${stats.tools} tools · ${stats.connections} connections**`, '',
    `Recording: ${preview.recordingComplete ? 'complete' : 'INCOMPLETE'}. Model request created: **no**. Sent to a model: **no**.`, '',
    ...(preview.issues || []).map(issue => `- Recording issue: ${issue}`), '',
    'Scenario verdicts apply to the complete scenario, which can deliberately exercise error responses. Response status alone is not a test verdict.', '',
    '## Tool attempts in invocation order', '', ...preview.calls.flatMap(c => {
      const text = c.result?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
      return [`### ${c.id} · ${c.name} · ${c.status}`, '',
        `Scenario: ${c.scenario?.name || c.caseId || 'Not recorded'} · ${c.scenario?.outcome || 'NOT RECORDED'} · Connection ${c.connection ?? 'unknown'} · ${c.durationMs ?? 'unknown'} ms`, '',
        '**Harness → MCP: arguments**', '', block(c.args), '',
        '**MCP → harness: response**', '', text ? block(text) : block(c.error || c.result || 'No response recorded; this attempt is pending.'), '',
        '<details><summary>Full recorded exchange</summary>', '', block(c), '', '</details>', ''];
    }),
    ...(preview.protocolAudit ? ['## Protocol audit (separate SDK connection)', '', 'Protocol exchanges below are separate from the configured-tool attempt count.', '', block(preview.protocolAudit), ''] : []),
    '## Observed tool definitions', '', ...preview.discoveries.flatMap(d => [`### Connection ${d.connection}`, '', block(d.tools), '']),
  ].join('\n');
}
