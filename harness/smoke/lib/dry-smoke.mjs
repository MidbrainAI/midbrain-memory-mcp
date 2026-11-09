import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { createRunContext, defaultRoot, childEnv, HARNESS_VERSION, HARNESS_DIR } from './context.mjs';
import { freezeCandidate, freezeReleaseCandidate, assertCandidate, snapshotFiles, assertFilesUnchanged } from './candidate.mjs';
import { seedDetectionFixtures, writeGlobalKey, writeGlobalHostConfig, initProject, installCandidate, inspectInstall } from './home.mjs';
import { selectManifests } from '../clients/index.mjs';
import { snapshot, diff } from './tripwire.mjs';
import { spawnCapture, whichSync, stopChildProcesses } from './proc.mjs';
import { cell, blockedCells } from './cells.mjs';
import { check, BlockedError } from './checks.mjs';
import { renderSmokeMarkdown as renderMarkdown } from './markdown.mjs';
import { renderDrySmokeJUnit } from './dry-smoke-report.mjs';
import { renderDrySmokeHtml as renderRunHtml } from './dry-smoke-report.mjs';
import { DRY_SMOKE_CLIENTS, DRY_SMOKE_ROWS, DRY_SMOKE_SCOPE, smokeEnv, nativeProbe, drySmokeExitCode, validateDrySmokeFlags } from './dry-smoke-policy.mjs';
import { startSmokeApi, SMOKE_KEYS, SMOKE_TOOLS, redactSmoke } from './dry-smoke-fixture.mjs';
import { seedSmokeConflict, smokeConflictPreserved, installedSmokeEntry } from './dry-smoke-config.mjs';
import { buildSmokeContextPreview, renderSmokeContextMarkdown, parseSmokeTrace } from './dry-smoke-trace.mjs';
import { validateProbeEvidence, probeChecksForRow } from './dry-smoke-cases.mjs';

const probeScript = fileURLToPath(new URL('./dry-smoke-probe.mjs', import.meta.url));
const piScript = fileURLToPath(new URL('./dry-smoke-pi.mjs', import.meta.url));
const codexScript = fileURLToPath(new URL('./dry-smoke-codex.mjs', import.meta.url));
const log = message => console.error(`[dry-smoke] ${message}`);

