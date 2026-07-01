#!/usr/bin/env node
/**
 * Hermes post_llm_call hook wrapper — captures the assistant response.
 */

import { captureAssistant, runJsonHook } from "./common.mjs";

runJsonHook(captureAssistant);
