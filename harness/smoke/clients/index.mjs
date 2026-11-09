import path from 'node:path';
import {mkdirSync,existsSync,symlinkSync} from 'node:fs';
import {spawnCapture} from '../lib/proc.mjs';
import {childEnv} from '../lib/context.mjs';
import {BlockedError} from '../lib/checks.mjs';

const definitions = [
  ['claude','Claude Code','@anthropic-ai/claude-code','2.1.280','.claude/settings.json','{}\n'],
  ['codex','Codex','@openai/codex','0.150.1','.codex/config.toml',''],
  ['opencode','OpenCode','opencode-ai','1.18.32','.config/opencode/opencode.jsonc','{}\n'],
  ['hermes','Hermes',null,null,'.hermes/.harness-keep',''],
  ['pi','Pi','@earendil-works/pi-coding-agent','0.87.1','.pi/agent/settings.json','{}\n'],
];
export const SMOKE_CLIENTS = Object.fromEntries(definitions.map(([id,displayName,pkg,version,file,content]) => [id,{
  id,displayName,binary:id,os:id==='pi'||id==='hermes'?['darwin','linux']:['darwin','linux','win32'],
  detectionFixtures:[{path:file,content}],install:pkg?{kind:'npm',pkg,version}:{kind:'preinstalled',hint:'Install Hermes before selecting this client.'},
  async preflight(ctx) {
    if(!pkg)throw new BlockedError('This client must be installed before the smoke run.');
    const prefix=path.join(ctx.dirs.tools,id);mkdirSync(prefix,{recursive:true});
    const result=await spawnCapture('npm',['install','--prefix',prefix,`${pkg}@${version}`,'--no-audit','--no-fund','--no-package-lock'],
      {cwd:prefix,env:childEnv(ctx,{npm_config_registry:'https://registry.npmjs.org/'}),timeoutMs:180000});
    if(result.code!==0)throw new BlockedError(`Pinned ${id} installation failed; inspect client setup logs.`);
    const target=path.join(prefix,'node_modules','.bin',process.platform==='win32'?`${id}.cmd`:id);
    const link=path.join(ctx.dirs.toolsBin,process.platform==='win32'?`${id}.cmd`:id);
    if(!existsSync(link))symlinkSync(target,link,process.platform==='win32'?'file':undefined);
  },
}]));
export function selectManifests(ids=['claude','codex']) {
  if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!SMOKE_CLIENTS[id]))throw new Error('Choose distinct supported smoke clients.');
  return ids.map(id=>SMOKE_CLIENTS[id]);
}
