import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRunContext,childEnv} from '../lib/context.mjs';

const engine=new URL('../lib/dry-smoke.mjs',import.meta.url).href;
const processes=new URL('../lib/proc.mjs',import.meta.url).href;
function isolated(script) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-smoke-lifecycle-'));
  try {
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
      cwd:root,env:childEnv(createRunContext({root})),encoding:'utf8',timeout:20000,
    });
    assert.equal(result.status,0,result.stderr||result.error?.message);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
}
test('a completed cleanup allows the next smoke invocation to launch processes',()=>isolated(`
  import assert from 'node:assert/strict';
  import {runDrySmoke} from ${JSON.stringify(engine)};
  import {spawnCapture} from ${JSON.stringify(processes)};
  for(let i=0;i<2;i++) {
    const report=await runDrySmoke({clients:'claude',root:process.cwd()},{prepareCandidate:async()=>{
      const child=await spawnCapture(process.execPath,['-e','console.log("launched")']);
      assert.equal(child.code,0,'fresh smoke invocation cannot launch a child');
      assert.equal(child.stdout.trim(),'launched');
      throw Error('Controlled stop after process validation');
    }});
    assert.equal(report.run.error,'Controlled stop after process validation');
  }
  process.exitCode=0;
`));
test('overlapping smoke invocations are refused before creating a second run',()=>isolated(`
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import {runDrySmoke} from ${JSON.stringify(engine)};
  let entered,release;
  const ready=new Promise(resolve=>{entered=resolve;});
  const hold=new Promise(resolve=>{release=resolve;});
  const first=runDrySmoke({clients:'claude',root:process.cwd()},{prepareCandidate:async()=>{
    entered();await hold;throw Error('Controlled stop');
  }});
  await ready;
  const count=fs.readdirSync('runs').length;
  try {
    await assert.rejects(runDrySmoke({clients:'claude',root:process.cwd()},{prepareCandidate:async()=>{throw Error('Unexpected second preparation');}}),/already active|overlap/i);
    assert.equal(fs.readdirSync('runs').length,count);
  } finally { release();await first;process.exitCode=0; }
`));
