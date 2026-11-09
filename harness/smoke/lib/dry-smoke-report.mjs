import { smokePreviewStats } from './dry-smoke-trace.mjs';
import { reportToolCoverage } from './tool-contracts.mjs';
import {smokeFindings,publicSmokeText} from './smoke-findings.mjs';
import { DRY_SMOKE_ROWS, DRY_SMOKE_SCOPE, drySmokeOutcome, missingSmokeCoverage, nativeProbe } from './dry-smoke-policy.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rank = { PASS: 1, SKIP: 2, BLOCKED: 3, FAIL: 4 };
const badge = status => `<span class="badge ${status.toLowerCase()}">${esc(status)}</span>`;
const table = (headers, rows) => `<div class="table-scroll" tabindex="0"><table><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map((v, i) => i ? `<td>${v}</td>` : `<th scope="row">${v}</th>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const duration = ms => Number.isFinite(ms) && ms >= 0 ? ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s` : 'Not recorded';
const evidenceLink = ref => /^(?:evidence\/)[a-zA-Z0-9_./-]+$/.test(ref) && !ref.split('/').includes('..')
  ? `<a href="${ref}">${esc(ref)}</a>` : esc(ref);

export function smokeReportSummary(report) {
  const { run, cells, clients, isolation } = report;
  const checks = cells.flatMap(c => c.checks || []);
  const matrix = DRY_SMOKE_ROWS.map(row => ({ row, clients: Object.fromEntries(clients.map(client => {
    const matching = cells.filter(c => c.row === row && c.client === client.id);
    const status = matching.length ? matching.map(c => c.status).sort((a, b) => (rank[b] || 0) - (rank[a] || 0))[0] : 'NOT RUN';
    return [client.id, status];
  })) }));
  return {
    outcome: drySmokeOutcome(cells, isolation?.ok === true, run.complete, clients.map(c => c.id)), matrix,
    passed: checks.filter(c => c.ok === true).length, assertions: checks.length,
    failed: checks.filter(c => c.ok === false).length,
    blocked: cells.filter(c => c.status === 'BLOCKED').length,
    missing: missingSmokeCoverage(cells, clients.map(c => c.id)),
    elapsed: duration(Date.parse(run.finishedAt) - Date.parse(run.startedAt)),
  };
}

function failureCards(report) {
  return smokeFindings(report).map(f=>`<div class="issue"><strong>${esc(f.client)} · ${esc(f.row)} ${badge(f.status)}</strong>
    ${f.tool?`<p><strong>Tool:</strong> <code>${esc(f.tool)}</code></p>`:''}
    <p><strong>Expected:</strong> ${esc(f.expected)}</p><p><strong>Observed:</strong> ${esc(f.observed)}</p>
    <p><strong>Next step:</strong> ${esc(f.next)}</p>
    <p>${f.evidence.map(evidenceLink).join('<br>')}${f.exchanges.map(id=>`<br><a href="#${id}">Inspect exact exchange</a>`).join('')}</p></div>`).join('');
}

function renderContextPreviews(previews = {}, clients) {
  const responseLabels = { returned: 'Response received', 'tool-error': 'Tool reported an error', rejected: 'Call rejected', pending: 'No response recorded' };
  const available = clients.filter(c => previews[c.id]);
  const panels = available.map(client => {
    const preview = previews[client.id];
    const counts = smokePreviewStats(preview);
    const payload = value => `<pre><code>${esc(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</code></pre>`;
    return `<details class="panel context-preview" data-client="${esc(client.id)}"><summary><strong>${esc(client.displayName)}</strong> · ${counts.attempts} attempts · ${counts.tools} tools · ${preview.recordingComplete ? 'Complete recording' : 'INCOMPLETE recording'}</summary>
      <p class="trace-counts">${counts.returned} responses · ${counts['tool-error']} tool errors · ${counts.rejected} rejected · ${counts.pending} pending</p>
      ${(preview.issues || []).map(issue => `<p class="issue">${esc(issue)}</p>`).join('')}
      <p class="evidence">${Object.entries(preview.artifacts || {}).map(([label, ref]) => `${esc(label)}: ${evidenceLink(ref)}`).join('<br>')}</p>
      ${preview.protocolAudit ? `<details><summary>Protocol audit · ${esc(preview.protocolAudit.protocolVersion || 'not negotiated')}</summary><p>Separate harness SDK connection; these protocol exchanges are outside the configured-tool attempt count.</p>${(preview.protocolAudit.compatibilityNotes || []).map(note => `<p class="issue">${esc(note)}</p>`).join('')}${payload(preview.protocolAudit)}</details>` : ''}
      <details class="tool-library"><summary>Inspect the observed tool definitions (${counts.connections} connections)</summary>${preview.discoveries.map(d => `<h3>Connection ${d.connection}</h3>${d.tools.map(t => `<details><summary><code>${esc(t.exposedName || t.name)}</code></summary><p class="tool-description">${esc(t.description || 'No description recorded')}</p>${payload(t)}</details>`).join('')}`).join('')}</details>
      ${preview.calls.map(c => {
        const content = c.result?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n');
        return `<details class="trace-call" id="${esc(client.id)}-${esc(c.id)}" data-status="${esc(c.status)}" data-client="${esc(client.id)}">
          <summary><span class="trace-id">${esc(c.id)}</span> <code>${esc(c.name)}</code> <span class="trace-response">${esc(responseLabels[c.status] || c.status)}</span></summary>
          <p class="trace-scenario"><strong>Scenario:</strong> ${esc(c.scenario?.name || c.caseId || 'Not recorded')} ${badge(c.scenario?.outcome || 'NOT RECORDED')}</p>
          <p class="muted">Connection ${esc(c.connection ?? 'unknown')} · ${esc(duration(c.durationMs))} · Started ${esc(c.startedAt || 'not recorded')} · <a href="#${esc(client.id)}-${esc(c.id)}">Link to this exchange</a></p>
          <div class="trace-exchange"><section><h4>Harness → MCP</h4><p class="muted">Arguments supplied to the tool</p>${payload(c.args)}</section><section><h4>MCP → harness</h4><p class="muted">${esc(responseLabels[c.status] || c.status)}</p>${payload(content || c.error || c.result || 'No response recorded. This call was pending when logging stopped.')}</section></div>
          <details><summary>Full recorded exchange</summary>${payload(c)}</details>
        </details>`;
      }).join('')}
    </details>`;
  });
  if (!panels.length) return '';
  return `<section id="context-preview"><h2>MCP context preview</h2><p>Follow each exchange from the arguments supplied to the MCP to the content returned. <strong>No model request was created or sent.</strong> These are harness-driven checks against a synthetic API; native system prompts and provider request formatting are outside this preview.</p><p class="muted">A scenario can pass by correctly handling a deliberate error. Scenario verdicts cover the whole scenario; a response arriving does not by itself mean the tool succeeded. All synthetic credentials are redacted.</p>
    <div class="filters"><label>Preview client<select id="trace-client"><option value="all">All clients</option>${available.map(c => `<option value="${esc(c.id)}">${esc(c.displayName)}</option>`).join('')}</select></label><label>Response type<select id="trace-status"><option value="all">All responses</option>${Object.entries(responseLabels).map(([value, label]) => `<option value="${value}">${esc(label)}</option>`).join('')}</select></label><label>Search exchanges<input type="search" id="trace-search" placeholder="Tool, arguments or response text"></label><span id="trace-count" class="muted" role="status" aria-live="polite"></span></div>${panels.join('')}</section>`;
}

export function renderDrySmokeHtml(report) {
  const { run, candidate, clients, cells, isolation } = report;
  const summary = smokeReportSummary(report);
  const issues = smokeFindings(report);
  const groups = clients.flatMap(client => DRY_SMOKE_ROWS.map(row => {
    const matches = cells.filter(c => c.client === client.id && c.row === row);
    const checks = matches.flatMap(c => c.checks || []);
    const status = summary.matrix.find(m => m.row === row).clients[client.id];
    const notes = [...new Set(matches.map(c => c.notes || c.blockedReason).filter(Boolean))];
    const refs = [...new Set(matches.flatMap(c => c.evidence || []))];
    return `<details class="case" data-client="${esc(client.id)}" data-status="${esc(status)}" ${status === 'PASS' ? '' : 'open'}>
      <summary><span>${esc(client.displayName)} <span class="muted">/</span> ${esc(row)}</span><span>${checks.filter(c => c.ok === true).length}/${checks.length} assertions ${badge(status)}</span></summary>
      ${notes.map(n => `<p class="muted">${esc(n)}</p>`).join('')}
      ${checks.length ? table(['Assertion', 'Result', 'Time', 'Observation'], checks.map(c => [esc(c.name), badge(c.ok === true ? 'PASS' : 'FAIL'), esc(c.durationMs === undefined ? '—' : duration(c.durationMs)), esc(publicSmokeText(c.detail || '—',report))])) : '<p>No assertions recorded for this check.</p>'}
      <p class="evidence">${refs.length ? refs.map(evidenceLink).join('<br>') : 'Evidence is recorded in results.json and the installer logs.'}</p>
    </details>`;
  })).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MidBrain · MCP dry-smoke · ${esc(summary.outcome)}</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#183d35;background:#f4f5ef;font-size:15px;line-height:1.6}*{box-sizing:border-box}body{margin:0}main{max-width:1250px;margin:auto;padding:42px 34px 60px}a{color:#17624d;text-underline-offset:3px}a:focus-visible,summary:focus-visible,select:focus-visible,input:focus-visible,button:focus-visible,[tabindex]:focus-visible{outline:3px solid #be8833;outline-offset:4px}.topline{display:flex;justify-content:space-between;gap:20px;align-items:center;border-bottom:1px solid #cbd8cf;padding-bottom:18px;font-size:12px;letter-spacing:.08em}.wordmark{font-weight:800;letter-spacing:.16em}.muted{color:#60756b}.hero{padding:36px 0 28px;display:grid;grid-template-columns:1fr auto;gap:24px;align-items:center}.eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:#416955}h1{font:600 clamp(36px,5vw,58px)/1.1 Georgia,serif;letter-spacing:-.025em;margin:12px 0 16px}h2{font:600 28px/1.3 Georgia,serif;margin:38px 0 16px}h3{margin:0 0 10px;font-size:17px}.deck{max-width:710px;margin:0;color:#4c685b;font-size:17px}.verdict{text-align:center;border:1px solid #c4d4c7;border-radius:12px;background:#fffefa;padding:24px 30px;min-width:185px}.verdict>.muted{margin-left:12px}.verdict strong{display:block;font-size:27px;margin-top:10px}.badge{display:inline-block;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:800;letter-spacing:.03em;white-space:nowrap;background:#e8ebe5;color:#53655a}.pass{background:#dcebdd;color:#245631}.fail{background:#f8dfda;color:#922f24}.blocked,.incomplete{background:#fff0cd;color:#795111}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.stat{background:#fffefa;border:1px solid #d7dfd4;border-radius:9px;padding:18px 22px}.stat strong{font-size:26px;display:block;margin-bottom:3px}.stat span{font-size:12px;color:#60756b}.boundary{border-left:3px solid #8eab92;background:#eaf0e4;padding:16px 20px;margin:22px 0}.boundary p{margin:0}.pipeline{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:22px 0}.pipeline article{border-top:2px solid #b4cbb6;padding:16px 0}.pipeline small{color:#65806b;letter-spacing:.12em;font-weight:700}.pipeline p{font-size:13px;margin:8px 0 0;color:#526b60}.table-scroll{overflow:auto;border:1px solid #d4ded2;border-radius:9px;background:#fffefa}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:13px 16px;border-bottom:1px solid #e0e7da;vertical-align:top}thead th{background:#e8eee2;font-size:11px;text-transform:uppercase;letter-spacing:.04em}tbody th{font-weight:600;min-width:195px}tr:last-child>th,tr:last-child>td{border-bottom:0}tbody tr:hover{background:#f4f7ef}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:20px}.panel{padding:22px;background:#fffefa;border:1px solid #d5dfd2;border-radius:9px}.panel ul{padding-left:20px;margin:10px 0 0}.panel li{margin:8px 0;font-size:13px}.panel p{margin:0;font-size:13px}.issue{background:#fff6e6;border:1px solid #e8cf9f;padding:18px 22px;border-radius:8px;margin:12px 0}.issue p{margin:7px 0;font-size:13px}.filters{display:flex;gap:14px;flex-wrap:wrap;align-items:end;margin:18px 0}.filters label{display:grid;gap:4px;font-size:12px;color:#526b60}.filters select,.filters input{font:inherit;font-size:14px;border:1px solid #bacbb8;border-radius:5px;background:#fffefa;padding:8px 10px;min-height:38px}.filters input{min-width:230px}.case{border:1px solid #d5dfd2;background:#fffefa;border-radius:8px;padding:14px 18px;margin:9px 0}.case summary{cursor:pointer;display:flex;justify-content:space-between;gap:16px;align-items:center;font-size:13px;font-weight:600;list-style:none}.case summary:before{content:'+';font-size:18px;color:#60756b}.case[open] summary:before{content:'−'}.case summary>span:first-child{flex:1}.case summary>span:last-child{font-size:11px;color:#60756b}.case summary .badge{margin-left:12px}.case[open] summary{margin-bottom:16px}.case .table-scroll{border-radius:5px}.case td:last-child{overflow-wrap:anywhere;max-width:420px}.case p{font-size:12px}.evidence{overflow-wrap:anywhere}code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.85em;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:150px 1fr;gap:8px 18px;font-size:12px}dt{color:#60756b}dd{margin:0;overflow-wrap:anywhere}.context-preview{margin:12px 0}.context-preview>summary{font-size:15px}.trace-counts{padding:12px 0;color:#60756b}.trace-id{font-size:11px;color:#60756b}.trace-response{float:right;font-size:11px;padding:3px 8px;background:#edf1e8;border-radius:4px}.trace-scenario{padding:12px 0 6px}.trace-scenario .badge{margin-left:10px}.trace-exchange{display:grid;grid-template-columns:1fr 1fr;gap:16px}.trace-exchange section{min-width:0}.trace-exchange h4{margin:18px 0 3px;font-size:12px;letter-spacing:.08em}.tool-description{white-space:pre-wrap;padding:14px 0}.context-preview .trace-exchange pre{white-space:pre-wrap;overflow-wrap:anywhere}.context-preview .trace-exchange code{white-space:pre-wrap}.report-nav{display:flex;flex-wrap:wrap;gap:20px;font-size:12px;margin:0 0 20px}.context-preview summary{cursor:pointer}.context-preview details{padding:12px 0;border-top:1px solid #e0e7da}.context-preview pre{overflow:auto;max-height:500px;padding:18px;background:#eef2e9;font-size:12px;line-height:1.5}.context-preview code{font-size:inherit;white-space:pre}.footer{border-top:1px solid #cbd8cf;margin-top:36px;padding-top:20px;font-size:12px;color:#60756b}.footer nav{display:flex;gap:20px;margin-bottom:10px}[hidden]{display:none!important}
@media(max-width:760px){.trace-exchange{grid-template-columns:1fr}.trace-response{float:none;display:inline-block;margin-left:8px}main{padding:24px 16px}.hero{grid-template-columns:1fr}.verdict{text-align:left;padding:14px 20px}.verdict>.muted{margin-left:12px}.verdict strong{display:inline;margin-left:12px}.stats{grid-template-columns:1fr 1fr}.pipeline,.two-col{grid-template-columns:1fr}.pipeline{gap:0}.topline{align-items:start}.topline span:last-child{max-width:48%;text-align:right;font-size:10px}.case summary{flex-wrap:wrap}.case summary>span:last-child{margin-left:25px}dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:10px}}@media print{body{background:#fff}main{max-width:none;padding:0}.filters{display:none}.table-scroll{overflow:visible}table{font-size:10px}th,td{padding:7px}.case{break-inside:avoid}h2{break-after:avoid}.case[hidden]{display:block!important}.hero{padding-top:20px}.stats{grid-template-columns:repeat(4,1fr)}a{color:inherit}.footer{break-inside:avoid}}
</style></head><body><main>
<div class="topline"><span class="wordmark">MIDBRAIN <span class="muted">/ ENGINEERING</span></span><span class="muted">${esc(run.runId)} · ${esc(run.platform || 'Unknown OS')} / ${esc(run.arch || 'Unknown architecture')}</span></div>
<header class="hero"><div><div class="eyebrow">MCP integration assurance</div><h1>Dry-smoke report</h1><p class="deck">A packaged MCP, real client integrations, and deliberate failures. Every result is backed by recorded checks.</p></div><div class="verdict"><span class="eyebrow">Run verdict</span><strong>${badge(summary.outcome)}</strong><span class="muted">${esc(summary.elapsed)}</span></div></header>
<div class="stats"><div class="stat"><strong>${summary.passed}<span> / ${summary.assertions}</span></strong><span>Assertions passed</span></div><div class="stat"><strong>${clients.length}</strong><span>Selected clients</span></div><div class="stat"><strong>${esc(run.promptCount ?? 'Unknown')}</strong><span>Model prompts sent</span></div><div class="stat"><strong>${isolation?.ok === true ? 'Unchanged' : 'Unverified / drift'}</strong><span>Watched real-home files</span></div></div>
<div class="boundary"><p><strong>Scope:</strong> ${esc(DRY_SMOKE_SCOPE)} Zero prompts is a property of the allowed operations, not a packet-level network audit.</p></div>
<div class="pipeline"><article><small>01 / PACKAGE</small><h3>Install the real candidate</h3><p>Preserve the npm archive, use an isolated home, repeat installation, and check existing configuration.</p></article><article><small>02 / EXERCISE</small><h3>Call tools and inject failures</h3><p>Drive the installed MCP or Pi bridge, inspect HTTP contracts, test recovery, concurrency and restart.</p></article><article><small>03 / CONNECT</small><h3>Verify native compatibility</h3><p>Ask the installed client to connect or discover tools. No model turn or prompt is needed.</p></article></div>
${issues.length || summary.missing.length || run.error || isolation?.ok !== true ? `<h2>What needs attention</h2>${run.error ? `<div class="issue"><strong>Run error</strong><p>${esc(run.error)}</p></div>` : ''}${isolation?.ok !== true ? `<div class="issue"><strong>Host isolation was not verified clean</strong><p>Inspect isolation.json before accepting this run.</p></div>` : ''}${failureCards(report)}${summary.missing.length ? `<div class="issue"><strong>${summary.missing.length} coverage cells were not recorded</strong><p>Rerun the selected clients; omitted coverage cannot pass the gate.</p></div>` : ''}` : ''}
<nav class="report-nav" aria-label="Report sections"><a href="#coverage">Coverage</a>${report.contextPreviews && Object.keys(report.contextPreviews).length ? '<a href="#context-preview">MCP context preview</a>' : ''}<a href="#assertions">Assertions</a><a href="#run-identity">Run identity</a></nav><h2 id="coverage">Coverage at a glance</h2>${table(['Check', ...clients.map(c => c.displayName)], summary.matrix.map(m => [esc(m.row), ...clients.map(c => badge(m.clients[c.id]))]))}
<p class="muted">FAIL, BLOCKED and incomplete coverage exit nonzero. The matrix groups assertions; native connection and tool execution are separate claims.</p>
<h2>What the native clients proved</h2>${table(['Client', 'Version', 'Evidence level', 'Observed result'], clients.map(c => {
  const native = cells.find(cell => cell.client === c.id && cell.row === 'Native client discovery');
  return [esc(c.displayName), esc(c.version?.split('\n')[0] || 'Not recorded'), esc(nativeProbe(c.id)?.level || 'Not recorded'), esc(native?.notes || native?.blockedReason || 'Not recorded')];
}))}
${renderContextPreviews(report.contextPreviews, clients)}
<h2 id="tool-coverage">Per-tool contract coverage</h2><p>These are harness-driven MCP checks. Discovery, validated execution and native execution are different evidence levels. NOT COVERED identifies a remaining gap; N/A applies only to tools with no input fields. A returned response alone does not prove success.</p>
${clients.map(c => `<details class="panel"><summary>${esc(c.displayName)} · 12 tool contracts</summary>${table(['Tool', 'Discovered', 'Schema contract', 'Positive case', 'Invalid input', 'Failure / recovery'], reportToolCoverage(report, c.id).map(t => [esc(t.name), esc(t.discovered ? 'YES' : 'NOT RECORDED'), esc(t.schema), esc(t.positive), esc(t.invalid), esc(t.recovery)]))}</details>`).join('')}
<h2>How to interpret this run</h2><div class="two-col"><section class="panel"><h3>Verified when the checks pass</h3><ul><li>Installed MCP startup, tool contracts and native connection/discovery.</li><li>Synthetic backend failures, credentials, concurrency and restart.</li><li>Project/global isolation and preservation of one sibling integration.</li></ul></section><section class="panel"><h3>Requires separate evidence</h3><ul><li>Memory quality, ranking, indexing and production service reliability.</li><li>Model tool choice, native capture and actual recall behavior.</li><li>Upgrades, arbitrary third-party conflicts and other operating systems.</li></ul></section></div>
<h2 id="assertions">Inspect the assertions</h2><p class="muted">Filter by client or outcome, then expand a check. Evidence links work when this report stays beside its evidence directory.</p>
<div class="filters"><label>Client<select id="client-filter"><option value="all">All clients</option>${clients.map(c => `<option value="${esc(c.id)}">${esc(c.displayName)}</option>`).join('')}</select></label><label>Outcome<select id="status-filter"><option value="all">All outcomes</option><option value="attention">Needs attention</option><option value="PASS">Passed</option></select></label><label>Find an assertion<input id="search-filter" type="search" placeholder="e.g. restart, credentials"></label><span class="muted" id="filter-count" role="status" aria-live="polite"></span></div>
<section id="cases">${groups}</section>
<h2 id="run-identity">Run identity</h2><section class="panel"><dl><dt>Candidate</dt><dd>${esc(candidate.name || 'Not prepared')} ${esc(candidate.version || '')}</dd><dt>Source revision</dt><dd><code>${esc(candidate.sha || 'Not recorded')}</code>${candidate.dirty ? ' · includes local changes; archive hash identifies tested bytes' : ''}</dd><dt>Source provenance</dt><dd>${esc(candidate.sourceShaProvenance || 'Not recorded')}</dd><dt>Archive SHA-256</dt><dd><code>${esc(candidate.tarballSha256 || 'Not recorded')}</code></dd><dt>Host</dt><dd>${esc(run.platform)} / ${esc(run.arch)} · ${esc(run.osRelease)} · Node ${esc(run.node)}</dd><dt>Started / finished</dt><dd>${esc(run.startedAt || 'Not recorded')} / ${esc(run.finishedAt || 'In progress')}</dd><dt>Evidence schema</dt><dd>${esc(report.schemaVersion || 'Legacy')}</dd></dl></section>
<footer class="footer"><nav><a href="results.json">Machine-readable results</a><a href="report.md">Markdown report</a><a href="junit.xml">JUnit results</a><a href="isolation.json">Isolation evidence</a></nav>Self-contained report · No external scripts, fonts or analytics · A passing dry-smoke run is not full release approval.</footer>
</main><script>
const cases = [...document.querySelectorAll('.case')];
const client = document.getElementById('client-filter'), status = document.getElementById('status-filter'), search = document.getElementById('search-filter');
function filter() { let shown = 0; const query = search.value.toLowerCase(); for (const item of cases) { const match = (client.value === 'all' || item.dataset.client === client.value) && (status.value === 'all' || (status.value === 'attention' ? item.dataset.status !== 'PASS' : item.dataset.status === status.value)) && item.textContent.toLowerCase().includes(query); item.hidden = !match; shown += Number(match); } document.getElementById('filter-count').textContent = shown + ' of ' + cases.length + ' checks'; }
for (const control of [client, status, search]) control.addEventListener('input', filter); filter();
const traceCalls = [...document.querySelectorAll('.trace-call')], tracePanels = [...document.querySelectorAll('.context-preview')];
const traceClient = document.getElementById('trace-client'), traceStatus = document.getElementById('trace-status'), traceSearch = document.getElementById('trace-search');
function filterTrace() { let shown = 0; for (const item of traceCalls) { item.hidden = !((traceClient.value === 'all' || item.dataset.client === traceClient.value) && (traceStatus.value === 'all' || item.dataset.status === traceStatus.value) && item.textContent.toLowerCase().includes(traceSearch.value.toLowerCase())); shown += Number(!item.hidden); } for (const panel of tracePanels) { panel.hidden = traceClient.value !== 'all' && panel.dataset.client !== traceClient.value; if (!panel.hidden && (traceClient.value !== 'all' || traceStatus.value !== 'all' || traceSearch.value)) panel.open = true; } document.getElementById('trace-count').textContent = shown + ' of ' + traceCalls.length + ' exchanges'; }
if (traceClient) { for (const control of [traceClient, traceStatus, traceSearch]) control.addEventListener('input', filterTrace); filterTrace(); }
function revealExchange() { const id = decodeURIComponent(location.hash.slice(1)); const target = document.getElementById(id); if (target?.classList.contains('trace-call')) { if (traceClient) { traceClient.value = 'all'; traceStatus.value = 'all'; traceSearch.value = ''; filterTrace(); } target.open = true; target.closest('.context-preview').open = true; target.scrollIntoView(); } }
window.addEventListener('hashchange', revealExchange); revealExchange();
let openBeforePrint; window.addEventListener('beforeprint', () => { openBeforePrint = cases.map(c => c.open); for (const c of cases) c.open = true; }); window.addEventListener('afterprint', () => { if (openBeforePrint) cases.forEach((c, i) => { c.open = openBeforePrint[i]; }); });
</script></body></html>`;
}

export function renderDrySmokeJUnit(report) {
  const summary = smokeReportSummary(report);
  const cases = report.cells.flatMap(cell => {
    const checks = cell.checks?.length ? cell.checks : [{ name: cell.row, ok: false, detail: cell.blockedReason || 'No assertions recorded' }];
    return checks.map(check => ({ name: check.name, group: `${cell.client}.${cell.row}`, time: Number.isFinite(check.durationMs) ? check.durationMs / 1000 : 0,
      status: cell.status === 'BLOCKED' ? 'skip' : check.ok === true ? 'pass' : 'fail', detail: check.detail || cell.blockedReason || '' }));
  });
  cases.push({ name: 'Complete coverage and clean host isolation', group: 'dry-smoke.gate', time: 0, status: summary.outcome === 'PASS' ? 'pass' : 'fail', detail: `Run outcome: ${summary.outcome}; missing cells: ${summary.missing.length}. See report.html for evidence.` });
  // XML 1.0 cannot contain arbitrary terminal control characters.
  const xml = value => esc(Array.from(String(value)).filter(c => c.charCodeAt(0) >= 32 || [9, 10, 13].includes(c.charCodeAt(0))).join(''));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${cases.length}" failures="${cases.filter(c => c.status === 'fail').length}" skipped="${cases.filter(c => c.status === 'skip').length}"><testsuite name="MidBrain MCP dry-smoke" tests="${cases.length}" failures="${cases.filter(c => c.status === 'fail').length}" skipped="${cases.filter(c => c.status === 'skip').length}">${cases.map(c => `<testcase classname="${xml(c.group)}" name="${xml(c.name)}" time="${c.time}">${c.status === 'pass' ? '' : c.status === 'skip' ? `<skipped message="${xml(c.detail)}"/>` : `<failure message="${xml(c.detail)}">${xml(c.detail)}</failure>`}</testcase>`).join('')}</testsuite></testsuites>\n`;
}
