/**
 * mcp.mjs — MCP server declaration.
 *
 * Defines all MCP tools (memory_search, grep, get_episodic_memories_by_date,
 * list_files, read_file, memory_setup_project). Uses MidbrainApi for all
 * API communication.
 *
 * IMPORTANT: No console.log — corrupts stdio JSON-RPC pipe. Use console.error only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MidbrainApi } from "./shared/midbrain-api.mjs";
import { getClient } from "./shared/clients/registry.mjs";
import { setupProject } from "./install.mjs";

const EPISODIC_PAGE_LIMIT = 1000;

/** Creates a MidbrainApi instance for the current environment. */
async function createApi() {
  return MidbrainApi.create(getClient(process.env.MIDBRAIN_CLIENT));
}

/**
 * Creates and returns a fully configured McpServer with all tools registered.
 * Does NOT connect a transport — the caller is responsible for that.
 * @param {string} version - Package version string for the MCP server metadata.
 * @returns {McpServer}
 */
export function createServer(version) {
  const server = new McpServer({
    name: "midbrain-memory",
    version: version || "unknown",
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
        .number().int().min(1).max(50).optional().default(MidbrainApi.DEFAULT_SEARCH_LIMIT)
        .describe("Maximum number of results to return (default: 10)."),
      memory_type: z
        .enum(["all", "semantic", "episodic"]).optional().default("all")
        .describe('Filter by memory type: "all" (default), "semantic", or "episodic".'),
    },
    async ({ query, limit, memory_type }) => {
      try {
        const a = await createApi();
        const dflt = MidbrainApi.DEFAULT_SEARCH_LIMIT;
        const fetchK = memory_type !== "all" ? (limit ?? dflt) * 3 : (limit ?? dflt);
        const results = await a.fetch(MidbrainApi.SEARCH_SEMANTIC, { query, limit: fetchK });

        if (!Array.isArray(results) || results.length === 0) {
          return { content: [{ type: "text", text: "No memories found matching that query." }] };
        }

        let filtered = results;
        if (memory_type === "semantic") {
          filtered = results.filter((r) => r.role === "external");
        } else if (memory_type === "episodic") {
          filtered = results.filter((r) => r.role !== "external");
        }
        filtered = filtered.slice(0, limit ?? dflt);

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
        const a = await createApi();
        const results = await a.fetch(MidbrainApi.SEARCH_LEXICAL, { pattern, source, limit });

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

        const a = await createApi();
        const result = await a.fetch(MidbrainApi.EPISODIC, {
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

        items.reverse();

        const lines = items.map((mem) => {
          const ts = mem.occurred_at ? mem.occurred_at.slice(0, 16).replace("T", " ") : "unknown";
          return `${ts} [${mem.role}]: ${mem.text}`;
        });

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
        const a = await createApi();
        const docs = await a.fetch(MidbrainApi.SEMANTIC_FILES);

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
        const a = await createApi();
        const url = `${MidbrainApi.SEMANTIC_FILES}/${encodeURIComponent(file_path).replace(/%2F/g, "/")}`;
        const result = await a.fetch(url, { start_line, num_lines });

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
    "Set up per-project MidBrain memory. ALWAYS use this tool when the user asks to configure, set up, or initialize MidBrain memory for a project. This tool creates the .midbrain/.midbrain-key file (chmod 600), writes the project-level MCP config, and sets correct permissions. Do NOT manually create key files or configs with shell commands -- this tool handles all edge cases including path resolution, config merging, and permission setting.",
    {
      project_dir: z.string().describe("Absolute path to the project root directory."),
      api_key: z.string().optional().describe("MidBrain API key. If omitted, uses the server's current key."),
    },
    async ({ project_dir, api_key }) => {
      try {
        const result = await setupProject(project_dir, { apiKey: api_key });
        const lines = [...result.lines];
        lines.push("");
        lines.push("IMPORTANT: You MUST tell the user to restart this application for the new project memory to take effect. The current session is still using the previous API key. Memory will not be stored to the new project agent until after restart.");
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }] };
      }
    }
  );

  return server;
}
