/**
 * MidBrain Memory MCP Server
 *
 * Exposes a single tool: memory_search
 * Communicates with the MidBrain memory API over HTTPS.
 * Key priority: project file → client config file → env var → global ~/.config/midbrain/.midbrain-key
 *
 * IMPORTANT: No console.log — corrupts stdio JSON-RPC pipe. Use console.error only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadApiKey, SEARCH_ENDPOINT, DEFAULT_SEARCH_LIMIT, CONFIG_DIR_ENV_VAR } from "./shared/midbrain-common.mjs";

/**
 * Searches memories via a single API call. Returns formatted text or error string.
 */
async function searchMemories(query, limit) {
  console.error(`[SEARCH] query="${query}" limit=${limit}`);

  try {
    const configDir = process.env[CONFIG_DIR_ENV_VAR];
    const { key: apiKey, source } = loadApiKey(undefined, configDir);
    console.error(`[SEARCH] key_source=${source}`);
    const response = await fetch(SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ text: query, limit }),
    });

    console.error(`[SEARCH] status=${response.status}`);

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      return `Memory search failed (${response.status}): ${body}`;
    }

    const results = await response.json();

    if (!Array.isArray(results) || results.length === 0) {
      return "No relevant memories found.";
    }

    return results
      .map((item, idx) => {
        const score = item.score != null ? ` [score: ${item.score.toFixed(3)}]` : "";
        const role = item.role ? `[${item.role}]` : "";
        return `${idx + 1}. ${role}${score}\n${item.text}`;
      })
      .join("\n\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Memory search failed: ${msg}`;
  }
}

// --- MCP Server Setup ---
const server = new McpServer({
  name: "midbrain-memory",
  version: "1.0.0",
});

server.tool(
  "memory_search",
  "Search persistent memory for relevant context from past conversations.",
  {
    query: z.string().describe("The search query to find relevant memories."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(DEFAULT_SEARCH_LIMIT)
      .describe("Maximum number of results to return (default: 10)."),
  },
  async ({ query, limit }) => {
    const text = await searchMemories(query, limit ?? DEFAULT_SEARCH_LIMIT);
    return { content: [{ type: "text", text }] };
  }
);

// --- Start ---
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP server running");
