#!/usr/bin/env node
/**
 * Cursor postToolUse hook wrapper. Buffers the tool event; answers {}.
 */

import { captureToolUse, runCursorHook } from "./common.mjs";

runCursorHook(captureToolUse);
