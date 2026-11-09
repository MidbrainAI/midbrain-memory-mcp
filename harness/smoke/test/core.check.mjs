import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {SMOKE_API_VERSION,classifyNativeProbe,drySmokeExitCode} from '../index.mjs';
import {createRunContext,childEnv} from '../lib/context.mjs';
import {validateDrySmokeFlags,smokeEnv,DRY_SMOKE_ROWS} from '../lib/dry-smoke-policy.mjs';
import {SMOKE_TOOLS,redactSmoke} from '../lib/dry-smoke-fixture.mjs';
import {renderDrySmokeHtml,renderDrySmokeJUnit} from '../lib/dry-smoke-report.mjs';
import {renderSmokeMarkdown} from '../lib/markdown.mjs';
import {fileHash,assertFilesUnchanged,snapshotFiles} from '../lib/candidate.mjs';
import * as candidateApi from '../lib/candidate.mjs';
import {SMOKE_CLIENTS} from '../clients/index.mjs';
import {SMOKE_KEYS} from '../lib/dry-smoke-fixture.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=action=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-smoke-unit-'));
  try{return action(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}
};
test('versioned API keeps all relative imports inside the component',()=>{
  assert.equal(SMOKE_API_VERSION,1);
  function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,e.name);if(e.isDirectory())walk(file);
    else if(e.name.endsWith('.mjs'))for(const m of fs.readFileSync(file,'utf8').matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g))
      assert.equal(path.relative(root,path.resolve(dir,m[2])).startsWith('..'),false,file);
  }}walk(root);
});
test('CLI help runs from a copied component without a source checkout or dependencies',()=>temporary(dir=>{
  const file=path.join(dir,'cli.mjs');fs.copyFileSync(path.join(root,'cli.mjs'),file);
  const result=spawnSync(process.execPath,[file,'--help'],{cwd:dir,env:childEnv(createRunContext({root:dir})),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/no model calls/);
}));
test('rejects unsupported execution options before preparing a run',()=>{
  for(const key of ['model','api-url','scenarios','config'])assert.throws(()=>validateDrySmokeFlags({[key]:'x'}));
  assert.throws(()=>validateDrySmokeFlags({'candidate-tarball':'x','candidate-sha256':'bad'}));
});
test('never accepts another connected server or an unconnected configuration as proof',()=>{
  assert.equal(classifyNativeProbe('claude',{code:0,stdout:'peer: Connected\nmidbrain-memory: disconnected',stderr:''}).status,'FAIL');
  assert.equal(classifyNativeProbe('codex',{code:0,stdout:'[{"name":"midbrain-memory","enabled":true}]',stderr:''}).status,'BLOCKED');
  assert.equal(classifyNativeProbe('codex',{code:0,stdout:JSON.stringify({kind:'app-server',ok:true,tools:SMOKE_TOOLS}),stderr:''}).status,'PASS');
});
test('incomplete, missing and blocked receipts fail the gate',()=>{
  assert.equal(drySmokeExitCode([],true,true,['claude']),1);
  const cells=DRY_SMOKE_ROWS.map(row=>({row,client:'claude',status:'PASS',checks:[{ok:true}]}));
  assert.equal(drySmokeExitCode(cells,true,true,['claude']),0);
  cells[0].status='BLOCKED';assert.equal(drySmokeExitCode(cells,true,true,['claude']),1);
});
test('isolates child credentials and disables optional network behavior',()=>temporary(dir=>{
  const env=smokeEnv(createRunContext({root:dir}));
  for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GITHUB_TOKEN','MIDBRAIN_API_KEY','MIDBRAIN_ENABLE_PK_INJECTION'])assert.equal(env[key],undefined,key);
  assert.ok(env.HOME.startsWith(dir));assert.ok(env.CODEX_HOME.startsWith(dir));
}));
test('fingerprints the frozen inputs and detects a modified file',()=>temporary(dir=>{
  const file=path.join(dir,'input.json');fs.writeFileSync(file,'{}');const before=snapshotFiles(dir);
  assert.match(fileHash(file),/^[a-f0-9]{64}$/);assertFilesUnchanged(dir,before);
  fs.writeFileSync(file,'{"changed":true}');assert.throws(()=>assertFilesUnchanged(dir,before));
}));
test('source provenance distinguishes a clean commit, local edits and an unavailable checkout',()=>temporary(dir=>{
  const git=args=>{const r=spawnSync('git',args,{cwd:dir,encoding:'utf8',env:{PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull}});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(['init','-q']);
  fs.writeFileSync(path.join(dir,'source.mjs'),'export const value=1;');git(['add','source.mjs']);
  git(['-c','user.name=Smoke fixture','-c','user.email=smoke@example.invalid','commit','-qm','fixture']);
  const sha=git(['rev-parse','HEAD']);
  assert.deepEqual(candidateApi.checkoutIdentity(dir),{sha,dirty:false});
  fs.appendFileSync(path.join(dir,'source.mjs'),'\n// local edit');
  assert.deepEqual(candidateApi.checkoutIdentity(dir),{sha,dirty:true});
  const missing=path.join(dir,'not-a-checkout');
  assert.deepEqual(candidateApi.checkoutIdentity(missing),{sha:null,dirty:null});
}));
test('failed run-local client installation saves redacted diagnostics beside the report',{skip:process.platform==='win32'},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-smoke-client-'));
  try {
    const ctx=createRunContext({root:dir});
    fs.writeFileSync(path.join(ctx.dirs.toolsBin,'npm'),`#!${process.execPath}\nconsole.error(${JSON.stringify('fixture install failure '+SMOKE_KEYS.global)});process.exit(1);`,{mode:0o700});
    await assert.rejects(SMOKE_CLIENTS.claude.preflight(ctx),/evidence\/claude\/dry-smoke\/client-setup.json/);
    const evidence=fs.readFileSync(path.join(ctx.evidenceDir('claude','dry-smoke'),'client-setup.json'),'utf8');
    assert.match(evidence,/fixture install failure/);assert.doesNotMatch(evidence,new RegExp(SMOKE_KEYS.global));
    assert.equal(JSON.parse(evidence).code,1);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('renders failing observations as readable HTML, Markdown and JUnit',()=>{
  const report={run:{kind:'dry-smoke',runId:'unit',complete:true,modelCalls:0,promptCount:0},candidate:{},clients:[{id:'claude',displayName:'Claude'}],
    cells:[{row:'MCP tool contracts',scenario:'dry-smoke',client:'claude',status:'FAIL',checks:[{name:'Exact query preserved',ok:false,detail:'Wrong query <script>'}],evidence:[]}],
    isolation:{ok:true,drift:[]}};
  assert.match(renderDrySmokeHtml(report),/Expected:/);assert.match(renderDrySmokeHtml(report),/&lt;script&gt;/);
  assert.match(renderSmokeMarkdown(report),/Wrong query/);assert.match(renderSmokeMarkdown(report),/FAIL/);
  assert.doesNotMatch(renderSmokeMarkdown(report),/<script>/);
  assert.match(renderDrySmokeJUnit(report),/<failure/);
  assert.doesNotMatch(redactSmoke({value:'synthetic-not-a-real-key'}),/undefined/);
});
test('report gate runs from its copied dependency closure without npm or MCP runtime files',()=>temporary(dir=>{
  for(const file of ['scripts/release-summary.mjs','lib/dry-smoke-policy.mjs','lib/context.mjs','lib/smoke-findings.mjs','lib/evidence-redaction.mjs','lib/dry-smoke-fixture.mjs']){
    const target=path.join(dir,'harness/smoke',file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,file),target);
  }
  const summary=path.join(dir,'summary.md');
  const result=spawnSync(process.execPath,[path.join(dir,'harness/smoke/scripts/release-summary.mjs'),path.join(dir,'missing')],
    {cwd:dir,env:childEnv(createRunContext({root:dir}),{GITHUB_STEP_SUMMARY:summary,RELEASE_CLIENTS:'["claude"]'}),encoding:'utf8'});
  assert.equal(result.status,1,result.stderr);assert.match(fs.readFileSync(summary,'utf8'),/MCP release smoke: FAIL/);
}));
