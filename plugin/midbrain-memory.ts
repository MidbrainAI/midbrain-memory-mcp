/**
 * MidBrain Memory OpenCode Plugin
 *
 * Episodic auto-capture: every user + assistant message stored automatically.
 * memory_search lives in the MCP server (server.js), not here.
 *
 * Architecture:
 * - User messages: captured via chat.message hook (fires once, has parts inline)
 * - Assistant messages: captured via message.updated event (fires when message
 *   completes, then one session.message() call to get text parts)
 *
 * Safety:
 * - Exactly 1 API POST per message (no backlog dumps, no history scans)
 * - Directory-based instance filtering (only matching instance processes)
 * - Fire-and-forget: never blocks chat on API response
 */

import { type Plugin } from "@opencode-ai/plugin";
import { readFileSync, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// --- Constants ---
const API_BASE_URL = "https://memory.midbrain.ai";
const EPISODIC_ENDPOINT = `${API_BASE_URL}/api/v1/memories/episodic`;
const KEY_ENV_VAR = "MIDBRAIN_API_KEY";
const KEY_FILENAME = ".midbrain-key";
const GLOBAL_KEY_PATH = join(homedir(), ".config", "opencode", KEY_FILENAME);
const DEBUG_LOG_PATH = join(homedir(), "midbrain-plugin-debug.log");

// --- Utilities ---

function debugLog(msg: string): void {
  const ts = new Date().toISOString();
  try {
    appendFileSync(DEBUG_LOG_PATH, `[${ts}] ${msg}\n`);
  } catch {
    // ignore
  }
}

/**
 * Reads API key with priority:
 * 1. MIDBRAIN_API_KEY env var
 * 2. .midbrain-key in project directory (per-project agent)
 * 3. ~/.config/opencode/.midbrain-key (global fallback)
 */
function loadApiKey(projectDir: string): { key: string | null; source: string } {
  if (process.env[KEY_ENV_VAR]) {
    return { key: process.env[KEY_ENV_VAR]!.trim(), source: "env" };
  }
  const projectKeyPath = join(projectDir, KEY_FILENAME);
  try {
    return { key: readFileSync(projectKeyPath, "utf8").trim(), source: `project:${projectKeyPath}` };
  } catch {
    // fall through
  }
  try {
    return { key: readFileSync(GLOBAL_KEY_PATH, "utf8").trim(), source: `global:${GLOBAL_KEY_PATH}` };
  } catch {
    return { key: null, source: "none" };
  }
}

/**
 * Fire-and-forget POST to the episodic endpoint. Logs result, never throws.
 */
async function storeEpisodic(apiKey: string, text: string, role: "user" | "assistant"): Promise<void> {
  debugLog(`STORE: role=${role} textLen=${text.length}`);
  try {
    const response = await fetch(EPISODIC_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ text, role }),
    });
    debugLog(`RESPONSE: status=${response.status}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog(`STORE ERROR: ${msg}`);
  }
}

// --- Plugin ---

export const MidBrainMemoryPlugin: Plugin = async ({ client, directory }) => {
  const { key: apiKey, source } = loadApiKey(directory);
  debugLog(`INIT: dir=${directory} src=${source} key=${apiKey ? "..." + apiKey.slice(-4) : "null"}`);

  if (!apiKey) {
    console.error(
      `[midbrain-memory] No API key. Set ${KEY_ENV_VAR}, or create .midbrain-key in project or ${GLOBAL_KEY_PATH}`
    );
    return {};
  }

  const storedMessages = new Set<string>();

  return {
    // --- User messages: captured directly from hook (parts are inline) ---
    "chat.message": async (_input, output) => {
      const msg = output.message as Record<string, unknown>;
      const messageID = msg.id as string;
      const parts = output.parts as Array<{ type: string; text?: string }>;

      const text = parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .trim();

      if (!text) return;

      debugLog(`USER: id=${messageID} len=${text.length}`);
      storedMessages.add(messageID);
      storeEpisodic(apiKey, text, "user");
    },

    // --- Assistant messages: captured when message.updated shows completion ---
    event: async ({ event }) => {
      if (event.type !== "message.updated") return;

      const info = (event as any).properties?.info;
      if (!info) return;
      if (info.role !== "assistant") return;
      if (!info.time?.completed) return; // Still streaming, not done yet

      const msgID = info.id as string;
      if (storedMessages.has(msgID)) return;

      // Directory filter: only the matching plugin instance handles this
      const msgDir = info.path?.cwd as string | undefined;
      if (msgDir && msgDir !== directory) return;

      // Mark as seen immediately to prevent other events from re-processing
      storedMessages.add(msgID);

      const sessionID = info.sessionID as string;

      debugLog(`ASSISTANT: id=${msgID} session=${sessionID} fetching parts`);

      try {
        const result = await client.session.message({
          path: { id: sessionID, messageID: msgID },
        });

        if (!result.data) {
          debugLog(`ASSISTANT: no data for ${msgID}`);
          return;
        }

        const data = result.data as {
          info: Record<string, unknown>;
          parts: Array<{ type: string; text?: string }>;
        };

        const text = (data.parts || [])
          .filter((p) => p.type === "text" && typeof p.text === "string")
          .map((p) => p.text as string)
          .join("\n")
          .trim();

        if (!text) {
          debugLog(`ASSISTANT: empty text for ${msgID}`);
          return;
        }

        debugLog(`ASSISTANT: storing id=${msgID} len=${text.length}`);
        storeEpisodic(apiKey, text, "assistant");
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`ASSISTANT ERROR: ${errMsg}`);
      }
    },
  };
};
