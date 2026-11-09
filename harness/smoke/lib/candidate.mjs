// A run owns one packed candidate. Clients never execute the moving checkout.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, HARNESS_DIR } from './context.mjs';

export function fileHash(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
export function npmCommand(args,{platform=process.platform,node=process.execPath,npmCli=process.env.npm_execpath}={}) {
  if(platform!=='win32')return {cmd:'npm',args};
  const cli=npmCli&&/[\\/]npm-cli\.js$/.test(npmCli)?npmCli:path.win32.join(path.win32.dirname(node),'node_modules','npm','bin','npm-cli.js');
  return {cmd:node,args:[cli,...args]};
}
function command(cmd, args, cwd, env) {
  const launch=cmd==='npm'?npmCommand(args):{cmd,args};
  const r = spawnSync(launch.cmd, launch.args, { cwd, env, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed: ${(r.stderr || r.error?.message || '').slice(-1000)}`);
  return r.stdout.trim();
}
function git(args, root = REPO_ROOT) {
  const r = spawnSync('git', args, { cwd: root, env: {PATH:process.env.PATH,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull}, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
export function checkoutIdentity(root = REPO_ROOT) {
  const status = git(['status', '--porcelain'], root);
  return {sha: git(['rev-parse', 'HEAD'], root), dirty: status === null ? null : Boolean(status)};
}

export function snapshotFiles(root, { include = () => true } = {}) {
  const files = {};
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && include(file)) files[path.relative(root, file)] = fileHash(file);
    }
  }
  visit(root);
  return files;
}
export function assertFilesUnchanged(root, expected) {
  for (const [rel, hash] of Object.entries(expected)) {
    if (fileHash(path.join(root, rel)) !== hash) throw new Error(`Frozen input changed: ${rel}`);
  }
}
export function assertCandidate(candidate) {
  if (!candidate?.files) return;
  assertFilesUnchanged(candidate.repoRoot, candidate.files);
  assertFilesUnchanged(candidate.harness.directory, candidate.harness.files);
  if (fileHash(candidate.tarball) !== candidate.tarballSha256) throw new Error('Frozen candidate tarball changed');
  if (candidate.registry && fileHash(candidate.registry.tarball) !== candidate.registry.publishedSha256) throw new Error('Registry candidate tarball changed');
}

export async function freezeReleaseCandidate({tarball:input,sha256,version,sourceSha,directory,env,runnerRoot=HARNESS_DIR,evaluatorRoot=REPO_ROOT}={}) {
  if(!/^[a-f0-9]{64}$/.test(sha256||''))throw new Error('Release checksum must be an exact SHA-256');
  const stat=lstatSync(input);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>64*1024*1024)throw new Error('Release archive must be a bounded regular file without links');
  if(fileHash(input)!==sha256)throw new Error('Release archive checksum mismatch');
  let dir=directory||mkdtempSync(path.join(os.tmpdir(),'midbrain-release-'));
  mkdirSync(dir,{recursive:true,mode:0o700});
  dir=realpathSync(dir);
  if(readdirSync(dir).length)throw new Error('Release candidate directory must be empty');
  // Never overwrite a previous candidate or an unrelated caller file.
  const tarball=path.join(dir,'release.tgz');
  writeFileSync(tarball,readFileSync(input),{flag:'wx',mode:0o600});
  if(fileHash(tarball)!==sha256)throw new Error('Release archive changed while being copied');
  command('python3',[path.join(HARNESS_DIR,'scripts/unpack-release.py'),tarball,dir],dir,env);
  const unpacked=path.join(dir,'package'),pkg=JSON.parse(readFileSync(path.join(unpacked,'package.json'),'utf8'));
  if(pkg.name!=="midbrain-memory-mcp")throw new Error('Unexpected release package name');
  if(typeof pkg.version!=='string'||(version&&pkg.version!==version))throw new Error('Release package version mismatch');
  for(const name of ['index.js','install.mjs'])if(!lstatSync(path.join(unpacked,name)).isFile())throw new Error('Incomplete release package');
  const payloadFiles=snapshotFiles(unpacked);
  // Install as a consumer dependency: root-level installs also resolve the
  // release's development dependency graph, unlike a normal package consumer.
  const installation=path.join(dir,'installation');mkdirSync(installation);
  command('npm',['install','--prefix',installation,'--omit=dev','--ignore-scripts','--no-audit','--no-fund',tarball],dir,env);
  const repoRoot=path.join(installation,'node_modules',pkg.name);
  assertFilesUnchanged(repoRoot,payloadFiles);
  const candidate={mode:'dev',source:'release-tarball',name:pkg.name,version:pkg.version,sha:sourceSha||null,shortSha:sourceSha?.slice(0,7)||null,
    sourceShaProvenance:'caller-supplied; tarball digest verified, source association not independently attested',
    evaluatorSha:git(['rev-parse','HEAD'],evaluatorRoot),dirty:null,repoRoot,tarball,tarballSha256:sha256,sourceTarballSha256:sha256,payloadFiles,
    dependencySource:'release-manifest-resolved-at-test-time',dependencyLockSha256:fileHash(path.join(installation,'package-lock.json')),
    files:snapshotFiles(repoRoot),harness:{directory:runnerRoot,files:snapshotFiles(runnerRoot,{include:file=>/\.(mjs|json|ts|py)$/.test(file)||path.basename(file)==='Dockerfile'})},
    frozenAt:new Date().toISOString(),installPolicy:'Unmodified archive; dependency lifecycle scripts disabled; product installer invoked explicitly in dev mode'};
  candidate.sourceFiles={...payloadFiles};
  writeFileSync(path.join(dir,'identity.json'),JSON.stringify(candidate,null,2)+'\n',{flag:'wx',mode:0o600});
  return candidate;
}

export async function freezeCandidate({directory,env}={}) {
  const dir=directory||mkdtempSync(path.join(os.tmpdir(),'midbrain-smoke-candidate-'));
  mkdirSync(dir,{recursive:true,mode:0o700});
  const identity = checkoutIdentity();
  command('npm',['run','build:plugin'],REPO_ROOT,env);
  const [pack]=JSON.parse(command('npm',['pack','--json','--ignore-scripts','--pack-destination',dir],REPO_ROOT,env));
  const candidate = await freezeReleaseCandidate({tarball:path.join(dir,pack.filename),sha256:fileHash(path.join(dir,pack.filename)),version:pack.version,
    sourceSha:identity.sha,directory:path.join(dir,'frozen'),env});
  Object.assign(candidate, {dirty:identity.dirty,sourceCheckout:true,
    sourceShaProvenance:'Packed from the local checkout; commit identifies HEAD, not any uncommitted changes. The archive digest identifies tested bytes.'});
  writeFileSync(path.join(path.dirname(candidate.tarball),'identity.json'),JSON.stringify(candidate,null,2)+'\n',{mode:0o600});
  return candidate;
}
