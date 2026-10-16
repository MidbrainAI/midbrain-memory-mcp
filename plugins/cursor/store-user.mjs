#!/usr/bin/env node
/**
 * Detached background child for the Cursor beforeSubmitPrompt and sessionEnd
 * hooks. Usage: node store-user.mjs <job-file>
 *
 * Reads and deletes the private job file, stores the prompt (or, for a
 * sessionEnd job, the transcript's last turn) under a hard time limit (offline
 * cache on expiry), runs the throttled self-update, exits 0.
 * stdio is ignored by the parent; this process never writes to stdout.
 */

import { runBackgroundStore, runSelfUpdate } from "./common.mjs";

try {
  await runBackgroundStore(process.argv[2]);
  await runSelfUpdate();
} catch { /* never fail */ }
process.exit(0);
