/**
 * History readers by client id (issue #75). Each reader lists its sessions
 * and reads one of them; see ../plan.mjs for the session shape. Each client
 * registers its reader here.
 */

import { listClaudeSessionFiles, readClaudeSession } from "./claude.mjs";
import { listCodexSessionFiles, readCodexSession } from "./codex.mjs";

export const READERS = {
  claude: { list: listClaudeSessionFiles, read: readClaudeSession },
  codex: { list: listCodexSessionFiles, read: readCodexSession },
};
