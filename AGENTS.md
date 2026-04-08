# MidBrain Memory MCP

## What This Is
MCP server + episodic capture hooks for persistent AI memory.
Supports **OpenCode** (plugin) and **Claude Code** (hook scripts).
API: https://memory.midbrain.ai

## Architecture
- `server.js` — MCP server (Node 20, plain JS). Exposes 1 tool: `memory_search`
- `shared/midbrain-common.mjs` — Shared utilities consumed by all components:
  `loadApiKey`, `storeEpisodic`, `makeDebugLogger`, and all API constants.
- `plugin/midbrain-memory.ts` — OpenCode plugin. Auto-stores every message as
  episodic memory via `chat.message` hook. Runs in Bun (OpenCode's runtime).
  Imports from `./midbrain-common.mjs` (copied alongside it at install time).
- `claude-code/` — Standalone Node 20 scripts for Claude Code's hook system.
  `capture-user.mjs` (UserPromptSubmit) and `capture-assistant.mjs` (Stop).
  `common.mjs` re-exports from `../shared/midbrain-common.mjs`. No npm deps.
- `install.mjs` — Automated installer. Detects OpenCode/Claude Code, writes
  configs, copies plugin + shared lib, sets up API key file (chmod 600).

## API Reference
- Auth: `Authorization: Bearer <key>` header
- `POST /api/v1/memories/search` — body: `{"text": "query", "limit": 10}`
  Returns: `[{role, text, memory_metadata, score}]`
- `POST /api/v1/memories/episodic` — body: `{"text": "...", "role": "user"|"assistant"}`
  Append-only. Returns created memory.
- `GET /health` — no auth. Returns `{"status": "ok"}`

## API Key
- Keys in files with chmod 600. Env var is CI/debug fallback only.
- Per-client key files support multi-embodiment (different keys per client).
- loadApiKey(projectDir?, configDir?) priority chain:
  1a. .midbrain-key in projectDir (per-project file override)
  1b. .midbrain/.midbrain-key in projectDir (subdirectory convention, recommended)
  2a. .midbrain-key from MIDBRAIN_PROJECT_DIR env path (when no projectDir arg)
  2b. .midbrain/.midbrain-key from MIDBRAIN_PROJECT_DIR env path (subdirectory convention)
  3. .midbrain-key in configDir (per-client config dir, e.g. ~/.config/opencode)
  4. .midbrain-key from MIDBRAIN_CONFIG_DIR env path (when no configDir arg)
  5. MIDBRAIN_API_KEY env var (CI / debug fallback only)
  6. ~/.config/midbrain/.midbrain-key (global default)
- EACCES on any key file is a hard error (throw, not silent fallthrough).
- Empty key files are a hard error naming the file path.
- When projectDir is provided but no project key found, a WARN is emitted to
  stderr if resolution falls through to the global key (step 6).
- Key file locations:
  - Global default: ~/.config/midbrain/.midbrain-key
  - OpenCode client: ~/.config/opencode/.midbrain-key
  - Claude Code client: ~/.config/claude/.midbrain-key
  - Project override (flat): <projectDir>/.midbrain-key
  - Project override (recommended): <projectDir>/.midbrain/.midbrain-key

## Per-Project Memory Setup
To scope episodic memory to a project-specific agent:
  1. Create the directory: mkdir -p <project>/.midbrain
  2. Place the API key: echo "your-key" > <project>/.midbrain/.midbrain-key
  3. Set permissions: chmod 600 <project>/.midbrain/.midbrain-key
  4. Add to .gitignore: .midbrain-key
Both OpenCode and Claude Code will automatically detect the project key.
No hook reconfiguration, no env vars, no .mcp.json changes needed for the write path.

### Per-Project Search (MCP Server)
The MCP server (memory_search tool) also needs project awareness for the read
path. Set MIDBRAIN_PROJECT_DIR in the MCP server's environment config:

OpenCode — project-level opencode.json in the project root:
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "midbrain-memory": {
        "type": "local",
        "command": ["<absolute-node-path>", "<path-to>/server.js"],
        "environment": {
          "MIDBRAIN_CONFIG_DIR": "~/.config/opencode",
          "MIDBRAIN_PROJECT_DIR": "<project-root>"
        },
        "enabled": true
      }
    }
  }

