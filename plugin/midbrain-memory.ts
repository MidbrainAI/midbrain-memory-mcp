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
// @ts-ignore — midbrain-common.mjs is copied alongside this file at install time
import { loadApiKey, storeEpisodic, makeDebugLogger } from "./midbrain-common.mjs";

// --- Constants ---
const OPENCODE_CONFIG_DIR = `${process.env.HOME ?? "/tmp"}/.config/opencode`;

// --- Plugin ---

export const MidBrainMemoryPlugin: Plugin = async ({ client, directory }) => {
  const HOME = process.env.HOME ?? "/tmp";
  const debugLog = makeDebugLogger(`${HOME}/midbrain-plugin-debug.log`);

  let apiKey: string;
  try {
    const { key, source } = loadApiKey(directory, OPENCODE_CONFIG_DIR);
    apiKey = key;
    debugLog(`INIT: dir=${directory} src=${source} key=...${key.slice(-4)}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    debugLog(`INIT ERROR: ${msg}`);
    console.error(`[midbrain-memory] ${msg}`);
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
      storeEpisodic(apiKey, text, "user", debugLog);
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
        storeEpisodic(apiKey, text, "assistant", debugLog);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        debugLog(`ASSISTANT ERROR: ${errMsg}`);
      }
    },
  };
};
