#!/usr/bin/env node
/**
 * Hermes pre_llm_call hook wrapper — captures the user prompt.
 */

import { captureUser, runJsonHook } from "./common.mjs";

runJsonHook(captureUser);
