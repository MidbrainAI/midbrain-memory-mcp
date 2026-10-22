#!/usr/bin/env node
/**
 * Codex SessionStart hook wrapper: persona and profile once per session (#61).
 */

import { runJsonHook, sessionStartContext } from "./common.mjs";

runJsonHook(sessionStartContext);