export function classifyNativeProbe(id, result) {
  const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`).replace(/\\u001b\[[0-9;]*m/gi, '');
  if (result.timedOut) return { status: 'FAIL', detail: 'Native probe timed out; inspect native-probe.json.' };
  if (result.code !== 0) return { status: /invalid choice|unknown command|unrecognized/i.test(output) ? 'BLOCKED' : 'FAIL', detail: `Native probe exited ${result.code}. See native-probe.json for the client error.` };
  if (id === 'codex') {
    try {
      const data = JSON.parse(result.stdout);
      if (data.kind === 'app-server') return { status: data.ok === true && SMOKE_TOOLS.every(t => data.tools?.includes(t)) ? 'PASS' : data.blocked ? 'BLOCKED' : 'FAIL', detail: data.detail || 'Incomplete Codex discovery receipt' };
      if (!Array.isArray(data) || !data.some(s => s.name === 'midbrain-memory' && s.enabled !== false)) return { status: 'FAIL', detail: 'Codex did not list an enabled midbrain-memory entry.' };
      return { status: 'BLOCKED', detail: 'Codex parsed the configured server successfully. Its mcp list command does not establish a connection; native discovery remains unverified. Harness-driven transport checks are separate.' };
    } catch { return { status: 'FAIL', detail: 'Codex returned unrecognized configuration output.' }; }
  }
  if (id === 'pi') {
    try { const data = JSON.parse(result.stdout); return { status: data.ok === true && SMOKE_TOOLS.every(t => data.tools?.includes(`midbrain_${t}`)) ? 'PASS' : 'FAIL', detail: data.detail || 'Incomplete Pi discovery receipt' }; }
    catch { return { status: 'FAIL', detail: 'Pi SDK did not return a valid discovery receipt.' }; }
  }
  if (id === 'hermes' && /✓ Connected/.test(output) && SMOKE_TOOLS.every(name => new RegExp(`^\\s+${name}\\s`, 'm').test(output))) return { status: 'PASS', detail: 'Hermes mcp test connected and listed all 12 tools without a prompt.' };
  if (['claude', 'opencode'].includes(id)) {
    // Never accept a peer server's success as evidence about MidBrain.
    const line = output.split('\n').find(line => /^\s*[│┃●✓✔✗✕✘×\s]*midbrain-memory(?=[:\s])/.test(line));
    if (line && /failed|disconnected|error|not connected/i.test(line)) return { status: 'FAIL', detail: `Native client reported a MidBrain connection failure: ${line.trim()}` };
    if (line && /\bconnected\b/i.test(line)) return { status: 'PASS', detail: 'Native client reported MidBrain connected. Tool execution was tested separately by the harness.' };
  }
  return { status: 'BLOCKED', detail: 'Client exited successfully, but its output did not prove MidBrain discovery. Review native-probe.json; no connection inferred from exit code alone.' };
}

export function verifySmokeRequests(requests) {
  const has = (method, suffix, predicate) => requests.some(r => r.method === method && r.path === `/api/v1${suffix}` && predicate(r));
  const contract = (name, ok) => ({ ...check(name, ok), row: 'MCP tool contracts' });
  const recovery = (name, ok) => ({ ...check(name, ok), row: 'MCP failure recovery' });
  const isolation = (name, ok) => ({ ...check(name, ok), row: 'Project and global isolation' });
  return [
    contract('HTTP search parameters and global credential match the tool call', has('GET', '/memories/search/semantic', r => r.query.query === 'DRY_SMOKE Ω & exact' && r.query.limit === '9' && r.key === 'global')),
    contract('HTTP lexical parameters match the tool call', has('GET', '/memories/search/lexical', r => r.query.pattern === 'fixture.*' && r.query.limit === '2' && r.query.memory_type === 'semantic')),
    contract('HTTP date range matches the tool call', has('GET', '/memories/episodic', r => r.query.start_date === '2026-01-01T00:00:00.000Z' && r.query.end_date === '2026-01-03T00:00:00.000Z')),
    contract('HTTP file range matches the tool call', has('GET', '/memories/semantic/files/guide.md', r => r.query.start_line === '2' && r.query.num_lines === '1')),
    contract('Invalid search arguments cause no HTTP request', !requests.some(r => r.query.query === 'invalid')),
    contract('Missing and empty keys cause no HTTP request', !requests.some(r => ['DRY_SMOKE_NO_KEY', 'DRY_SMOKE_EMPTY_KEY'].includes(r.query.query))),
    contract('Legacy fallback preserves search query in POST body', has('POST', '/memories/search/semantic', r => r.body.query === 'DRY_SMOKE_FALLBACK' && r.key === 'global')),
    contract('Account API uses user credential', has('POST', '/account/agents', r => r.key === 'user' && r.body.name === 'Dry smoke agent') && has('POST', '/account/keys', r => r.key === 'user' && r.body.agent_id === 'dry-agent')),
    isolation('Project search uses project credential', has('GET', '/memories/search/semantic', r => r.query.query === 'DRY_SMOKE_PROJECT' && r.key === 'project')),
    recovery('Fixture auth error was exercised', has('GET', '/memories/search/semantic', r => r.query.query === 'DRY_SMOKE_ERROR' && r.status === 401)),
    recovery('Fixture outage and malformed response were exercised', has('GET', '/memories/search/semantic', r => r.query.query === 'DRY_SMOKE_UNAVAILABLE' && r.status === 503) && has('GET', '/memories/search/semantic', r => r.query.query === 'DRY_SMOKE_MALFORMED' && r.status === 200)),
    recovery('Fixture connection loss was exercised', has('GET', '/memories/search/semantic', r => r.query.query === 'DRY_SMOKE_DISCONNECT' && r.status === 'connection-reset')),
    isolation('Project credential survives MCP restart', has('GET', '/memories/search/semantic', r => r.query.query === 'DRY_SMOKE_RESTART' && r.key === 'project')),
  ];
}

async function nativeCheck(ctx, m, project, installClients) {
  if (!m.os.includes(process.platform)) throw new BlockedError(`${m.displayName} native harness driver does not support ${process.platform}; no other OS is simulated.`);
  let binary = whichSync(m.binary, childEnv(ctx));
  if (installClients && ['npm', 'uv-tool'].includes(m.install.kind)) {
    await m.preflight(ctx);
    binary = whichSync(m.binary, childEnv(ctx));
  }
  if (!binary) throw new BlockedError(`${m.binary} is not installed. ${['npm', 'uv-tool'].includes(m.install.kind) ? 'Use --install-clients for a run-local installation.' : m.install.hint}`);
  const env = smokeEnv(ctx, { HERMES_INTERACTIVE: '0', HERMES_ACCEPT_HOOKS: '0', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  const version = await spawnCapture(binary, ['--version'], { env, cwd: project, timeoutMs: 30000 });
  if (version.code !== 0) throw new BlockedError(`${m.binary} --version failed: ${version.stderr.slice(-300)}`);
  let result;
  if (m.id === 'codex') {
    result = await spawnCapture(process.execPath, [codexScript, binary], { env, cwd: project, timeoutMs: 60000 });
    try { result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), kind: 'app-server' }); } catch { /* Leave invalid output visible. */ }
  } else if (m.id === 'pi') {
    // Resolve the installed package behind the actual binary, not a second SDK version.
    let dir = path.dirname(realpathSync(binary)); let sdk;
    while (dir !== path.dirname(dir)) {
      const pkg = path.join(dir, 'package.json');
      if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === m.install.pkg) { sdk = path.join(dir, 'dist/index.js'); break; }
      dir = path.dirname(dir);
    }
    if (!sdk || !existsSync(sdk)) throw new BlockedError('Could not locate the SDK belonging to the installed Pi binary; direct bridge checks still run.');
    result = await spawnCapture(process.execPath, [piScript, sdk], { env, cwd: project, timeoutMs: 60000 });
  } else result = await spawnCapture(binary, nativeProbe(m.id).args, { env, cwd: project, timeoutMs: 60000 });
  return { version: version.stdout.trim() || version.stderr.trim(), result, verdict: classifyNativeProbe(m.id, result) };
}

/** Same candidate/home/report infrastructure as behavioral runs, without secrets or turns. */
export async function runDrySmoke(flags, {prepareCandidate, verifyCandidate = assertCandidate, selectClients = selectManifests} = {}) {
  validateDrySmokeFlags(flags);
  const ids = flags.clients ? flags.clients.split(',').map(s => s.trim()) : DRY_SMOKE_CLIENTS;
  const manifests = selectClients(ids);
  if (manifests.some(m => !nativeProbe(m.id))) throw new Error('dry-smoke currently supports Pi, OpenCode, Hermes, Claude and Codex. NanoClaw uses the separate behavioral Docker lane.');
  const ctx = createRunContext({ root: flags.root ? path.resolve(flags.root) : defaultRoot(), options: { drySmoke: true } });
  const before = snapshot();
  const runnerFiles = snapshotFiles(HARNESS_DIR);
  const cells = []; const clients = manifests.map(m => ({ id: m.id, displayName: m.displayName, runnable: true, version: null, knownExceptions: [] }));
  let api; let interrupted = false; let cleanup;
  const results = { schemaVersion: 1, harnessVersion: HARNESS_VERSION, run: { kind: 'dry-smoke', scope: DRY_SMOKE_SCOPE, runId: ctx.runId, marker: ctx.marker, runDir: ctx.dirs.run,
    startedAt: ctx.startedAt, platform: ctx.platform, arch: ctx.arch, osRelease: ctx.osRelease, node: ctx.node, modelCalls: 0, promptCount: 0,
    models: Object.fromEntries(manifests.map(m => [m.id, 'No model — dry-smoke'])), complete: false },
    runner: {apiVersion: 1, files: runnerFiles}, candidate: {}, clients, cells, contextPreviews: {}, isolation: { ok: false, drift: [] } };
  const save = () => {
    const publicResults = JSON.parse(redactSmoke(results));
    writeFileSync(path.join(ctx.dirs.run, 'results.json'), JSON.stringify(publicResults, null, 2));
    writeFileSync(path.join(ctx.dirs.run, 'report.md'), renderMarkdown(publicResults));
    writeFileSync(path.join(ctx.dirs.run, 'report.html'), renderRunHtml(publicResults));
    writeFileSync(path.join(ctx.dirs.run, 'junit.xml'), renderDrySmokeJUnit(publicResults));
  };
  const close = () => cleanup ||= (async () => { await stopChildProcesses(); if (api) await api.close(); })();
  const interrupt = () => { interrupted = true; void close(); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const heartbeat = globalThis.setInterval(() => log(`still running · ${cells.length} recorded checks · no model prompts`), 30000);
  try {
    save();
    api = await startSmokeApi({ faultFile: path.join(ctx.dirs.tmp, 'fixture-faults.json') });
    results.run.apiBase = api.url;
    log('Freezing the candidate package; package preparation may download dependencies.');
    const candidateOptions={directory:path.join(ctx.dirs.run,'candidate'),env:smokeEnv(ctx)};
    const candidate = prepareCandidate ? await prepareCandidate(flags, candidateOptions) : flags['candidate-tarball'] ? await freezeReleaseCandidate({...candidateOptions,tarball:path.resolve(flags['candidate-tarball']),
      sha256:flags['candidate-sha256'],version:flags['candidate-version'],sourceSha:flags['candidate-source-sha']})
      : await freezeCandidate({mode:'dev',...candidateOptions});
    results.candidate = ctx.candidate = candidate;
    ctx.writeJson(path.join(ctx.dirs.run, 'candidate.json'), candidate);
    seedDetectionFixtures(ctx, manifests);
    const sentinels = Object.fromEntries(manifests.map(m => [m.id, seedSmokeConflict(ctx, m.id)]));
    writeGlobalKey(ctx, SMOKE_KEYS.global); writeGlobalHostConfig(ctx, api.url);
    writeFileSync(path.join(ctx.dirs.tmp, '.midbrain-update-check.json'), JSON.stringify({ lastCheck: Date.now() }));
    const install = await installCandidate(ctx, candidate, { cwd: ctx.dirs.home });
    const installedEntries = Object.fromEntries(manifests.map(m => { try { return [m.id, installedSmokeEntry(ctx, m.id)]; } catch { return [m.id, null]; } }));
    const reinstall = install.code === 0 ? await installCandidate(ctx, candidate, { cwd: ctx.dirs.home, label: 'install-repeat' }) : install;
    for (const m of manifests) {
      if (interrupted) break;
      const client = clients.find(c => c.id === m.id);
      const evidenceDir = ctx.evidenceDir(m.id, 'dry-smoke');
      const project = await initProject(ctx, `dry-${m.id}`);
      const add = (row, checks, extra = {}) => cells.push(cell({ row, scenario: 'dry-smoke', client: m, checks, ...extra }));
      let stage = 'Clean install';
      try {
        log(`${m.displayName}: checking installation and the configured MCP transport`);
        // setup_project can install shared client assets. Restore the frozen dev
        // candidate between client cases, without erasing the sibling fixtures.
        if (cells.length) {
          const reset = await installCandidate(ctx, candidate, { cwd: ctx.dirs.home, label: `reset-${m.id}` });
          if (reset.code !== 0) throw new Error('Candidate reset failed; see install evidence');
        }
        const inspection = await inspectInstall(ctx, candidate, m.id);
        add('Clean install', [check('Candidate installer and repeat install exit successfully', install.code === 0 && reinstall.code === 0), check('Product adapter recognizes the installed integration', inspection.installed === true && inspection.fresh === true, JSON.stringify(inspection))]);
        add('Configuration preservation', [check('Unrelated integration survives install and reinstall', smokeConflictPreserved(m.id, sentinels[m.id]))]);
        if (install.code !== 0) throw new BlockedError('Candidate installation failed; see evidence/_install.');
        stage = 'Configured MCP transport';
        const entry = installedSmokeEntry(ctx, m.id);
        add('Configuration preservation', [check('Repeat installation preserves the MCP launch configuration', JSON.stringify(entry) === JSON.stringify(installedEntries[m.id]))]);
        add('Reproducibility', [check('Configured command points to the frozen candidate', entry.command === process.execPath && entry.args?.[0] === path.join(candidate.repoRoot, 'index.js'))]);
        const input = path.join(evidenceDir, 'probe-input.json');
        const tracePath = path.join(evidenceDir, 'mcp-events.ndjson');
        writeFileSync(tracePath, '');
        ctx.writeJson(input, { entry, project, apiUrl: api.url, tracePath, faultFile: path.join(ctx.dirs.tmp, 'fixture-faults.json') });
        const start = api.requests.length;
        const probe = await spawnCapture(process.execPath, [probeScript, input], { cwd: project, env: smokeEnv(ctx, { MIDBRAIN_PROJECT_DIR: project, MIDBRAIN_CLIENT: m.id }), timeoutMs: 90000 });
        let recorded;
        try { recorded = JSON.parse(probe.stdout); } catch { recorded = { checks: [check('Probe returns structured evidence', false, probe.stderr.slice(-1000))] }; }
        const observed = parseSmokeTrace(readFileSync(tracePath, 'utf8'));
        const traceMatches = redactSmoke(observed.calls) === redactSmoke(recorded.calls || []) && redactSmoke(observed.discoveries) === redactSmoke(recorded.discoveries || []);
        if (!traceMatches) observed.issues.push('Incremental trace differs from the final probe receipt');
        const preview = buildSmokeContextPreview(m.id, { ...recorded, ...observed }, { complete: probe.code === 0 && !probe.timedOut && validateProbeEvidence(recorded).ok });
        const previewJson = path.relative(ctx.dirs.run, path.join(evidenceDir, 'mcp-context-preview.json'));
        const previewMarkdown = path.relative(ctx.dirs.run, path.join(evidenceDir, 'mcp-context-preview.md'));
        preview.artifacts = { json: previewJson, markdown: previewMarkdown, events: path.relative(ctx.dirs.run, tracePath) };
        ctx.writeJson(path.join(ctx.dirs.run, previewJson), preview);
        writeFileSync(path.join(ctx.dirs.run, previewMarkdown), renderSmokeContextMarkdown(preview));
        results.contextPreviews[m.id] = preview;
        const requestSlice = api.requests.slice(start);
        const ref = path.relative(ctx.dirs.run, path.join(evidenceDir, 'mcp-probe.json'));
        writeFileSync(path.join(ctx.dirs.run, ref), redactSmoke({ ...recorded, process: { code: probe.code, timedOut: probe.timedOut, stderr: probe.stderr }, requests: requestSlice }));
        const notes = recorded.kind || 'Harness-driven MCP calls; not native client tool execution.';
        const http = verifySmokeRequests(requestSlice);
        add('Configured MCP transport', [check('Configured transport probe completes within its deadline', probe.code === 0 && !probe.timedOut, recorded.error || ''), validateProbeEvidence(recorded), check('MCP trace is complete and agrees with the probe receipt', preview.recordingComplete, preview.issues.join('; ')), ...probeChecksForRow(recorded, 'Configured MCP transport')], { evidence: [ref], notes });
        add('MCP tool contracts', [...probeChecksForRow(recorded, 'MCP tool contracts'), ...http.filter(c => c.row === 'MCP tool contracts'), check('Probe covered every exposed tool', SMOKE_TOOLS.every(name => recorded.calls?.some(c => c.name === name)))], { evidence: [ref], notes });
        add('MCP failure recovery', [...probeChecksForRow(recorded, 'MCP failure recovery'), ...http.filter(c => c.row === 'MCP failure recovery')], { evidence: [ref] });
        add('Project and global isolation', [...probeChecksForRow(recorded, 'Project and global isolation'), ...http.filter(c => c.row === 'Project and global isolation')], { evidence: [ref] });
        // Account commands modify only synthetic project data. Remove that project's override before native discovery.
        rmSync(path.join(project, '.midbrain'), { recursive: true, force: true });
        try {
          log(`${m.displayName}: running native discovery without a model`);
          const reset = await installCandidate(ctx, candidate, { cwd: ctx.dirs.home, label: `native-${m.id}` });
          if (reset.code !== 0) throw new Error('Could not restore candidate integration before native discovery');
          const nativeEntry = installedSmokeEntry(ctx, m.id);
          if (nativeEntry.command !== process.execPath || nativeEntry.args?.[0] !== path.join(candidate.repoRoot, 'index.js')) throw new Error('Native probe would use a different candidate');
          const native = await nativeCheck(ctx, m, project, Boolean(flags['install-clients']));
          client.version = native.version;
          const nativeRef = path.relative(ctx.dirs.run, path.join(evidenceDir, 'native-probe.json'));
          writeFileSync(path.join(ctx.dirs.run, nativeRef), redactSmoke(native));
          add('Native client discovery', [check('Native client proves MidBrain discovery', native.verdict.status === 'PASS', native.verdict.detail)], { status: native.verdict.status, blockedReason: native.verdict.status === 'BLOCKED' ? native.verdict.detail : null, evidence: [nativeRef], notes: `Evidence level: ${nativeProbe(m.id).level}. ${native.verdict.detail}` });
        } catch (e) {
          if (e.blocked) cells.push(...blockedCells(['Native client discovery'], 'dry-smoke', m, e.message));
          else add('Native client discovery', [check('Native probe completed', false, e.message)]);
        }
        stage = 'Configuration preservation';
        add('Configuration preservation', [check('Unrelated integration survives tool-driven setup', smokeConflictPreserved(m.id, sentinels[m.id]))]);
        stage = 'Reproducibility';
        verifyCandidate(candidate);
        assertFilesUnchanged(HARNESS_DIR, runnerFiles);
        add('Reproducibility', [check('Frozen package and harness inputs remained unchanged', true)]);
      } catch (e) {
        add(stage, [check('Client stage completed', false, e.message)], { status: e.blocked ? 'BLOCKED' : 'FAIL', blockedReason: e.blocked ? e.message : null });
        for (const row of DRY_SMOKE_ROWS) if (!cells.some(c => c.client === m.id && c.row === row)) add(row, [check('Dry-smoke stage completed', false, e.message)], { status: e.blocked ? 'BLOCKED' : 'FAIL', blockedReason: e.blocked ? e.message : null });
      }
      save();
    }
    if (api.unexpected.length) {
      cells.push(cell({ row: 'MCP tool contracts', scenario: 'dry-smoke', client: manifests[0], checks: [check('No unexpected backend requests', false, redactSmoke(api.unexpected))] }));
    }
    results.run.complete = !interrupted;
  } catch (e) {
    cells.push(cell({ row: 'Clean install', scenario: 'dry-smoke', client: manifests[0], status: ['EPERM', 'EACCES'].includes(e.code) ? 'BLOCKED' : 'FAIL', checks: [check('Shared dry-smoke setup completed', false, e.message)] }));
    results.run.error = e.message;
  } finally {
    globalThis.clearInterval(heartbeat);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    try { await close(); } catch (e) { results.run.complete = false; results.run.error = `Cleanup failed: ${e.message}`; }
    const drift = diff(before, snapshot());
    results.isolation = { ok: drift.length === 0, drift };
    ctx.writeJson(path.join(ctx.dirs.run, 'isolation.json'), results.isolation);
    results.run.finishedAt = new Date().toISOString();
    if (api) writeFileSync(path.join(ctx.dirs.evidence, 'fixture-requests.json'), redactSmoke(api.requests));
    save();
  }
  log(`Report: ${path.join(ctx.dirs.run, 'report.html')}`);
  process.exitCode = drySmokeExitCode(cells, results.isolation.ok, results.run.complete, clients.map(c => c.id));
  return results;
}
