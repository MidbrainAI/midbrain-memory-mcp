#!/usr/bin/env node
/**
 * Codex Stop hook wrapper. Stop requires JSON on stdout for exit 0.
 */

import { captureAssistant, runJsonHook } from "./common.mjs";

runJsonHook(captureAssistant, { stdoutJson: true });
