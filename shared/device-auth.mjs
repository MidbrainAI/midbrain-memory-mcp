/**
 * shared/device-auth.mjs
 *
 * Device-code authorization flow for the CLI installer.
 * Authenticates the user via their browser session (Cognito) to
 * auto-provision an agent + API key without manual copy-pasting.
 *
 * Flow:
 *   1. POST /api/v1/auth/device/authorize → device_code + user_code
 *   2. Open browser to verification_uri
 *   3. Poll POST /api/v1/auth/device/token until approved
 *   4. User selects/creates agent in CLI
 *   5. POST /api/v1/auth/device/finalize → API key
 *
 * Node 20+. No npm deps (native fetch + child_process).
 */

import { spawn } from 'node:child_process';
import readline from 'readline';
import { MidbrainApi } from './midbrain-api.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a URL in the user's default browser. Fire-and-forget. */
function openBrowser(url) {
  let child;
  if (process.platform === 'win32') {
    child = spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
  } else if (process.platform === 'darwin') {
    child = spawn('open', [url], { stdio: 'ignore' });
  } else {
    child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
  }
  child.unref();
  child.on('error', () => { /* ignore — user can open manually */ });
}

/** Sleep for ms milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prompt for a single line of input. */
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Device authorization flow
// ---------------------------------------------------------------------------

/**
 * Run the full device-code authorization flow.
 *
 * @param {object} [opts]
 * @param {string} [opts.baseUrl] - API base URL (default: production).
 * @returns {Promise<{apiKey: string, agentId: string, agentName: string, keyAlias: string}>}
 * @throws On network errors, expiry, or user cancellation.
 */
export async function deviceCodeLogin(opts = {}) {
  const baseUrl = (opts.baseUrl || MidbrainApi.API_BASE_URL).replace(/\/+$/, '');

  // Step 1: Request device authorization
  console.error('');
  console.error('MidBrain Memory — Device Authorization');
  console.error('');

  const authorizeUrl = `${baseUrl}/api/v1/auth/device/authorize`;
  const authResp = await fetch(authorizeUrl, { method: 'POST' });
  if (!authResp.ok) {
    const body = await authResp.text().catch(() => '');
    throw new Error(`Failed to start device authorization (${authResp.status}): ${body}`);
  }
  const authData = await authResp.json();
  const { device_code, verification_uri, interval = 5 } = authData;

  // Step 2: Open browser — verification_uri already contains the code in the path
  openBrowser(verification_uri);

  console.error('  A browser window will open to complete authentication.');
  console.error(`  If it doesn't open, visit: ${verification_uri}`);
  console.error('');

  // Step 3: Poll for approval
  console.error('  Waiting for authorization... (press Ctrl+C to cancel)');

  const tokenUrl = `${baseUrl}/api/v1/auth/device/token`;
  let tokenData;

  while (true) {
    await sleep(interval * 1000);

    const pollResp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code }),
    });

    if (pollResp.status === 410) {
      throw new Error('Device code expired. Please run the installer again.');
    }
    if (pollResp.status === 429) {
      // Polling too fast — back off
      await sleep(2000);
      continue;
    }

    const body = await pollResp.json();

    if (body.error === 'authorization_pending') {
      continue;
    }

    if (body.status === 'approved') {
      tokenData = body;
      break;
    }

    // Unexpected response
    throw new Error(`Unexpected response from authorization server: ${JSON.stringify(body)}`);
  }

  console.error(`  ✓ Authorized as ${tokenData.email}`);
  console.error('');

  // Step 4: Agent selection
  const { agents } = tokenData;
  let agentId = null;
  let agentName;

  if (agents.length === 0) {
    // No agents — auto-create one
    agentName = 'My Agent';
    console.error(`  Creating agent "${agentName}"...`);
  } else {
    // Show agent picker
    console.error('  You have existing agents:');
    agents.forEach((a, i) => {
      console.error(`    [${i + 1}] ${a.name}`);
    });
    console.error(`    [${agents.length + 1}] Create a new agent`);
    console.error('');

    const choice = await prompt(`  Select an agent (1-${agents.length + 1}): `);
    const choiceNum = parseInt(choice, 10);

    if (isNaN(choiceNum) || choiceNum < 1 || choiceNum > agents.length + 1) {
      throw new Error('Invalid selection. Please run the installer again.');
    }

    if (choiceNum <= agents.length) {
      // Existing agent
      const selected = agents[choiceNum - 1];
      agentId = selected.agent_id;
      agentName = selected.name;
    } else {
      // New agent
      agentName = await prompt('  Agent name: ');
      if (!agentName) {
        agentName = 'My Agent';
      }
      console.error(`  Creating agent "${agentName}"...`);
    }
  }

  // Step 5: Finalize — create API key
  const finalizeUrl = `${baseUrl}/api/v1/auth/device/finalize`;
  const finalizeBody = agentId
    ? { device_code, agent_id: agentId }
    : { device_code, agent_name: agentName };

  const finalizeResp = await fetch(finalizeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(finalizeBody),
  });

  if (!finalizeResp.ok) {
    const errBody = await finalizeResp.text().catch(() => '');
    throw new Error(`Failed to finalize device authorization (${finalizeResp.status}): ${errBody}`);
  }

  const result = await finalizeResp.json();

  if (agentId) {
    console.error(`  ✓ API key created for "${result.agent_name}" (${result.key_alias})`);
  } else {
    console.error(`  ✓ Agent "${result.agent_name}" created`);
    console.error(`  ✓ API key created (${result.key_alias})`);
  }
  console.error('');

  return {
    apiKey: result.api_key,
    agentId: result.agent_id,
    agentName: result.agent_name,
    keyAlias: result.key_alias,
  };
}
