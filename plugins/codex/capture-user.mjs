#!/usr/bin/env node
/**
 * Codex UserPromptSubmit hook wrapper.
 */

import { captureUser, runJsonHook } from "./common.mjs";

runJsonHook(captureUser);
