#!/usr/bin/env node
/**
 * Cursor beforeSubmitPrompt hook wrapper. Always answers {"continue": true}.
 *
 * Cursor holds the prompt until this process exits, so the store runs in a
 * detached background child (store-user.mjs) and this process exits at once.
 * The throttled self-update check also runs in that child, not here.
 */

import { CONTINUE, captureUser, runCursorHook } from "./common.mjs";

runCursorHook(captureUser, CONTINUE, { selfUpdate: false });
