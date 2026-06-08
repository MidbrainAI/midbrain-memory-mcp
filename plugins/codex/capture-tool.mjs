#!/usr/bin/env node
/**
 * Codex PostToolUse hook wrapper. PostToolUse emits JSON on stdout for exit 0.
 */

import { captureToolUse, runJsonHook } from "./common.mjs";

runJsonHook(captureToolUse, { stdoutJson: true });
