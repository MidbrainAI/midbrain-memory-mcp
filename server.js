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
  isNewerVersion,
  SEARCH_SEMANTIC_ENDPOINT,
  SEARCH_LEXICAL_ENDPOINT,
  EPISODIC_ENDPOINT,
  SEMANTIC_FILES_ENDPOINT,
  DEFAULT_SEARCH_LIMIT,
  CONFIG_DIR_ENV_VAR,
  PROJECT_DIR_ENV_VAR,
  buildMcpCommandSpec,
  toOpenCodeShape,
  toClaudeShape,
  normalizeMcpEntry,
  detectMcpSpecShape,
} from "./shared/midbrain-common.mjs";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { parse as jsoncParse, modify as jsoncModify, applyEdits } from "jsonc-parser";

const require = createRequire(import.meta.url);
// Read package.json version defensively (PRD-010 §3.4 / §10 edge case):
// missing or corrupt package.json must NOT crash the server; fall back
// to "unknown" and let startup continue so the user at least gets an
// MCP server. The stderr log will read "v unknown" in that case.
let PKG_VERSION = "unknown";
try {
  const pkg = require("./package.json");
  if (pkg && typeof pkg.version === "string" && pkg.version) {
    PKG_VERSION = pkg.version;
  }
} catch {
  // swallow — PKG_VERSION already defaults to "unknown"
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MCP_KEY = "midbrain-memory";
const EPISODIC_PAGE_LIMIT = 1000;
const JSONC_FORMAT = { tabSize: 2, insertSpaces: true, eol: "\n" };

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
// Setup-project helpers (module-level, called from tool handler)
// ---------------------------------------------------------------------------

/** Read and parse a JSON/JSONC file. Returns null if file does not exist. */
async function readJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const errors = [];
    const result = jsoncParse(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      throw new SyntaxError(`Invalid JSON/JSONC content (${errors.length} error(s))`);
    }
    return result;
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
 * Resolves which OpenCode config file exists in a directory.
 * Prefers .jsonc over .json (matches OpenCode's own resolution order).
 */
function resolveOpencodeConfig(dir) {
  const jsoncPath = path.join(dir, "opencode.jsonc");
  if (existsSync(jsoncPath)) return jsoncPath;
  const jsonPath = path.join(dir, "opencode.json");
  if (existsSync(jsonPath)) return jsonPath;
  return jsonPath;
}

/**
 * Sets up per-project memory: key file + MCP config.
 * Returns a human-readable summary string. Never throws (C-2).
 */
async function setupProject(projectDir, apiKeyParam) {
  try {
    const lines = [];
    const HOME = os.homedir();

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

    // PRD-009: detect ALL installed clients, write configs for each (bidirectional)
    const configDir = process.env[CONFIG_DIR_ENV_VAR] || "";
    const hasOpenCode = configDir.includes("opencode") || existsSync(path.join(HOME, ".config", "opencode"));
    const hasClaude = existsSync(path.join(HOME, ".claude.json"));

    if (hasOpenCode) {
      try {
        const ocResult = await migrateOpenCodeConfig(resolvedDir, HOME);
        lines.push(...ocResult);
      } catch (err) {
        // PRD-010 AC-3: partial failure surfaces per-file error with
        // no rollback. Do NOT let a Claude-side failure later in this
        // function discard an already-successful OpenCode summary.
        lines.push(`Error migrating OpenCode config: ${err.message}`);
      }
    }

    if (hasClaude) {
      try {
        const ccResult = await migrateClaudeConfigs(resolvedDir, HOME);
        lines.push(...ccResult);
      } catch (err) {
        lines.push(`Error migrating Claude config: ${err.message}`);
      }
    }

    if (!hasOpenCode && !hasClaude) {
      lines.push("Warning: could not detect any installed clients. No config written.");
    }

    lines.push("");
    lines.push("IMPORTANT: You MUST tell the user to restart this application (OpenCode / Claude Code) for the new project memory to take effect. The current session is still using the previous API key. Memory will not be stored to the new project agent until after restart.");

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error setting up project: ${msg}`;
  }
}

/**
 * Writes / migrates the OpenCode project config. Returns summary lines.
 * Detects stale midbrain-memory entries and rewrites them to @latest,
 * preserving sibling MCP servers and custom env vars.
 */
async function migrateOpenCodeConfig(resolvedDir, HOME) {
  const out = [];
  const configPath = resolveOpencodeConfig(resolvedDir);
  const configBasename = path.basename(configPath);
  const config = (await readJson(configPath)) || {};

  const existingEntry = config.mcp && config.mcp[MCP_KEY];
  const { stale, reason, extraEnv } = classifyEntry(existingEntry, "opencode");

  const modifications = [];
  if (!config["$schema"]) {
    modifications.push({ path: ["$schema"], value: "https://opencode.ai/config.json" });
  }
  if (config.mcpServers) {
    modifications.push({ path: ["mcpServers"], value: undefined });
    out.push("Removed invalid mcpServers key from " + configBasename);
  }

  // Skip rewrite if already at @latest, explicitly pinned, or unknown shape.
  const shouldWrite = reason === "missing" || stale;
  if (shouldWrite) {
    const spec = buildMcpCommandSpec({
      configDir: path.join(HOME, ".config", "opencode"),
      projectDir: resolvedDir,
    });
    const shaped = toOpenCodeShape(spec);
    // Preserve custom env vars
    shaped.environment = { ...extraEnv, ...shaped.environment };
    modifications.push({ path: ["mcp", MCP_KEY], value: shaped });
  }

  if (modifications.length > 0) {
    await patchJsonFile(configPath, modifications);
  }
  out.push(formatMigrationLine(configPath, reason));
  return out;
}

/**
 * Writes / migrates both Claude config locations: <proj>/.mcp.json and
 * ~/.claude.json project-local scope. Returns summary lines.
 */
async function migrateClaudeConfigs(resolvedDir, HOME) {
  const out = [];

  // 1. <project>/.mcp.json
  const mcpJsonPath = path.join(resolvedDir, ".mcp.json");
  const mcpJson = (await readJson(mcpJsonPath)) || {};
  mcpJson.mcpServers = mcpJson.mcpServers || {};
  const { stale: mcpStale, reason: mcpReason, extraEnv: mcpExtraEnv } =
    classifyEntry(mcpJson.mcpServers[MCP_KEY], "claude");
  if (mcpReason === "missing" || mcpStale) {
    const spec = buildMcpCommandSpec({
      configDir: path.join(HOME, ".config", "claude"),
      projectDir: resolvedDir,
    });
    const shaped = toClaudeShape(spec);
    shaped.env = { ...mcpExtraEnv, ...shaped.env };
    mcpJson.mcpServers[MCP_KEY] = shaped;
    await writeJson(mcpJsonPath, mcpJson);
  }
  out.push(formatMigrationLine(mcpJsonPath, mcpReason));

  // 2. ~/.claude.json project-local scope (bypass trust gate)
  const claudeJsonPath = path.join(HOME, ".claude.json");
  try {
    const claudeJson = (await readJson(claudeJsonPath)) || {};
    const projectEntry =
      claudeJson.projects
      && claudeJson.projects[resolvedDir]
      && claudeJson.projects[resolvedDir].mcpServers
      && claudeJson.projects[resolvedDir].mcpServers[MCP_KEY];
    const cls = classifyEntry(projectEntry, "claude");
    const shouldWrite = cls.reason === "missing" || cls.stale;
    if (shouldWrite) {
      const spec = buildMcpCommandSpec({
        configDir: path.join(HOME, ".config", "claude"),
        projectDir: resolvedDir,
      });
      const shaped = toClaudeShape(spec);
      shaped.env = { ...cls.extraEnv, ...shaped.env };
      await patchJsonFile(claudeJsonPath, [{
        path: ["projects", resolvedDir, "mcpServers", MCP_KEY],
        value: shaped,
      }]);
    }
    out.push(formatMigrationLine(`${claudeJsonPath} (project-local)`, cls.reason));
  } catch (patchErr) {
    if (patchErr.code === "EACCES") {
      out.push(`Warning: could not patch ${claudeJsonPath}: ${patchErr.code}`);
    } else {
      throw patchErr;
    }
  }
  return out;
}

/**
 * Surgically patch a JSON/JSONC file, preserving comments and formatting.
 * Creates the file with '{}' if it does not exist.
 */
async function patchJsonFile(filePath, modifications) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") text = "{}";
    else throw err;
  }
  for (const { path: jsonPath, value } of modifications) {
    const edits = jsoncModify(text, jsonPath, value, { formattingOptions: JSONC_FORMAT });
    text = applyEdits(text, edits);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (!text.endsWith("\n")) text += "\n";
  await fs.writeFile(filePath, text, "utf8");
}

/**
 * Classifies an existing MCP config entry for a client. Returns
 * `{stale, reason, extraEnv}`:
 *   - stale: true if the entry matches a known legacy install pattern
 *   - reason: classification from detectMcpSpecShape
 *   - extraEnv: custom env vars worth preserving across migration
 *     (drops MIDBRAIN_CONFIG_DIR / MIDBRAIN_PROJECT_DIR since they get
 *     rewritten by the current setup call).
 *
 * @param {object|undefined} entry  Raw entry value at mcp[key] or mcpServers[key].
 * @param {"opencode"|"claude"} shape
 */
function classifyEntry(entry, shape) {
  if (!entry || typeof entry !== "object") {
    return { stale: false, reason: "missing", extraEnv: {} };
  }
  const normalized = normalizeMcpEntry(entry, shape);
  const { stale, reason } = detectMcpSpecShape(normalized);
  const envKey = shape === "opencode" ? "environment" : "env";
  const oldEnv = (entry[envKey] && typeof entry[envKey] === "object") ? entry[envKey] : {};
  const extraEnv = {};
  for (const [k, v] of Object.entries(oldEnv)) {
    if (k === "MIDBRAIN_CONFIG_DIR" || k === "MIDBRAIN_PROJECT_DIR") continue;
    extraEnv[k] = v;
  }
  return { stale, reason, extraEnv };
}

/**
 * Builds a status line for the summary describing a migration outcome.
 * @param {string} label  Human-readable config location.
 * @param {string} reason Classification from classifyEntry.
 */
function formatMigrationLine(label, reason) {
  switch (reason) {
    case "missing":       return `${label}: midbrain-memory entry added (@latest)`;
    case "at-latest":     return `${label}: midbrain-memory already at @latest (no change)`;
    case "pinned":        return `${label}: midbrain-memory pinned version preserved (no change)`;
    case "unknown":       return `${label}: midbrain-memory has unknown shape, not migrated`;
    case "global-installed-bin":
    case "absolute-path-server-js":
    case "unpinned-npx":
      return `${label}: midbrain-memory migrated from ${reason} to @latest`;
    default: return `${label}: ${reason}`;
  }
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
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    // --version CLI contract: print to stdout + exit.
    // Safe because MCP stdio transport has not been attached yet;
    // the no-console.log rule for this file only applies once the
    // JSON-RPC pipe is live.
    console.log(PKG_VERSION);
    process.exit(0);
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`MCP server running (midbrain-memory-mcp v${PKG_VERSION})`);
  checkForUpdate(); // fire-and-forget -- no await (PRD-005)
}
