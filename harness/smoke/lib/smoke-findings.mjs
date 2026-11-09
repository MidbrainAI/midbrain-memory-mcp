import {redactor} from './evidence-redaction.mjs';
import {SMOKE_KEYS} from './dry-smoke-fixture.mjs';

export function publicSmokeText(value,report={}) {
  return redactor(Object.values(SMOKE_KEYS),report.run?.runDir||'/__unrecorded_run_root__')(String(value??''));
}
export const safeEvidence=ref=>typeof ref==='string'&&/^evidence\/[a-zA-Z0-9_./-]+$/.test(ref)&&!ref.split('/').includes('..');
const next={
  'Clean install':'Inspect the installer logs and required runtime dependencies.',
  'Configuration preservation':'Compare saved configuration and repeat-install evidence.',
  'Configured MCP transport':'Inspect startup/protocol evidence and the failed assertion.',
  'MCP tool contracts':'Compare the tool arguments, response and fixture HTTP request.',
  'MCP failure recovery':'Compare the injected failure with the next call on the same connection.',
  'Project and global isolation':'Inspect project/global credential scope and isolation.json.',
  'Native client discovery':'Check the client version and native-probe.json for startup or discovery errors.',
  Reproducibility:'Compare the frozen package path and recorded archive hashes.',
};
export function smokeFindings(report) {
  return (report.cells||[]).flatMap(cell=>{
    const failed=(cell.checks||[]).filter(c=>c.ok!==true);
    if(cell.status==='PASS'&&!failed.length)return [];
    return (failed.length?failed:[{name:cell.row,detail:cell.blockedReason||cell.notes||'No failed assertion detail was recorded.'}]).map(check=>{
      const tool=/^(?:recovery|schema|invalid):([\w-]+)$/.exec(check.id||'')?.[1];
      const calls=report.contextPreviews?.[cell.client]?.calls;
      const exchanges=(Array.isArray(calls)?calls:[]).filter(c=>c&&check.id&&c.caseId===check.id&&/^[\w-]+$/.test(c.id)&&/^[\w-]+$/.test(cell.client)).map(c=>`${cell.client}-${c.id}`);
      const clean=value=>publicSmokeText(value,report);
      return {client:clean(cell.client),row:clean(cell.row),tool:tool||null,status:cell.status==='PASS'?'FAIL':cell.status,
        expected:clean(check.name||cell.row),observed:clean(check.detail||cell.blockedReason||'The expectation was not verified; inspect the linked evidence.'),
        next:next[cell.row]||'Inspect the recorded evidence before deciding on a fix.',
        evidence:(cell.evidence||[]).filter(safeEvidence),exchanges};
    });
  });
}
export function smokeFindingsMarkdown(report,{limit=20,links=true}={}) {
  const findings=smokeFindings(report);
  if(!findings.length)return 'No failed or blocked checks recorded.';
  const md=value=>String(value).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/([\\`*_[\]{}()#!>|])/g,'\\$1').replace(/\r?\n/g,' ');
  const lines=[];
  for(const f of findings.slice(0,limit)){
    lines.push(`### ${md(f.client)} · ${md(f.row)} — ${md(f.status)}`,
      ...(f.tool?[`**Tool:** ${md(f.tool)}`]:[]),
      `**Expected:** ${md(f.expected)}`,`**Observed:** ${md(f.observed.slice(0,1200))}`,`**Next step:** ${md(f.next)}`);
    for(const ref of f.evidence)lines.push(links?`[Evidence](${ref})`:`Evidence: ${md(ref)}`);
    if(links)for(const id of f.exchanges)lines.push(`[Exact exchange](report.html#${id})`);
    lines.push('');
  }
  if(findings.length>limit)lines.push(`${findings.length-limit} further findings are in the HTML report.`);
  return lines.join('\n\n');
}
