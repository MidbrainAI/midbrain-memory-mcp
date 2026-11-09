import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DRY_SMOKE_CLIENTS,drySmokeExitCode} from '../lib/dry-smoke-policy.mjs';
import {publicSmokeText,smokeFindingsMarkdown} from '../lib/smoke-findings.mjs';

export function validateReleaseRuns(runs,{sha256,version,sourceSha,clients=DRY_SMOKE_CLIENTS}) {
  if(!/^[a-f0-9]{64}$/.test(sha256||''))throw Error('Expected release digest is required');
  if(!Array.isArray(clients)||!clients.length||new Set(clients).size!==clients.length||clients.some(id=>!DRY_SMOKE_CLIENTS.includes(id)))throw Error('Invalid required client matrix');
  const seen=new Set(),rows=[];
  for(const report of runs){
    const id=report.clients?.[0]?.id;
    if(report.clients?.length!==1||!clients.includes(id)||seen.has(id))throw Error('Missing, duplicate or unexpected client receipt');
    seen.add(id);
    for(const [field,expected] of Object.entries({source:'release-tarball',tarballSha256:sha256,version,sha:sourceSha})){
      if(report.candidate?.[field]!==expected)throw Error(`Release candidate identity differs for ${id}: ${field}; expected ${expected}, received ${report.candidate?.[field]??'missing'}`);
    }
    if(report.run?.kind!=='dry-smoke'||report.run.modelCalls!==0||report.run.promptCount!==0||!report.clients[0].version||
      drySmokeExitCode(report.cells||[],report.isolation?.ok===true,report.run.complete===true,[id])!==0)throw Error('Incomplete or unsuccessful model-free client evidence');
    if(report.cells.some(cell=>cell.client!==id))throw Error('Receipt contains another client');
    rows.push({client:id,version:report.clients[0].version,status:'PASS'});
  }
  if(clients.some(id=>!seen.has(id)))throw Error('Not all required clients supplied evidence');
  return rows.sort((a,b)=>a.client.localeCompare(b.client));
}
export function releaseSummary(runs,options,{jobResult='success',readErrors=[]}={}) {
  const valid=Array.isArray(runs)?runs.filter(r=>r&&Array.isArray(r.clients)&&r.clients.every(c=>c&&typeof c==='object')&&
    Array.isArray(r.cells)&&r.cells.every(c=>c&&typeof c==='object'&&(c.checks===undefined||Array.isArray(c.checks)&&c.checks.every(k=>k&&typeof k==='object')))&&r.run&&typeof r.run==='object'):[];
  if(!Array.isArray(runs)||valid.length!==runs.length)readErrors=[...readErrors,'A results receipt has an invalid structure; inspect the client artifact.'];
  runs=valid;
  const clients=options.clients||DRY_SMOKE_CLIENTS;
  const md=value=>publicSmokeText(value).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/([\\`*_[\]{}()#!>|])/g,'\\$1').replace(/\r?\n/g,' ');
  let problem='';
  try{validateReleaseRuns(runs,options);}catch(error){problem=error.message;}
  const ok=!problem&&!readErrors.length&&jobResult==='success';
  const lines=[`## MCP release smoke: ${ok?'PASS':'FAIL'}`,'',`Candidate SHA-256: ${md(options.sha256||'Not recorded')}`,'',
    '| Client | Outcome | Assertions |','| --- | --- | --- |'];
  const selected=Array.isArray(clients)?clients:[];
  for(const client of selected){
    const matches=runs.filter(r=>r.clients?.[0]?.id===client);
    let status=matches.length?'DUPLICATE':'MISSING';
    const report=matches.length===1?matches[0]:null;
    if(report){
      try{validateReleaseRuns([report],{...options,clients:[client]});status='PASS';}
      catch{status=report.run?.complete!==true?'INCOMPLETE':report.cells?.some(c=>c.status==='BLOCKED')?'BLOCKED':'FAIL';}
    }
    const checks=report?.cells?.flatMap(c=>c.checks||[])||[];
    lines.push(`| ${md(client)} | ${status} | ${checks.filter(c=>c.ok===true).length}/${checks.length} |`);
  }
  if(problem)lines.push('',`**Gate validation:** ${md(problem)}`);
  if(jobResult!=='success')lines.push('',`**Client jobs:** ${md(jobResult)}. Complete evidence cannot override an unsuccessful job.`);
  for(const error of readErrors)lines.push('',`**Evidence unavailable:** ${md(error)}`);
  for(const report of runs){
    const client=report.clients?.[0]?.id||'unknown';
    lines.push('',`### ${md(client)} details`,smokeFindingsMarkdown(report,{limit:5,links:false}),
      `Download artifact **release-dry-smoke-${md(client)}** and open report.html beside its evidence directory.`);
    if(report.run?.error)lines.push(`**Run error:** ${md(report.run.error)}`);
    if(report.isolation?.ok!==true)lines.push('**Isolation:** not verified clean; inspect isolation.json.');
  }
  lines.push('','Scope: model-free package/MCP smoke only. Production memory quality and model reasoning are not tested.','');
  return {ok,markdown:lines.join('\n')};
}
function resultsBelow(root) {
  const files=[];
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    if(entry.isSymbolicLink())throw Error('Linked evidence is unsupported');
    const file=path.join(root,entry.name);
    if(entry.isDirectory())files.push(...resultsBelow(file));
    else if(entry.name==='results.json')files.push(file);
  }
  return files;
}
export function runSummaryCli(){
  const runs=[],readErrors=[];let clients=[];
  try{clients=JSON.parse(process.env.RELEASE_CLIENTS||JSON.stringify(DRY_SMOKE_CLIENTS));}
  catch{readErrors.push('The expected client list is invalid.');}
  try{
    for(const file of resultsBelow(process.argv[2])){
      try{const report=JSON.parse(fs.readFileSync(file,'utf8'));if(!report||typeof report!=='object')throw Error();runs.push(report);}
      catch{readErrors.push('A results.json receipt is invalid or unreadable; inspect the client artifact.');}
    }
  }catch{readErrors.push('The evidence directory is missing or could not be safely read. Inspect build/client logs and artifact upload.');}
  const result=releaseSummary(runs,{sha256:process.env.RELEASE_SHA256,version:process.env.RELEASE_VERSION,sourceSha:process.env.RELEASE_SOURCE_SHA,clients},
    {jobResult:process.env.RELEASE_JOB_RESULT||'unknown',readErrors});
  if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,result.markdown);
  process.stdout.write(result.markdown);process.exitCode=result.ok?0:1;
}

if(process.argv[1]&&fs.existsSync(process.argv[1])&&import.meta.url===pathToFileURL(fs.realpathSync(process.argv[1])).href)runSummaryCli();
