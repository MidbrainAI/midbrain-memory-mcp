import {smokeReportSummary} from './dry-smoke-report.mjs';
import {smokeFindingsMarkdown,publicSmokeText} from './smoke-findings.mjs';
import {DRY_SMOKE_SCOPE} from './dry-smoke-policy.mjs';
import {reportToolCoverage} from './tool-contracts.mjs';
const esc=value=>publicSmokeText(value).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/\|/g,'\\|').replace(/\r?\n/g,' ');
export function renderSmokeMarkdown(report) {
  const {run,candidate,clients,cells,isolation}=report;
  const summary=smokeReportSummary(report);
  const lines=[`# MidBrain MCP dry-smoke report — run ${esc(run.runId)}`,'',
    `Result: **${summary.outcome}**. FAIL, BLOCKED or incomplete coverage exits nonzero.`, '', DRY_SMOKE_SCOPE, '',
    `Assertions: **${summary.passed}/${summary.assertions} passed** · ${summary.missing.length} missing coverage cells`,'',
    '| Field | Value |','| --- | --- |',`| Candidate | ${esc(candidate.name)} ${esc(candidate.version)} |`,
    `| Candidate source | ${candidate.source==='release-tarball'?'Frozen release archive':'Frozen source package'} |`,
    `| Tested archive SHA-256 | ${esc(candidate.tarballSha256)} |`, `| Source commit | ${esc(candidate.sha)} |`,
    `| Model calls | ${run.modelCalls} |`,`| Prompts | ${run.promptCount} |`,
    `| Isolation | ${isolation?.ok?'PASS':'FAIL'} |`,'','## What needs attention','',smokeFindingsMarkdown(report),'',
    '## Client matrix','',`| Check | ${clients.map(c=>esc(c.displayName)).join(' | ')} |`,
    `| --- | ${clients.map(()=>'---').join(' | ')} |`,
    ...summary.matrix.map(row=>`| ${esc(row.row)} | ${clients.map(c=>esc(row.clients[c.id])).join(' | ')} |`),''];
  for(const client of clients){
    lines.push(`## ${esc(client.displayName)} details`,'','| Check | Result | Observed |','| --- | --- | --- |');
    for(const cell of cells.filter(c=>c.client===client.id)){
      for(const check of cell.checks||[])lines.push(`| ${esc(check.name)} | ${check.ok?'PASS':'FAIL'} | ${esc(check.detail)} |`);
      if(cell.notes||cell.blockedReason)lines.push('',esc(cell.notes||cell.blockedReason),'');
    }
    const preview=report.contextPreviews?.[client.id];
    if(preview){
      lines.push('','### MCP context preview','',`${preview.calls.length} attempts; no model request was created or sent.`);
      for(const [label,ref] of Object.entries(preview.artifacts||{}))lines.push(`- [${esc(label)}](${esc(ref)})`);
      lines.push('','### Per-tool coverage','','| Tool | Discovered | Schema | Positive | Invalid |','| --- | --- | --- | --- | --- |');
      for(const row of reportToolCoverage(report,client.id))lines.push(`| ${esc(row.name)} | ${esc(row.discovered)} | ${esc(row.schema)} | ${esc(row.positive)} | ${esc(row.invalid)} |`);
    }
  }
  return lines.join('\n')+'\n';
}
