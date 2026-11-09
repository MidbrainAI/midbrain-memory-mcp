// Use the installed Pi runtime to load the installed extension. Never call prompt().
import { pathToFileURL } from 'node:url';
import { SMOKE_TOOLS } from './dry-smoke-fixture.mjs';
let session;
let receipt;
try {
  const sdk = await import(pathToFileURL(process.argv[2]));
  const result = await sdk.createAgentSession({ cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR, sessionManager: sdk.SessionManager.inMemory() });
  session = result.session;
  // Older Pi releases defer session_start until the host binds extensions.
  if (session.bindExtensions && !session.getActiveToolNames().some(n => n.startsWith('midbrain_'))) await session.bindExtensions({});
  const names = session.getActiveToolNames();
  const missing = SMOKE_TOOLS.filter(name => !names.includes(`midbrain_${name}`));
  receipt = { ok: missing.length === 0, detail: missing.length ? `Pi runtime did not expose: ${missing.join(', ')}` : 'Installed Pi runtime loaded the installed extension and exposed all 12 MidBrain tools without a model prompt.', tools: names, extensionErrors: result.extensionsResult?.errors || [] };
} catch (error) { receipt = { ok: false, detail: error.message }; }
finally {
  // SDK hosts own lifecycle delivery; dispose() alone leaves extension MCP children alive.
  if (session) {
    try { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); }
    catch (error) { receipt = { ...receipt, ok: false, detail: `Pi shutdown failed: ${error.message}` }; }
    finally { await session.dispose(); }
  }
}
console.log(JSON.stringify(receipt));
