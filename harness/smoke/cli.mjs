import {parseArgs} from 'node:util';
import fs from 'node:fs';
const help=`MidBrain MCP package smoke (no model calls)
node harness/smoke/cli.mjs --clients claude,codex --root /tmp/mcp-smoke
  --candidate-tarball FILE --candidate-sha256 SHA256
  --candidate-version VERSION --candidate-source-sha COMMIT
  --install-clients  Install pinned clients inside the run directory
Without an archive, builds and packs this source checkout once.
`;
try {
  const {values}=parseArgs({options:{help:{type:'boolean'},clients:{type:'string'},root:{type:'string'},
    'install-clients':{type:'boolean'},'candidate-tarball':{type:'string'},'candidate-sha256':{type:'string'},
    'candidate-version':{type:'string'},'candidate-source-sha':{type:'string'}}});
  if(values.help)process.stdout.write(help);
  else {
    const {runDrySmoke}=await import('./index.mjs');
    const report=await runDrySmoke({clients:'claude,codex',...values});
    if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`run_dir=${report.run.runDir}\n`);
    if(process.env.GITHUB_STEP_SUMMARY){const {renderSmokeMarkdown}=await import('./index.mjs');fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,renderSmokeMarkdown(report));}
  }
}catch(error){console.error(error.message);process.exitCode=1;}
