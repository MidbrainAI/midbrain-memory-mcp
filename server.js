/**
 * MidBrain Memory MCP Server
 *
 * Exposes a single tool: memory_search
 * Communicates with the MidBrain memory API over HTTPS.
 * Reads API key from env → project .midbrain-key → global ~/.config/opencode/.midbrain-key
 *
 * IMPORTANT: No console.log — corrupts stdio JSON-RPC pipe. Use console.error only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// --- Constants ---
const API_BASE_URL = "https://memory.midbrain.ai";
const SEARCH_ENDPOINT = `${API_BASE_URL}/api/v1/memories/search`;
const DEFAULT_SEARCH_LIMIT = 10;
const KEY_ENV_VAR = "MIDBRAIN_API_KEY";
const KEY_FILENAME = ".midbrain-key";
const GLOBAL_KEY_PATH = join(homedir(), ".config", "opencode", KEY_FILENAME);

/**
 * Reads the API key using priority:
 * 1. MIDBRAIN_API_KEY env var
 * 2. .midbrain-key in MIDBRAIN_PROJECT_DIR (per-project agent)
 * 3. .midbrain-key in process.cwd()
 * 4. ~/.config/opencode/.midbrain-key (global fallback)
 */
function loadApiKey() {
  if (process.env[KEY_ENV_VAR]) {
    return process.env[KEY_ENV_VAR].trim();
  }

  const projectDir = process.env.MIDBRAIN_PROJECT_DIR;
  if (projectDir) {
    try {
      return readFileSync(join(projectDir, KEY_FILENAME), "utf8").trim();
    } catch {
      // fall through
    }
  }

  const localKeyPath = join(process.cwd(), KEY_FILENAME);
  try {
    return readFileSync(localKeyPath, "utf8").trim();
  } catch {
    // fall through
  }

  try {
    return readFileSync(GLOBAL_KEY_PATH, "utf8").trim();
  } catch {
    throw new Error(
      `API key not found. Set ${KEY_ENV_VAR} env var, or create .midbrain-key in your project or ${GLOBAL_KEY_PATH}`
    );
  }
}

/**
 * Searches memories via a single API call. Returns formatted text or error string.
 */
async function searchMemories(query, limit) {
  console.error(`[SEARCH] query="${query}" limit=${limit}`);

  try {
    const apiKey = loadApiKey();
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