Claude Code — project-level .mcp.json in the project root:
  {
    "mcpServers": {
      "midbrain-memory": {
        "command": "<absolute-node-path>",
        "args": ["<path-to>/server.js"],
        "env": {
          "MIDBRAIN_CONFIG_DIR": "~/.config/claude",
          "MIDBRAIN_PROJECT_DIR": "<project-root>"
        }
      }
    }
  }

Without MIDBRAIN_PROJECT_DIR, the MCP server falls through to the client
config dir key, which may be a different agent than the project key.
IMPORTANT: Always use absolute node paths in MCP configs — bare `node` fails
when the client's shell environment extraction doesn't include PATH.

## MCP Server Constraints
- Plain JavaScript. Node 20. No build step. No TypeScript.
- ZERO console.log — corrupts stdio JSON-RPC pipe. Use console.error only.
- Every tool handler: try/catch, return error as text. Never throw.
- Tool return format: { content: [{ type: "text", text: "..." }] }
- Import McpServer from @modelcontextprotocol/sdk/server/mcp.js
- Import StdioServerTransport from @modelcontextprotocol/sdk/server/stdio.js
- Import { z } from "zod" (zod@3, not zod@4)
- Native fetch (Node 20 built-in). No axios, no httpx.

## Plugin Constraints
- TypeScript (.ts). Runs in OpenCode's Bun runtime.
- Import { type Plugin } from "@opencode-ai/plugin"
- Use chat.message hook to capture every message
- POST to /api/v1/memories/episodic with role from message
- Read API key via loadApiKey(directory, "~/.config/opencode") — file-first
- Fire-and-forget: don't block the chat on API response
- Log errors to console.error, never crash

## Plugin Hook Signature
chat.message receives:
  input: { sessionID, agent?, model?, messageID?, variant? }
  output: { message: UserMessage, parts: Part[] }
Parts contain { type: "text", text: "..." } among other types.
Extract text from parts, POST as episodic.

event hook receives: { event: Event }
  session.idle event has: { type: "session.idle", properties: { sessionID } }
  Use client.session.messages({ path: { id: sessionID } }) to fetch messages.
  SDK returns Array<{ info: Message, parts: Part[] }>.
  info.role is "user" | "assistant". info.id is the message ID.
  Parts are already included — no need to call session.message() separately.

## OpenCode SDK Path Parameters
CRITICAL: The SDK uses `id` not `sessionID` in path params:
  - client.session.get({ path: { id: sessionID } })
  - client.session.messages({ path: { id: sessionID } })
  - client.session.message({ path: { id: sessionID, messageID } })
Using `path: { sessionID }` will silently fail (returns no data).

## OpenCode Global Config (~/.config/opencode/opencode.json)
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "midbrain-memory": {
      "type": "local",
      "command": ["node", "/Users/carloses/MidBrain_Memory_MCP/server.js"],
      "environment": {
        "MIDBRAIN_CONFIG_DIR": "~/.config/opencode"
      },
      "enabled": true
    }
  }
}
Note: No API key in environment block — server reads from
~/.config/opencode/.midbrain-key (file-first priority).
MIDBRAIN_CONFIG_DIR tells the server which client's key file to use.

## Plugin Location
Copy BOTH files to ~/.config/opencode/plugins/:
  shared/midbrain-common.mjs  →  ~/.config/opencode/plugins/midbrain-common.mjs
  plugin/midbrain-memory.ts   →  ~/.config/opencode/plugins/midbrain-memory.ts
The plugin imports ./midbrain-common.mjs at runtime — both must be present.

## Rules for LLM (put in project AGENTS.md where MCP is used)
- Use memory_search at session start to load relevant context
- NEVER create semantic memories. Semantic is managed by dream consolidation.
- NEVER create episodic memories. Episodic capture is automatic.
- The only memory tool available is search. Use it proactively.

## Coding Standards
1. No magic strings — constants at top of file
2. Max function length: 40 lines
3. Error messages must be human-readable (LLM reads them)
4. Google-style JSDoc comments where non-obvious
5. Test every tool with curl before declaring done

## Test Plan
1. node server.js — should not crash, should print "MCP server running" to stderr
2. curl https://memory.midbrain.ai/health — should return {"status": "ok"}
3. In fresh OpenCode session: memory_search should be available as a tool
4. Send a message — plugin should auto-store it as episodic
5. Verify: curl /api/v1/memories/episodic?limit=1 shows the stored message

## Git Rules
- Conventional commits (feat:, fix:, docs:, refactor:)
- Never commit API keys or .midbrain-key files
- Never push without Carlos approving
