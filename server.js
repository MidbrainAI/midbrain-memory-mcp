#!/usr/bin/env node
/**
 * MidBrain Memory MCP Server
 *
 * Exposes 6 tools: memory_search, grep, get_episodic_memories_by_date,
 * list_files, read_file, memory_setup_project.
 * Communicates with the MidBrain memory API over HTTPS (GET endpoints).
 * Key priority: project file -> client config file -> env var -> global ~/.config/midbrain/.midbrain-key
 * Set MIDBRAIN_PROJECT_DIR in MCP config env to enable per-project key resolution for search.
 *
 * IMPORTANT: No console.log -- corrupts stdio JSON-RPC pipe. Use console.error only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  loadApiKey,
  loadAccountKey,
  isNewerVersion,
  SEARCH_SEMANTIC_ENDPOINT,
  SEARCH_LEXICAL_ENDPOINT,
  EPISODIC_ENDPOINT,
  SEMANTIC_FILES_ENDPOINT,
  DEFAULT_SEARCH_LIMIT,
  CONFIG_DIR_ENV_VAR,
  PROJECT_DIR_ENV_VAR,
  AGENTS_ENDPOINT,
  KEYS_ENDPOINT,
} from "./shared/midbrain-common.mjs";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require("./package.json");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MCP_KEY = "midbrain-memory";
const EPISODIC_PAGE_LIMIT = 1000;

// --- Update check constants (PRD-005) ---
const NPM_REGISTRY_URL = "https://registry.npmjs.org/midbrain-memory-mcp/latest";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const UPDATE_CACHE_FILENAME = ".midbrain-update-check.json";
const UPDATE_FETCH_TIMEOUT_MS = 5000;
const NPX_CACHE_MARKER = "/_npx/";

// ---------------------------------------------------------------------------
// Shared API helper
// ---------------------------------------------------------------------------

/**
 * Makes an authenticated GET request to a MidBrain API endpoint.
 * Appends query parameters, sets Authorization header, returns parsed JSON.
 * @param {string} baseUrl  Full URL of the endpoint (no query string).
 * @param {Record<string, string|number|undefined>} params  Query params (undefined values omitted).
 * @returns {Promise<any>} Parsed JSON body.
 */
