/**
 * mcp.mjs — MCP server declaration.
 *
 * Defines all MCP tools: memory recall (memory_search, grep,
 * get_episodic_memories_by_date, list_files, read_file, check_session_status,
 * memory_diagnostics, memory_setup_project) and account management
 * (list_agents, create_agent, set_agent, set_user_api_key). Uses MidbrainApi
 * for all API communication.
 *
 * IMPORTANT: No console.log — corrupts stdio JSON-RPC pipe. Use console.error only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MidbrainApi } from "./shared/midbrain-api.mjs";
import { getClient } from "./shared/clients/registry.mjs";
import { setupProject } from "./install.mjs";
import {
  readGlobalKeystore,
  mutateGlobalKeystore,
  listAgents as ksListAgents,
  upsertAgent,
  resolveAgentRef,
} from "./shared/keystore.mjs";
import { runMemoryDiagnostics } from "./shared/diagnostics.mjs";
import { CredentialReplaceNotApprovedError } from "./shared/clients/credential-writer.mjs";

const EPISODIC_PAGE_LIMIT = 1000;
const PEEK_TTL_MS = 60_000; // 1 minute cache
const TERMINAL_CWD_PLACEHOLDER = "${TERMINAL_CWD}";

/** Creates a MidbrainApi instance for the current environment. */
export async function createApi() {
  return MidbrainApi.create(getClient(process.env.MIDBRAIN_CLIENT), currentProjectDir());
}

function currentProjectDir() {
  const configured = process.env.MIDBRAIN_PROJECT_DIR;
  return configured === TERMINAL_CWD_PLACEHOLDER ? undefined : configured || undefined;
}

/** Creates a user-key authenticated MidbrainApi for account operations. */
async function createAccountApi() {
  return MidbrainApi.createForUser(getClient(process.env.MIDBRAIN_CLIENT));
}

/** Format an agent record as a human-readable line. */
function formatAgentLine(a) {
  const label = a.alias || a.name || "(unnamed)";
  const provider = a.key_provider ? ` [${a.key_provider}]` : "";
  return `- ${label} (${a.agent_id})${provider}`;
}

