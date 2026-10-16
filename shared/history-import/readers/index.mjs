/**
 * History readers by client id (issue #75). Each reader lists its sessions
 * (`list()`, sync or async) and reads one of them; see ./common.mjs for the
 * entry shape.
 */

import { listClaudeSessionFiles, readClaudeSession } from "./claude.mjs";
import { listCodexSessionFiles, readCodexSession } from "./codex.mjs";
import { listCursorSessions, readCursorSession } from "./cursor.mjs";
import { listHermesSessions, readHermesSession } from "./hermes.mjs";
import { listOpenClawSessions, readOpenClawSession } from "./openclaw.mjs";
import { listOpenCodeSessions, readOpenCodeSession } from "./opencode.mjs";
import { listPrimeAgentSessionFiles, readPrimeAgentSession } from "./prime-agent.mjs";

export const READERS = {
  claude: { list: () => listClaudeSessionFiles(), read: readClaudeSession },
  codex: { list: () => listCodexSessionFiles(), read: readCodexSession },
  "prime-agent": { list: () => listPrimeAgentSessionFiles(), read: readPrimeAgentSession },
  openclaw: { list: () => listOpenClawSessions(), read: readOpenClawSession },
  opencode: { list: () => listOpenCodeSessions(), read: readOpenCodeSession },
  hermes: { list: () => listHermesSessions(), read: readHermesSession },
  cursor: { list: () => listCursorSessions(), read: (source) => readCursorSession(source) },
};
