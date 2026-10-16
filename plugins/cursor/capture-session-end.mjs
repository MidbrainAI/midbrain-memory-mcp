#!/usr/bin/env node
/**
 * Cursor sessionEnd hook wrapper. Answers {}.
 *
 * Headless `agent -p` fires no prompt/response hooks, so this hands the
 * session transcript to the detached background child (store-user.mjs) and
 * exits at once. The throttled self-update check also runs in that child.
 */

import { captureSessionEnd, runCursorHook } from "./common.mjs";

runCursorHook(captureSessionEnd, {}, { selfUpdate: false });
