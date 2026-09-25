#!/usr/bin/env node
/**
 * Cursor beforeSubmitPrompt hook wrapper. Always answers {"continue": true}.
 */

import { CONTINUE, captureUser, runCursorHook } from "./common.mjs";

runCursorHook(captureUser, CONTINUE);
