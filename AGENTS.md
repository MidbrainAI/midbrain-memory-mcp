# MidBrain Memory MCP

## What This Is
MCP server + episodic capture hooks for persistent AI memory.
Supports **OpenCode** (plugin) and **Claude Code** (hook scripts).
API: https://memory.midbrain.ai
Published on npm as `midbrain-memory-mcp` (v0.1.0+).
Install: `npm install -g midbrain-memory-mcp` or use `npx -y midbrain-memory-mcp`.

## Architecture
- `server.js` — MCP server (Node 20, plain JS). Exposes 6 tools:
  `memory_search`, `grep`, `get_episodic_memories_by_date`, `list_files`,
  `read_file`, `memory_setup_project`
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
- `GET /api/v1/memories/search/semantic?query=...&limit=10`
  Returns: `[{id, role, text, memory_metadata, score, occurred_at}]`
- `GET /api/v1/memories/search/lexical?pattern=...&source=...&limit=50`
  Returns: `[{source, line_number, text}]`
- `GET /api/v1/memories/episodic?page=1&limit=100&start_date=...&end_date=...`
  Returns: `{items: [{role, text, occurred_at, ...}], total, page, limit}`
- `GET /api/v1/memories/semantic/files`
  Returns: `[{source, chunk_count}]`
- `GET /api/v1/memories/semantic/files/{file_path}?start_line=1&num_lines=200`
  Returns: `{path, start_line, content, chunks_used}`
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

### Automated Project Setup
The `memory_setup_project` MCP tool and `node install.mjs --project` CLI
automate per-project memory configuration:
  - Creates .midbrain/.midbrain-key with chmod 600
  - Writes project-level MCP config (opencode.json / .mcp.json)
  - Merges into existing configs without data loss
  - Uses process.execPath for reliable node path resolution
  - Guards existing key files (never overwrites)

MCP tool: memory_setup_project(project_dir, api_key?)
  - project_dir: absolute path to the project root (required)
  - api_key: MidBrain API key (optional, falls back to server's resolved key)
  - Returns human-readable summary of actions taken

CLI: node install.mjs --project /absolute/path/to/project
  - Non-interactive, outputs JSON to stdout
  - All progress/debug to stderr
  - Resolves key from existing files (no prompts)

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
- Use grep for exact pattern matches (names, IDs, code, URLs)
- Use list_files and read_file to browse semantic memory documents
- Use get_episodic_memories_by_date for conversation history by date
- NEVER create semantic memories. Semantic is managed by dream consolidation.
- NEVER create episodic memories. Episodic capture is automatic.
- The only memory tools available are search and setup. Use them proactively.
- When the user asks to set up, configure, or initialize MidBrain memory for a
  project, ALWAYS use the memory_setup_project tool. NEVER manually create
  .midbrain-key files, .mcp.json, or opencode.json with shell commands.
  The tool handles permissions, config merging, and path resolution correctly.
  Manual setup will break.

## Dev Practices

**TDD** -- strict red/green/refactor. Write failing tests first, minimal
implementation, then refactor. Never ship code without tests.

**Style:**
- Dense, terse code. Minimal comments (only for non-obvious decisions).
- No emojis.
- No magic strings -- constants at top of file.
- Max function length: 40 lines.
- Error messages must be human-readable (LLM reads them).
- Google-style JSDoc comments where non-obvious.

**Tooling** -- all via `npm run`:
- `npm run bootstrap` -- first-time setup: installs deps + git hooks
- `npm test` -- run full test suite (vitest, non-interactive)
- `npm run test:watch` -- run tests in watch mode during development
- `npm run lint` -- run ESLint across all .js/.mjs files
- `npm run lint:fix` -- auto-fix ESLint issues
- `npm run check` -- lint + test in one command (CI equivalent)

**Pre-commit hook** -- husky + lint-staged runs automatically on `git commit`:
1. `lint-staged` -- ESLint on staged .js/.mjs files (zero warnings allowed)
2. `npm test` -- full test suite

Install hooks after clone: `npm run bootstrap`.

**Always** finish all tasks by running `npm run check` and fixing any failures.

## Test Architecture

Tests live in `tests/`, using vitest (ESM). Two categories:

1. **Unit tests** (`tests/midbrain-common.test.mjs`)
   - Pure function tests: `loadApiKey`, `isNewerVersion`, `storeEpisodic`, constants
   - Uses temp directories for key file tests (cleaned up in afterEach)
   - Mocks `globalThis.fetch` with `vi.spyOn` for network calls
   - No external dependencies beyond vitest

2. **Integration tests** (`tests/server-integration.test.mjs`)
   - Self-contained, in-process: no child process, no stdio, no mock HTTP server
   - Imports `createServer()` from `server.js` directly
   - Uses MCP SDK `InMemoryTransport.createLinkedPair()` to connect Client <-> Server
   - Mocks `globalThis.fetch` with `vi.spyOn` to intercept all API calls
   - Routes mock responses by URL path in a `mockFetch()` function
   - Temp API key file + env vars set in `beforeAll`, restored in `afterAll`

**Writing new tool tests:**
1. Add mock response data to `MOCK_DATA` in the integration test
2. Add a URL route in `mockFetch()` to return the mock data
3. Write tests that call the tool via `client.callTool()` and assert on
   `result.content[0].text`
4. Test both success and error paths (4xx responses, invalid inputs)

**Writing new unit tests:**
1. Import the function from `shared/midbrain-common.mjs`
2. Create temp dirs in `beforeEach`, clean up in `afterEach`
3. Mock `fetch` with `vi.spyOn(globalThis, "fetch")` if needed

## Test Plan (manual smoke tests)
1. node server.js -- should not crash, should print "MCP server running" to stderr
2. curl https://memory.midbrain.ai/health -- should return {"status": "ok"}
3. In fresh OpenCode session: memory_search should be available as a tool
4. Send a message -- plugin should auto-store it as episodic
5. Verify: curl /api/v1/memories/episodic?limit=1 shows the stored message

## Git Rules
- Conventional commits (feat:, fix:, docs:, refactor:)
- Never commit API keys or .midbrain-key files
- Never push without Carlos approving

## Backlog Reconciliation

BACKLOG.md is the single source of truth for deferred work. It is gitignored.
After merging a PR or completing implementation work:
1. Read the PR's context.md Known Issues / Deferred Items (if applicable)
2. Add any items missing from BACKLOG.md (with priority, source, description)
3. Mark items resolved by the work as completed (move to Completed section)
4. Update the "Last updated" timestamp