/** Format one lexical-search row without dropping mixed API result shapes. */
function formatGrepResult(result) {
  const text = typeof result?.text === "string" ? result.text : String(result?.text ?? "");
  const source = typeof result?.source === "string" && result.source.trim()
    ? result.source
    : "";
  if (source) {
    const line = result.line_number ?? result.line_start ?? "?";
    return `${source}:${line}: ${text}`;
  }
  const label = result?.memory_type === "episodic" ? "episodic" : "memory";
  return `[${label}]: ${text}`;
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

  // --- Recency peek state (scoped to this server instance) ---
  let lastSeenTimestamp = null;
  let lastPeekTime = 0;
  let cachedHint = null;

  /**
   * Peek at the most recent episodic memory and return a hint string if
   * newer memories exist than what this session has seen. Returns null
   * when no hint is needed. Cached for PEEK_TTL_MS. Never throws.
   * @returns {Promise<string|null>}
   */
  async function peekRecency() {
    try {
      const now = Date.now();
      if (now - lastPeekTime < PEEK_TTL_MS) return cachedHint;
      lastPeekTime = now;

      const a = await createApi();
      const result = await a.fetch(a.EPISODIC, { page: 1, limit: 1 });
      const items = result?.items || [];
      if (items.length === 0) { cachedHint = null; return null; }

      const latest = items[0];
      const latestTs = latest.occurred_at;
      if (!latestTs) { cachedHint = null; return null; }

      if (latestTs === lastSeenTimestamp) { cachedHint = null; return null; }

      lastSeenTimestamp = latestTs;
      const ts = latestTs.slice(0, 16).replace("T", " ");
      const ageMs = now - new Date(latestTs).getTime();
      const agoStr = ageMs < 60_000 ? "just now"
        : ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)} min ago`
        : ageMs < 86_400_000 ? `${Math.round(ageMs / 3_600_000)} hr ago`
        : `${Math.round(ageMs / 86_400_000)} days ago`;
      const hint = `\n\n[Note: Newer episodic memories exist on server (most recent: ${ts}, ${agoStr}). Use get_episodic_memories_by_date to retrieve recent context if needed.]`;
      cachedHint = null;
      return hint;
    } catch {
      return null;
    }
  }

  /**
   * Update lastSeenTimestamp from a set of episodic items so subsequent
   * peeks don't re-hint about memories the LLM already fetched.
   * @param {Array<{occurred_at?: string}>} items
   */
  function markEpisodicSeen(items) {
    for (const item of items) {
      if (!item.occurred_at) continue;
      if (!lastSeenTimestamp || item.occurred_at > lastSeenTimestamp) {
        lastSeenTimestamp = item.occurred_at;
      }
    }
  }

  // --- memory_search (semantic vector search) ---

  server.tool(
    "memory_search",
    `Search memories by semantic similarity.

Results include source path and line numbers for semantic memories.
Use read_file to get more context around a search hit.

When the user wants to continue previous work from another session or client,
use get_episodic_memories_by_date with today's date to retrieve recent context.`,
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
        const results = await a.fetch(a.SEARCH_SEMANTIC, { query, limit: fetchK });

        if (!Array.isArray(results) || results.length === 0) {
          const hint = await peekRecency();
          return { content: [{ type: "text", text: "No memories found matching that query." + (hint || "") }] };
        }

        let filtered = results;
        if (memory_type === "semantic") {
          filtered = results.filter((r) => r.role === "external");
        } else if (memory_type === "episodic") {
          filtered = results.filter((r) => r.role !== "external");
        }
        filtered = filtered.slice(0, limit ?? dflt);

        if (filtered.length === 0) {
          const hint = await peekRecency();
          return { content: [{ type: "text", text: "No memories found matching that query." + (hint || "") }] };
        }

        const lines = filtered.map((item) => {
          const ts = item.occurred_at ? item.occurred_at.slice(0, 16).replace("T", " ") : "unknown";
          const score = item.score != null ? item.score.toFixed(1) : "?";
          const src = item.memory_metadata?.source || "";
          const loc = src ? ` | ${src}:${item.memory_metadata?.line_start ?? "?"}` : "";
          return `[${item.role} | ${ts} | relevance=${score}${loc}] ${item.text}`;
        });

        const hint = await peekRecency();
        return { content: [{ type: "text", text: lines.join("\n") + (hint || "") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Memory search failed: ${msg}` }] };
      }
    }
  );

  // --- grep (regex / lexical search) ---

  server.tool(
    "grep",
    `Regex search over semantic and episodic memory text, like ripgrep.

Uses POSIX regular expressions (case-insensitive).
Semantic results use path:lineno: matching line; source-less results use an intentional type label.
Defaults to all memory types and supports semantic or episodic filtering.
Use for exact or pattern-based matches (names, IDs, code, URLs).`,
    {
      pattern: z.string().describe("POSIX regex pattern (case-insensitive)."),
      source: z.string().optional()
        .describe("Restrict semantic results to a source file path; episodic results may still appear with memory_type=all."),
      limit: z
        .number().int().min(1).max(500).optional().default(50)
        .describe("Max matching lines to return (default: 50)."),
      memory_type: z
        .enum(["all", "semantic", "episodic"]).optional().default("all")
        .describe('Filter by memory type: "all" (default), "semantic", or "episodic".'),
    },
    async ({ pattern, source, limit, memory_type }) => {
      try {
        const a = await createApi();
        const results = await a.fetch(a.SEARCH_LEXICAL, { pattern, source, limit, memory_type });

        if (!Array.isArray(results) || results.length === 0) {
          const hint = await peekRecency();
          return { content: [{ type: "text", text: `No matches for pattern '${pattern}'.` + (hint || "") }] };
        }

        const lines = results.map(formatGrepResult);
        const hint = await peekRecency();
        return { content: [{ type: "text", text: lines.join("\n") + (hint || "") }] };
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
Use this when the user asks about what happened on a particular day or period.
Also use this to catch up on recent activity from other sessions or clients
when continuing previous work.`,
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
        const result = await a.fetch(a.EPISODIC, {
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

        markEpisodicSeen(items);
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
        const docs = await a.fetch(a.SEMANTIC_FILES);

        if (!Array.isArray(docs) || docs.length === 0) {
          const hint = await peekRecency();
          return { content: [{ type: "text", text: "No files found in semantic memory." + (hint || "") }] };
        }

        const lines = docs.map((d) => `  ${d.source}  (${d.chunk_count} chunks)`);
        const hint = await peekRecency();
        return { content: [{ type: "text", text: `Files (${docs.length}):\n${lines.join("\n")}` + (hint || "") }] };
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
        const url = `${a.SEMANTIC_FILES}/${encodeURIComponent(file_path).replace(/%2F/g, "/")}`;
        const result = await a.fetch(url, { start_line, num_lines });

        const hint = await peekRecency();
        return { content: [{ type: "text", text: `${result.path}:${result.start_line}\n${result.content}` + (hint || "") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("404")) {
          return { content: [{ type: "text", text: `No content found for '${file_path}' at line ${start_line ?? 1}.` }] };
        }
        return { content: [{ type: "text", text: `Failed to read file: ${msg}` }] };
      }
    }
  );

  // --- check_session_status ---

  server.tool(
    "check_session_status",
    `Check for recent activity from other sessions or clients.
Call this at the start of a session or when the user wants to continue
previous work. Returns a summary of recent episodic activity without
fetching full memories. Use get_episodic_memories_by_date to retrieve
full context if needed.`,
    {},
    async () => {
      try {
        const a = await createApi();
        const result = await a.fetch(a.EPISODIC, { page: 1, limit: 1 });
        const items = result?.items || [];

        if (items.length === 0) {
          return { content: [{ type: "text", text: "No episodic memories found." }] };
        }

        const latest = items[0];
        markEpisodicSeen(items);

        const ts = latest.occurred_at
          ? latest.occurred_at.slice(0, 16).replace("T", " ")
          : "unknown";
        const ageMs = latest.occurred_at
          ? Date.now() - new Date(latest.occurred_at).getTime()
          : 0;
        const agoStr = ageMs < 60_000 ? "just now"
          : ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)} min ago`
          : ageMs < 86_400_000 ? `${Math.round(ageMs / 3_600_000)} hr ago`
          : `${Math.round(ageMs / 86_400_000)} days ago`;

        const clientTag = latest.memory_metadata?.client
          ? `, client: ${latest.memory_metadata.client}`
          : "";

        const summary = `Most recent episodic memory: ${ts} (${agoStr}${clientTag})\nUse get_episodic_memories_by_date with today's date to retrieve full context.`;
        return { content: [{ type: "text", text: summary }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to check session status: ${msg}` }] };
      }
    }
  );

  // --- memory_setup_project ---

  server.tool(
    "memory_diagnostics",
    `Diagnose authentication and fail-open capture health without exposing credentials.

Reports the resolved API host and credential scopes, an optional live auth
probe, pending capture cache counts, safe locations, and actionable next steps.`,
    {
      probe: z.boolean().optional().default(true)
        .describe("Run a live authenticated probe (default: true)."),
    },
    async ({ probe }) => {
      try {
        const text = await runMemoryDiagnostics({
          probe,
          createApi,
          clientId: process.env.MIDBRAIN_CLIENT || "generic",
          projectDir: currentProjectDir(),
        });
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Diagnostics failed: ${msg}` }] };
      }
    },
  );

  server.tool(
    "memory_setup_project",
    "Set up per-project MidBrain memory. ALWAYS use this tool when the user asks to configure, set up, or initialize MidBrain memory for a project. This tool creates the .midbrain/.midbrain-key file (chmod 600), writes project-level MCP config, installs proactive memory rules for detected clients, and sets correct permissions. Do NOT manually create key files, configs, or rule blocks with shell commands -- this tool handles client detection, config merging, instruction placement, and permissions.",
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

  // --- Account management tools (user-key authenticated) ---
  //
  // These operate on the account-level user API key and let the user manage
  // agents from within the assistant. Write tools must ONLY be called on the
  // user's explicit request — never autonomously to "make a place to store
  // data". Agent selection is done by writing a project .midbrain-key
  // (set_agent); the keystore is only a credential/catalog store, never a
  // selector.

  // --- list_agents ---

  server.tool(
    "list_agents",
    `List the MidBrain agents owned by the user's account. Requires a configured
user API key. Read-only; safe to call whenever the user asks which agents exist.`,
    {},
    async () => {
      try {
        const account = await createAccountApi();
        const agents = await account.listAgents();
        if (agents.length === 0) {
          return { content: [{ type: "text", text: "No agents found for this account." }] };
        }
        const lines = agents.map(formatAgentLine);
        return { content: [{ type: "text", text: `Agents:\n${lines.join("\n")}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to list agents: ${msg}` }] };
      }
    }
  );

  // --- create_agent ---

  server.tool(
    "create_agent",
    `Create a new MidBrain agent AND mint its API key in one step, storing both
in the local keystore catalog. ONLY call this when the user has EXPLICITLY asked
to create a new agent. Do NOT create agents on your own initiative or to
organize memory. The raw key is NEVER returned — it is stored in the keystore
only. After creating, use set_agent to point a project at this agent. Requires a
user API key.`,
    {
      name: z.string().describe("Human-readable name for the new agent."),
      description: z.string().optional().describe("Optional description."),
    },
    async ({ name, description }) => {
      try {
        const account = await createAccountApi();

        // Preflight: prove the keystore is readable/parseable BEFORE minting a
        // one-time secret, so the common "unwritable keystore" failure cannot
        // orphan an agent or lose a key. readGlobalKeystore throws (fail-closed)
        // on a corrupt keystore.
        await readGlobalKeystore();

        const agent = await account.createAgent({ name, description });
        const keyRes = await account.createKey({
          agent_id: agent.agent_id,
          key_alias: `${name} key`,
        });

        // Catalog the agent + its key locally; never echo the raw secret.
        // Serialized read-modify-write so a concurrent tool call can't clobber.
        try {
          await mutateGlobalKeystore((ks) => upsertAgent(ks, {
            agent_id: agent.agent_id,
            key_provider: "midbrain",
            agent_key: keyRes.key,
            alias: name,
          }));
        } catch (writeErr) {
          // Post-mint durable-store failure: the key exists remotely but could
          // not be saved. Use a FIXED reason label (never the raw error message,
          // which may embed a username-bearing path) and never echo the secret.
          const reason = writeErr?.category || "keystore-write-failed";

          // Compensating cleanup: delete the just-created agent. The account API
          // cascades this to the minted key, so nothing is left orphaned.
          let rolledBack = false;
          try {
            await account.deleteAgent(agent.agent_id);
            rolledBack = true;
          } catch { /* best-effort; fall back to the orphan report below */ }

          if (rolledBack) {
            return {
              content: [{
                type: "text",
                text: `Agent "${name}" was created but its key could not be stored ` +
                  `in the keystore (${reason}); the agent and its key were rolled back. ` +
                  `Fix the keystore, then retry.`,
              }],
            };
          }
          return {
            content: [{
              type: "text",
              text: `Agent "${name}" (${agent.agent_id}) was created and its key minted, ` +
                `but the key could NOT be stored in the keystore (${reason}) and the ` +
                `automatic rollback also failed. The key was not saved and is not ` +
                `recoverable here — delete agent ${agent.agent_id} in the MidBrain ` +
                `dashboard and retry after fixing the keystore.`,
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: `Created agent "${name}" (${agent.agent_id}) and minted its key ` +
              `(stored in the keystore). Use set_agent to point a project at it.`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to create agent: ${msg}` }] };
      }
    }
  );

  // --- set_agent ---

  server.tool(
    "set_agent",
    `Point a project at one of your agents by writing that agent's key into the
project's .midbrain-key file (<project_dir>/.midbrain/.midbrain-key). Accepts an
agent name/alias (preferred) or an exact agent id, matched against the local
keystore catalog. NEVER touches the global ~/.config/midbrain/.midbrain-key — it
only sets the per-project agent. If the reference is ambiguous or unknown, the
available agents are listed instead of guessing.`,
    {
      agent: z.string().describe("Agent name, alias, or id to use for this project."),
      project_dir: z.string().describe("Absolute path to the project root directory."),
      replace: z.boolean().optional().describe(
        "Set true to overwrite an existing project key. Required when the project " +
        "already has a .midbrain-key (guards against clobbering a different agent).",
      ),
    },
    async ({ agent, project_dir, replace = false }) => {
      try {
        const ks = await readGlobalKeystore();
        const local = ksListAgents(ks);
        const match = resolveAgentRef(local, agent);

        if (match.status === "ok") {
          const key = match.agent.agent_key;
          if (!key) {
            return {
              content: [{
                type: "text",
                text: `Agent "${match.agent.alias || match.agent.agent_id}" has no key stored ` +
                  `in the keystore. Re-create it with create_agent.`,
              }],
            };
          }
          const label = match.agent.alias || match.agent.name || match.agent.agent_id;
          let keyPath;
          try {
            keyPath = await getClient("generic").setProjectKey(project_dir, key, {
              replaceApproved: replace,
            });
          } catch (writeErr) {
            if (writeErr instanceof CredentialReplaceNotApprovedError) {
              return {
                content: [{
                  type: "text",
                  text: `Project "${project_dir}" already has a .midbrain-key (possibly a ` +
                    `different agent). Re-run set_agent with replace: true to overwrite it ` +
                    `(a timestamped backup is kept).`,
                }],
              };
            }
            throw writeErr;
          }
          return {
            content: [{
              type: "text",
              text: `Project "${project_dir}" is now set to agent "${label}" ` +
                `(${match.agent.agent_id}).\nWrote ${keyPath}.\n` +
                `IMPORTANT: Restart your client for this to take effect — long-lived ` +
                `plugin sessions cache the previous key until restart.`,
            }],
          };
        }

        const candidates = match.status === "ambiguous" ? match.candidates : local;
        const listText = candidates.length
          ? candidates.map(formatAgentLine).join("\n")
          : "(no agents in keystore — use create_agent first)";
        const reason = match.status === "ambiguous"
          ? `"${agent}" matches more than one agent. Please be more specific.`
          : `No agent matched "${agent}".`;
        return { content: [{ type: "text", text: `${reason}\nAvailable agents:\n${listText}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to set project agent: ${msg}` }] };
      }
    }
  );

  // --- set_user_api_key ---

  server.tool(
    "set_user_api_key",
    `Store or update (reroll) the account-level user API key used to manage
agents and keys. NOTE: the key you paste here may be captured to memory — for
sensitive use prefer the terminal command \`midbrain-memory-mcp@latest user-key set\`.
The key is stored as-is; if it is invalid the account tools will report the
server error when you next use them.`,
    {
      user_api_key: z.string().describe("The account-level user API key (sk-...)."),
    },
    async ({ user_api_key }) => {
      try {
        // Store unconditionally — validity is checked by the account tools that
        // use the key, which surface the real server error at that point.
        // Serialized read-modify-write via the guarded writer.
        await mutateGlobalKeystore((ks) => ({ ...ks, user_key: user_api_key }));
        return {
          content: [{
            type: "text",
            // Privacy contract: never echo the key or any fragment.
            text: `User API key saved. Account tools are now available.`,
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to set user API key: ${msg}` }] };
      }
    }
  );

  return server;
}