async function fetchApi(baseUrl, params = {}) {
  const configDir = process.env[CONFIG_DIR_ENV_VAR];
  const projectDir = process.env[PROJECT_DIR_ENV_VAR] || undefined;
  const { key: apiKey, source } = loadApiKey(projectDir, configDir);

  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  console.error(`[API] url=${url} key_source=${source}`);

  let response = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  // GET→POST fallback: if GET endpoint not yet deployed, retry with legacy POST.
  // Remove this block once Radu confirms GET routes are live on memory.midbrain.ai.
  if (response.status === 404 || response.status === 405) {
    console.error(`[API] GET ${url.toString()} returned ${response.status}, retrying with POST`);
    response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(params),
    });
  }

  console.error(`[API] status=${response.status}`);

  if (!response.ok) {
    const body = await response.text().catch(() => "(no body)");
    throw new Error(`API ${response.status}: ${body}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Account API helpers (memory_manage_agents)
// ---------------------------------------------------------------------------

/** Resolve project directory from env or cwd. */
function resolveProjectDir() {
  const envDir = process.env[PROJECT_DIR_ENV_VAR];
  if (envDir) return envDir;
  return process.cwd();
}

/**
 * Makes an authenticated request to MidBrain account API endpoints.
 * Uses loadAccountKey (not loadApiKey).
 * @returns {Promise<{ ok: boolean, data?: any, error?: string }>}
 */
async function makeAccountApiRequest(url, method, body) {
  const configDir = process.env[CONFIG_DIR_ENV_VAR];
  const projectDir = resolveProjectDir();
  const { key: apiKey } = loadAccountKey(projectDir, configDir);

  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  };
  if (body) options.body = JSON.stringify(body);

  const response = await fetch(url, options);

  if (response.status === 401) {
    return { ok: false, error: "Authentication failed. Your API key may be invalid or expired." };
  }
  if (response.status === 403) {
    return { ok: false, error: "Forbidden. Your API key does not have permission for this operation." };
  }
  if (response.status === 429) {
    return { ok: false, error: "Rate limited. Please wait a moment and try again." };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    return { ok: false, error: `API error (${response.status}): ${text}` };
  }
  if (response.status === 204) return { ok: true, data: null };
  const data = await response.json();
  return { ok: true, data };
}

/** Generate a human-readable key alias: <agent>-<client>-<YYYYMMDD>. */
function generateKeyAlias(agentName) {
  const configDir = process.env[CONFIG_DIR_ENV_VAR] || "";
  let client = "mcp";
  if (configDir.includes("opencode")) client = "opencode";
  else if (configDir.includes("claude")) client = "claude";
  else if (configDir.includes("codex")) client = "codex";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const safeName = agentName.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 50);
  return `${safeName}-${client}-${date}`;
}

/** Write key + project configs after agent create/select. Returns summary lines. */
async function writeProjectSetup(apiKey, agentName) {
  const lines = [];
  const projectDir = resolveProjectDir();
  const HOME = os.homedir();
  const serverPath = path.join(__dirname, "server.js");
  const nodePath = process.execPath;
  const fingerprint = apiKey.length >= 4 ? `...${apiKey.slice(-4)}` : "****";

  // Write key file (overwrite — intentional agent switch)
  const keyDir = path.join(projectDir, ".midbrain");
  const keyFilePath = path.join(keyDir, ".midbrain-key");
  await fs.mkdir(keyDir, { recursive: true });
  await fs.writeFile(keyFilePath, apiKey + "\n", "utf8");
  await fs.chmod(keyFilePath, 0o600);
  lines.push(`Key written: ${keyFilePath} (chmod 600, fingerprint: ${fingerprint})`);

  // Write opencode.json
  const ocConfigPath = path.join(projectDir, "opencode.json");
  const ocConfig = (await readJson(ocConfigPath)) || {};
  if (!ocConfig["$schema"]) ocConfig["$schema"] = "https://opencode.ai/config.json";
  if (ocConfig.mcpServers) delete ocConfig.mcpServers;
  ocConfig.mcp = ocConfig.mcp || {};
  ocConfig.mcp[MCP_KEY] = {
    type: "local",
    command: [nodePath, serverPath],
    environment: {
      MIDBRAIN_CONFIG_DIR: path.join(HOME, ".config", "opencode"),
      MIDBRAIN_PROJECT_DIR: projectDir,
    },
    enabled: true,
  };
  await writeJson(ocConfigPath, ocConfig);
  lines.push(`Config written: ${ocConfigPath}`);

  // Write .mcp.json
  const mcpConfigPath = path.join(projectDir, ".mcp.json");
  const mcpConfig = (await readJson(mcpConfigPath)) || {};
  mcpConfig.mcpServers = mcpConfig.mcpServers || {};
  mcpConfig.mcpServers[MCP_KEY] = {
    command: nodePath,
    args: [serverPath],
    env: {
      MIDBRAIN_CONFIG_DIR: path.join(HOME, ".config", "claude"),
      MIDBRAIN_PROJECT_DIR: projectDir,
    },
  };
  await writeJson(mcpConfigPath, mcpConfig);
  lines.push(`Config written: ${mcpConfigPath}`);

  // Ensure .gitignore has .midbrain-key
  await ensureGitignore(projectDir);

  lines.push(`Agent: ${agentName}`);
  lines.push("");
  lines.push("IMPORTANT: Restart your coding client for the new project config to take effect.");
  return lines;
}

/** Append .midbrain-key to .gitignore if not already present. */
async function ensureGitignore(projectDir) {
  const giPath = path.join(projectDir, ".gitignore");
  let content = "";
  try { content = await fs.readFile(giPath, "utf8"); } catch { /* no .gitignore */ }
  if (!content.includes(".midbrain-key")) {
    const nl = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
    await fs.writeFile(giPath, content + nl + ".midbrain-key\n", "utf8");
  }
}

// ---------------------------------------------------------------------------
// Setup-project helpers (module-level, called from tool handler)
// ---------------------------------------------------------------------------

/** Read and JSON-parse a file. Returns null if file does not exist. */
async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`Failed to parse ${filePath}: ${err.message}`, { cause: err });
  }
}

/** Write object as formatted JSON (creates dirs if needed). */
async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
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

// ---------------------------------------------------------------------------
// memory_manage_agents action handlers
// ---------------------------------------------------------------------------

async function handleListAgents() {
  const result = await makeAccountApiRequest(AGENTS_ENDPOINT, "GET");
  if (!result.ok) return { content: [{ type: "text", text: result.error }] };

  const agents = result.data;
  if (!Array.isArray(agents) || agents.length === 0) {
    return { content: [{ type: "text", text: "No agents found. Use action 'create' to create one." }] };
  }

  const lines = agents.map((a, i) => {
    const desc = a.description ? `\n   Description: ${a.description}` : "";
    const created = a.created_at ? a.created_at.slice(0, 10) : "unknown";
    return `${i + 1}. ${a.name} (id: ${a.agent_id})${desc}\n   Created: ${created}`;
  });
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function handleSelectAgent(agentName) {
  if (!agentName) {
    return { content: [{ type: "text", text: "Error: agent_name is required for 'select'." }] };
  }

  // Fetch agents to find the match
  const listResult = await makeAccountApiRequest(AGENTS_ENDPOINT, "GET");
  if (!listResult.ok) return { content: [{ type: "text", text: listResult.error }] };

  const agents = listResult.data || [];
  const nameLower = agentName.toLowerCase();
  let match = agents.find((a) => a.name.toLowerCase() === nameLower);
  if (!match) match = agents.find((a) => a.name.toLowerCase().includes(nameLower));

  if (!match) {
    const names = agents.map((a) => a.name).join(", ");
    return { content: [{ type: "text", text: `Agent "${agentName}" not found. Available agents: ${names || "(none)"}` }] };
  }

  // Create key for the matched agent
  const alias = generateKeyAlias(match.name);
  const keyResult = await makeAccountApiRequest(KEYS_ENDPOINT, "POST", {
    key_alias: alias,
    agent_id: match.agent_id,
  });
  if (!keyResult.ok) return { content: [{ type: "text", text: `Key creation failed: ${keyResult.error}` }] };

  const fullKey = keyResult.data.key;
  const fingerprint = fullKey.length >= 4 ? `...${fullKey.slice(-4)}` : "****";

  // Write project config
  try {
    const setupLines = await writeProjectSetup(fullKey, match.name);
    return { content: [{ type: "text", text: [`Agent selected: ${match.name}`, `Key fingerprint: ${fingerprint}`, ...setupLines].join("\n") }] };
  } catch (writeErr) {
    const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    return { content: [{ type: "text", text: `Agent selected: ${match.name}\nKey fingerprint: ${fingerprint}\nFile write failed: ${msg}\nManually place the key at <project>/.midbrain/.midbrain-key` }] };
  }
}

async function handleCreateAgent(agentName, agentDescription) {
  if (!agentName) {
    return { content: [{ type: "text", text: "Error: agent_name is required for 'create'." }] };
  }

  // Create the agent
  const body = { name: agentName };
  if (agentDescription) body.description = agentDescription;
  const agentResult = await makeAccountApiRequest(AGENTS_ENDPOINT, "POST", body);
  if (!agentResult.ok) return { content: [{ type: "text", text: `Agent creation failed: ${agentResult.error}` }] };

  const agent = agentResult.data;

  // Create key for the new agent
  const alias = generateKeyAlias(agent.name);
  const keyResult = await makeAccountApiRequest(KEYS_ENDPOINT, "POST", {
    key_alias: alias,
    agent_id: agent.agent_id,
  });
  if (!keyResult.ok) {
    return { content: [{ type: "text", text: `Agent created: ${agent.name} (id: ${agent.agent_id})\nKey creation failed: ${keyResult.error}\nUse 'select' with agent name to retry key creation.` }] };
  }

  const fullKey = keyResult.data.key;
  const fingerprint = fullKey.length >= 4 ? `...${fullKey.slice(-4)}` : "****";

  // Write project config
  try {
    const setupLines = await writeProjectSetup(fullKey, agent.name);
    return { content: [{ type: "text", text: [`Agent created: ${agent.name} (id: ${agent.agent_id})`, `Key fingerprint: ${fingerprint}`, ...setupLines].join("\n") }] };
  } catch (writeErr) {
    const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
    return { content: [{ type: "text", text: `Agent created: ${agent.name} (id: ${agent.agent_id})\nKey fingerprint: ${fingerprint}\nFile write failed: ${msg}\nManually place the key at <project>/.midbrain/.midbrain-key` }] };
  }
}

async function handleListKeys() {
  // Fetch keys and agents in parallel for join
  const [keysResult, agentsResult] = await Promise.all([
    makeAccountApiRequest(KEYS_ENDPOINT, "GET"),
    makeAccountApiRequest(AGENTS_ENDPOINT, "GET"),
  ]);

  if (!keysResult.ok) return { content: [{ type: "text", text: keysResult.error }] };

  const keys = keysResult.data;
  if (!Array.isArray(keys) || keys.length === 0) {
    return { content: [{ type: "text", text: "No API keys found." }] };
  }

  // Build agent name lookup
  const agentMap = {};
  if (agentsResult.ok && Array.isArray(agentsResult.data)) {
    for (const a of agentsResult.data) agentMap[a.agent_id] = a.name;
  }

  const lines = keys.map((k, i) => {
    const agentName = agentMap[k.agent_id] || k.agent_id;
    const budget = k.max_budget != null ? `$${k.spend?.toFixed(2) || "0.00"} / $${k.max_budget.toFixed(2)}` : `$${k.spend?.toFixed(2) || "0.00"}`;
    return `${i + 1}. Alias: ${k.key_alias || "(none)"}\n   Agent: ${agentName}\n   Token: ${k.token}\n   Spend: ${budget}`;
  });
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// ---------------------------------------------------------------------------
// MCP Server Factory
// ---------------------------------------------------------------------------

/**
 * Creates and returns a fully configured McpServer with all tools registered.
 * Does NOT connect a transport -- the caller is responsible for that.
 * @returns {McpServer}
 */
export function createServer() {
  const server = new McpServer({
    name: "midbrain-memory",
    version: PKG_VERSION,
  });

  // --- memory_search (semantic vector search) ---

  server.tool(
    "memory_search",
    `Search memories by semantic similarity.

Results include source path and line numbers for semantic memories.
Use read_file to get more context around a search hit.`,
    {
      query: z.string().describe("Natural language search query."),
      limit: z
        .number().int().min(1).max(50).optional().default(DEFAULT_SEARCH_LIMIT)
        .describe("Maximum number of results to return (default: 10)."),
      memory_type: z
        .enum(["all", "semantic", "episodic"]).optional().default("all")
        .describe('Filter by memory type: "all" (default), "semantic", or "episodic".'),
    },
    async ({ query, limit, memory_type }) => {
      try {
        // Overfetch to compensate for client-side type filtering
        const fetchK = memory_type !== "all" ? (limit ?? DEFAULT_SEARCH_LIMIT) * 3 : (limit ?? DEFAULT_SEARCH_LIMIT);
        const results = await fetchApi(SEARCH_SEMANTIC_ENDPOINT, { query, limit: fetchK });

        if (!Array.isArray(results) || results.length === 0) {
          return { content: [{ type: "text", text: "No memories found matching that query." }] };
        }

        let filtered = results;
        if (memory_type === "semantic") {
          filtered = results.filter((r) => r.role === "external");
        } else if (memory_type === "episodic") {
          filtered = results.filter((r) => r.role !== "external");
        }
        filtered = filtered.slice(0, limit ?? DEFAULT_SEARCH_LIMIT);

        if (filtered.length === 0) {
          return { content: [{ type: "text", text: "No memories found matching that query." }] };
        }

        const lines = filtered.map((item) => {
          const ts = item.occurred_at ? item.occurred_at.slice(0, 16).replace("T", " ") : "unknown";
          const score = item.score != null ? item.score.toFixed(1) : "?";
          const src = item.memory_metadata?.source || "";
          const loc = src ? ` | ${src}:${item.memory_metadata?.line_start ?? "?"}` : "";
          return `[${item.role} | ${ts} | relevance=${score}${loc}] ${item.text}`;
        });

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Memory search failed: ${msg}` }] };
      }
    }
  );

  // --- grep (regex / lexical search) ---

  server.tool(
    "grep",
    `Regex search over semantic memory text, like ripgrep.

Uses POSIX regular expressions (case-insensitive).
Output format: path:lineno: matching line.
Use for exact or pattern-based matches (names, IDs, code, URLs).`,
    {
      pattern: z.string().describe("POSIX regex pattern (case-insensitive)."),
      source: z.string().optional().describe("Restrict search to a specific source file path."),
      limit: z
        .number().int().min(1).max(500).optional().default(50)
        .describe("Max matching lines to return (default: 50)."),
    },
    async ({ pattern, source, limit }) => {
      try {
        const results = await fetchApi(SEARCH_LEXICAL_ENDPOINT, { pattern, source, limit });

        if (!Array.isArray(results) || results.length === 0) {
          return { content: [{ type: "text", text: `No matches for pattern '${pattern}'.` }] };
        }

        const lines = results.map((m) => `${m.source}:${m.line_number}: ${m.text}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("400")) {
          return { content: [{ type: "text", text: `Regex error: ${msg}` }] };
        }
        return { content: [{ type: "text", text: `Grep failed: ${msg}` }] };
      }
    }
  );

  // --- get_episodic_memories_by_date ---

  server.tool(
    "get_episodic_memories_by_date",
    `Retrieve episodic memories (conversations) around a specific date.

Returns them formatted as a natural conversation timeline.
Use this when the user asks about what happened on a particular day or period.`,
    {
      date: z.string().describe("ISO date string, e.g. '2025-06-01'."),
      offset_days: z
        .number().int().min(1).optional().default(1)
        .describe("Number of days to include from the start date (default: 1)."),
    },
    async ({ date, offset_days }) => {
      try {
        const start = new Date(date);
        if (isNaN(start.getTime())) {
          return { content: [{ type: "text", text: `Invalid date format: '${date}'. Use ISO format, e.g. '2025-06-01'.` }] };
        }
        const end = new Date(start);
        end.setDate(end.getDate() + Math.max(offset_days ?? 1, 1));

        const result = await fetchApi(EPISODIC_ENDPOINT, {
          page: 1,
          limit: EPISODIC_PAGE_LIMIT,
          start_date: start.toISOString(),
          end_date: end.toISOString(),
        });

        const items = result.items || [];
        if (items.length === 0) {
          const startStr = start.toISOString().slice(0, 10);
          const endStr = end.toISOString().slice(0, 10);
          return { content: [{ type: "text", text: `No episodic memories found between ${startStr} and ${endStr}.` }] };
        }

        // API returns newest-first; reverse for chronological timeline
        items.reverse();

        const lines = items.map((mem) => {
          const ts = mem.occurred_at ? mem.occurred_at.slice(0, 16).replace("T", " ") : "unknown";
          return `${ts} [${mem.role}]: ${mem.text}`;
        });

        // Warn if results were truncated
        if (result.total > items.length) {
          lines.push(`\n(showing ${items.length} of ${result.total} memories)`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to retrieve episodic memories: ${msg}` }] };
      }
    }
  );

  // --- list_files ---

  server.tool(
    "list_files",
    `List all documents stored in semantic memory.

Returns filenames with chunk counts.
Use this to discover what knowledge files are available.`,
    {},
    async () => {
      try {
        const docs = await fetchApi(SEMANTIC_FILES_ENDPOINT);

        if (!Array.isArray(docs) || docs.length === 0) {
          return { content: [{ type: "text", text: "No files found in semantic memory." }] };
        }

        const lines = docs.map((d) => `  ${d.source}  (${d.chunk_count} chunks)`);
        return { content: [{ type: "text", text: `Files (${docs.length}):\n${lines.join("\n")}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to list files: ${msg}` }] };
      }
    }
  );

  // --- read_file ---

  server.tool(
    "read_file",
    `Read a document from semantic memory by line range.

Returns numbered lines like a file viewer. Use after list_files or
after memory_search to read context around a search hit.`,
    {
      file_path: z.string().describe("Path of the file to read (as returned by list_files or memory_search)."),
      start_line: z
        .number().int().min(1).optional().default(1)
        .describe("First line to read, 1-indexed (default: 1)."),
      num_lines: z
        .number().int().min(1).max(5000).optional().default(200)
        .describe("Number of lines to read (default: 200)."),
    },
    async ({ file_path, start_line, num_lines }) => {
      try {
        const url = `${SEMANTIC_FILES_ENDPOINT}/${encodeURIComponent(file_path).replace(/%2F/g, "/")}`;
        const result = await fetchApi(url, { start_line, num_lines });

        return { content: [{ type: "text", text: `${result.path}:${result.start_line}\n${result.content}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("404")) {
          return { content: [{ type: "text", text: `No content found for '${file_path}' at line ${start_line ?? 1}.` }] };
        }
        return { content: [{ type: "text", text: `Failed to read file: ${msg}` }] };
      }
    }
  );

  // --- memory_setup_project ---

  server.tool(
    "memory_setup_project",
    "Set up per-project MidBrain memory. ALWAYS use this tool when the user asks to configure, set up, or initialize MidBrain memory for a project. This tool creates the .midbrain/.midbrain-key file (chmod 600), writes the project-level MCP config (opencode.json or .mcp.json), and sets correct permissions. Do NOT manually create key files or configs with shell commands -- this tool handles all edge cases including path resolution, config merging, and permission setting.",
    {
      project_dir: z.string().describe("Absolute path to the project root directory."),
      api_key: z.string().optional().describe("MidBrain API key. If omitted, uses the server's current key."),
    },
    async ({ project_dir, api_key }) => {
      const text = await setupProject(project_dir, api_key);
      return { content: [{ type: "text", text }] };
    }
  );

  // --- memory_manage_agents ---

  server.tool(
    "memory_manage_agents",
    "Manage MidBrain memory agents and API keys. List agents, select an agent for this project, create new agents, or list API keys. Requires MIDBRAIN_ACCOUNT_KEY to be set.",
    {
      action: z.enum(["list", "select", "create", "list_keys"])
        .describe('list: show all agents | select: wire existing agent to this project | create: new agent + key + project config | list_keys: audit all keys'),
      agent_name: z.string().min(1).max(200).optional()
        .describe("Agent name. Required for 'create'. For 'select', matches by name (case-insensitive, partial match allowed)."),
      agent_description: z.string().max(1000).optional()
        .describe("Agent description. Optional, used only with 'create'."),
    },
    async ({ action, agent_name, agent_description }) => {
      try {
        switch (action) {
          case "list": return await handleListAgents();
          case "select": return await handleSelectAgent(agent_name);
          case "create": return await handleCreateAgent(agent_name, agent_description);
          case "list_keys": return await handleListKeys();
          default:
            return { content: [{ type: "text", text: `Unknown action: ${action}` }] };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Agent management failed: ${msg}` }] };
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Update check (PRD-005): fire-and-forget npm registry check with 24h cache
// ---------------------------------------------------------------------------

async function isUpdateCacheFresh(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    const cache = JSON.parse(raw);
    return (Date.now() - cache.lastCheck) < UPDATE_CHECK_INTERVAL_MS;
  } catch {
    return false;
  }
}

async function checkForUpdate() {
  try {
    if (__dirname.includes(NPX_CACHE_MARKER)) return;

    const cachePath = path.join(os.tmpdir(), UPDATE_CACHE_FILENAME);
    if (await isUpdateCacheFresh(cachePath)) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPDATE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
      if (!response.ok) return;

      const data = await response.json();
      const latestVersion = data.version;

      const cacheData = JSON.stringify({ lastCheck: Date.now(), latestVersion });
      await fs.writeFile(cachePath, cacheData, "utf8").catch(() => {});

      if (isNewerVersion(PKG_VERSION, latestVersion)) {
        console.error(
          `[midbrain] Update available: ${PKG_VERSION} -> ${latestVersion}. ` +
          `Run: npm update -g midbrain-memory-mcp`
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Silently swallow all errors -- never crash, never block
  }
}

// --- Start (only when run directly, not when imported) ---
import { realpathSync } from 'fs';
const isMain = process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP server running");
  checkForUpdate(); // fire-and-forget -- no await (PRD-005)
}
