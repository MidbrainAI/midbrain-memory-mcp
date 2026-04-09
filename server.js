#!/usr/bin/env node
/**
 * MidBrain Memory MCP Server
 *
 * Exposes two tools: memory_search, memory_setup_project
 * Communicates with the MidBrain memory API over HTTPS.
 * Key priority: project file → client config file → env var → global ~/.config/midbrain/.midbrain-key
 * Set MIDBRAIN_PROJECT_DIR in MCP config env to enable per-project key resolution for search.
 *
 * IMPORTANT: No console.log — corrupts stdio JSON-RPC pipe. Use console.error only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadApiKey, SEARCH_ENDPOINT, DEFAULT_SEARCH_LIMIT, CONFIG_DIR_ENV_VAR, PROJECT_DIR_ENV_VAR } from "./shared/midbrain-common.mjs";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("./package.json");

// Script-relative path resolution (C-7: import.meta.url for repo root)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MCP_KEY = "midbrain-memory";

/**
 * Searches memories via a single API call. Returns formatted text or error string.
 */
async function searchMemories(query, limit) {
  console.error(`[SEARCH] query="${query}" limit=${limit}`);

  try {
    const configDir = process.env[CONFIG_DIR_ENV_VAR];
    const projectDir = process.env[PROJECT_DIR_ENV_VAR] || undefined;
    const { key: apiKey, source } = loadApiKey(projectDir, configDir);
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
  version: PKG_VERSION,
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

// ---------------------------------------------------------------------------
// Tool: memory_setup_project
// ---------------------------------------------------------------------------

/** Read and JSON-parse a file. Returns null if file does not exist. */
async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }
}

/** Write object as formatted JSON (creates dirs if needed). */
async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/**
 * Reads existing JSON config at filePath, sets a nested key, writes back.
 * keyPath is an array like ["mcp", "midbrain-memory"]. Merge-safe (C-5).
 */
async function mergeConfig(filePath, keyPath, entry) {
  const config = (await readJson(filePath)) || {};
  let target = config;
  for (let i = 0; i < keyPath.length - 1; i++) {
    target[keyPath[i]] = target[keyPath[i]] || {};
    target = target[keyPath[i]];
  }
  target[keyPath[keyPath.length - 1]] = entry;
  await writeJson(filePath, config);
}

/**
 * Sets up per-project memory: key file + MCP config.
 * Returns a human-readable summary string. Never throws (C-2).
 */
async function setupProject(projectDir, apiKeyParam) {
  try {
    const lines = [];
    const HOME = os.homedir();
    const serverPath = path.join(__dirname, "server.js");
    const nodePath = process.execPath; // C-3

    // Validate project_dir
    if (!path.isAbsolute(projectDir)) {
      return `Error: project_dir must be an absolute path. Got: "${projectDir}"`;
    }

    let resolvedDir;
    try {
      const stat = await fs.stat(projectDir);
      if (!stat.isDirectory()) {
        return `Error: "${projectDir}" is not a directory.`;
      }
      resolvedDir = await fs.realpath(projectDir);
      if (resolvedDir !== projectDir) {
        lines.push(`Warning: symlink resolved: "${projectDir}" -> "${resolvedDir}"`);
        console.error(`[SETUP] symlink resolved: ${projectDir} -> ${resolvedDir}`);
      }
    } catch (err) {
      if (err.code === "ENOENT") return `Error: directory does not exist: "${projectDir}"`;
      return `Error: cannot access "${projectDir}": ${err.message}`;
    }

    // Resolve API key
    let apiKey;
    let keySource;
    if (apiKeyParam) {
      apiKey = apiKeyParam.trim();
      keySource = "parameter";
    } else {
      try {
        const configDir = process.env[CONFIG_DIR_ENV_VAR];
        const result = loadApiKey(resolvedDir, configDir);
        apiKey = result.key;
        keySource = result.source;
      } catch (err) {
        return `Error: ${err.message}`;
      }
    }

    const fingerprint = apiKey.length >= 4 ? `...${apiKey.slice(-4)}` : "****";
    console.error(`[SETUP] key_source=${keySource} fingerprint=${fingerprint}`);

    // Create .midbrain/.midbrain-key (C-9: guard existing)
    const keyFilePath = path.join(resolvedDir, ".midbrain", ".midbrain-key");
    let existingKey;
    try {
      existingKey = (await fs.readFile(keyFilePath, "utf8")).trim() || null;
    } catch {
      existingKey = null;
    }

    if (existingKey) {
      lines.push(`Existing key file preserved at ${keyFilePath}`);
    } else {
      await fs.mkdir(path.dirname(keyFilePath), { recursive: true });
      await fs.writeFile(keyFilePath, apiKey + "\n", "utf8");
      await fs.chmod(keyFilePath, 0o600);
      lines.push(`Key file created: ${keyFilePath} (chmod 600)`);
    }

    // Detect client from MIDBRAIN_CONFIG_DIR
    const configDir = process.env[CONFIG_DIR_ENV_VAR] || "";
    const isOpenCode = configDir.includes("opencode");
    const isClaude = configDir.includes("claude");

    if (isOpenCode) {
      const configPath = path.join(resolvedDir, "opencode.json");
      const config = (await readJson(configPath)) || {};
      if (!config["$schema"]) config["$schema"] = "https://opencode.ai/config.json";
      if (config.mcpServers) {
        delete config.mcpServers;
        lines.push("Removed invalid mcpServers key from opencode.json");
      }
      config.mcp = config.mcp || {};
      config.mcp[MCP_KEY] = {
        type: "local",
        command: [nodePath, serverPath],
        environment: {
          MIDBRAIN_CONFIG_DIR: path.join(HOME, ".config", "opencode"),
          MIDBRAIN_PROJECT_DIR: resolvedDir,
        },
        enabled: true,
      };
      await writeJson(configPath, config);
      lines.push(`Config written: ${configPath}`);
    } else if (isClaude) {
      const configPath = path.join(resolvedDir, ".mcp.json");
      const config = (await readJson(configPath)) || {};
      config.mcpServers = config.mcpServers || {};
      config.mcpServers[MCP_KEY] = {
        command: nodePath,
        args: [serverPath],
        env: {
          MIDBRAIN_CONFIG_DIR: path.join(HOME, ".config", "claude"),
          MIDBRAIN_PROJECT_DIR: resolvedDir,
        },
      };
      await writeJson(configPath, config);
      lines.push(`Config written: ${configPath}`);
    } else {
      lines.push("Warning: could not detect client from MIDBRAIN_CONFIG_DIR. No config written.");
    }

    lines.push("");
    lines.push("IMPORTANT: You MUST tell the user to restart this application (OpenCode / Claude Code) for the new project memory to take effect. The current session is still using the previous API key. Memory will not be stored to the new project agent until after restart.");

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error setting up project: ${msg}`;
  }
}

server.tool(
  "memory_setup_project",
  "Set up per-project MidBrain memory. ALWAYS use this tool when the user asks to configure, set up, or initialize MidBrain memory for a project. This tool creates the .midbrain/.midbrain-key file (chmod 600), writes the project-level MCP config (opencode.json or .mcp.json), and sets correct permissions. Do NOT manually create key files or configs with shell commands — this tool handles all edge cases including path resolution, config merging, and permission setting.",
  {
    project_dir: z.string().describe("Absolute path to the project root directory."),
    api_key: z.string().optional().describe("MidBrain API key. If omitted, uses the server's current key."),
  },
  async ({ project_dir, api_key }) => {
    const text = await setupProject(project_dir, api_key);
    return { content: [{ type: "text", text }] };
  }
);

// --- Start ---
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP server running");
