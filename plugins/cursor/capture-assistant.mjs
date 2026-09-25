#!/usr/bin/env node
/**
 * Cursor afterAgentResponse hook wrapper. Captures the response; answers {}.
 */

import { captureAssistant, runCursorHook } from "./common.mjs";

runCursorHook(captureAssistant);
