# MidBrain Memory MCP

## What This Is
MCP server + episodic capture hooks for persistent AI memory.
Supports **OpenCode** (plugin), **Claude Code** (hook scripts), and
**OpenAI Codex** (hook scripts).
API: https://memory.midbrain.ai
Published on npm as midbrain-memory-mcp. Version 0.1.0+.
Install: `npx -y midbrain-memory-mcp@latest` (MCP config command) or
`npx midbrain-memory-mcp install` (installer — recommended). Legacy
`midbrain-memory-setup` bin still works for backward compat. Pin the
spec to `@latest` for auto-updates on every cold start; use `@X.Y.Z`
to freeze a specific version. Never use the bare unpinned form — it
looks auto-updating but is sticky on the first resolved version.

## Architecture

```
index.js                         Entry point: MCP server OR install CLI dispatcher
mcp.mjs                          All 6 MCP tool definitions (createServer factory)
install.mjs                      Installer orchestrator + CLI + setupProject() core
shared/
  midbrain-api.mjs               HTTP client (MidbrainApi class). Single source of truth
                                 for all API calls and key resolution.
  logger.mjs                     makeDebugLogger() — timestamped file appender
  clients/
    base.mjs                     Abstract BaseClient. Owns the full resolveKey() chain.
    opencode.mjs                 OpenCode adapter: JSONC config, plugin copy
    claude.mjs                   Claude Code adapter: hooks, .mcp.json, .claude.json
    codex.mjs                    Codex adapter: TOML config, hooks.json
    generic.mjs                  Near-noop fallback: global key write, project key CRUD
    registry.mjs                 getClient(id), detectClients(), allClients()
plugins/
  opencode/
    midbrain-memory.ts           OpenCode plugin (TypeScript, Bun runtime). Captures
                                 every message via chat.message hook.
  claude-code/
    common.mjs                   Shared hook utilities (createApi, debugLog, readStdinJSON)
    capture-user.mjs             Hook: UserPromptSubmit → storeEpisodic("user")
    capture-assistant.mjs        Hook: Stop → storeEpisodic("assistant")
  codex/
    common.mjs                   Shared Codex hook runtime; uses MidbrainApi + getClient("codex")
    capture-user.mjs             Hook: UserPromptSubmit → storeEpisodic("user")
    capture-tool.mjs             Hook: PostToolUse → local bounded tool buffer
    capture-assistant.mjs        Hook: Stop → assistant memory + flushed tool summary
```

### Capture paths

**OpenCode plugin** — `plugins/opencode/midbrain-memory.ts` runs in Bun.
At install time, this file and all of `shared/` are copied into
`~/.config/opencode/plugins/`. The plugin uses relative imports at runtime:
`./midbrain-api.mjs`, `./logger.mjs`, `./clients/registry.mjs`.

**Claude Code hooks** — `plugins/claude-code/*.mjs` run in Node 20.
They are NOT copied; they run directly from the installed npm package via
absolute paths written into `~/.claude/settings.json` at install time.
`common.mjs` imports from `../../shared/` (relative within the package tree).

**Codex hooks** — `plugins/codex/*.mjs` run in Node 20 from absolute paths
written into `~/.codex/hooks.json`. They capture `UserPromptSubmit`,
`PostToolUse`, and `Stop`. `Stop` and `PostToolUse` wrappers write JSON `{}` to
stdout on zero exit. Assistant capture buffers commentary/reasoning-only Stop
events until a final answer is visible, then stores a clean assistant answer,
one reasoning/commentary summary, and a separate tool summary. Project setup
does not write project-local Codex hooks because Codex runs all matching hook
layers and duplicate writes would occur.

All capture paths go through the same modules:
`MidbrainApi.create(getClient(id), projectDir)` → `BaseClient.resolveKey()`.
**Never re-implement key resolution or API calls in a plugin or hook.**
Use `MidbrainApi` and `getClient` from `shared/`.

## API Key Resolution

Key resolution is owned entirely by `BaseClient.resolveKey()` in
`shared/clients/base.mjs`. All plugins, hooks, and the MCP server MUST
obtain their API key through `MidbrainApi.create(getClient(id), projectDir)`.
Never read key files directly. Never fall back to env vars manually.

Resolution chain (in priority order):

| # | Location | Notes |
|---|---|---|
| 1a | `<projectDir>/.midbrain/.midbrain-key` | Per-project (recommended) |
| 1b | `<projectDir>/.midbrain-key` | Per-project (flat override) |
| 2a | `$MIDBRAIN_PROJECT_DIR/.midbrain/.midbrain-key` | Per-project via env |
| 2b | `$MIDBRAIN_PROJECT_DIR/.midbrain-key` | Per-project via env (flat) |
| 3 | `resolveClientKey()` | Per-client file (e.g. `~/.config/opencode/.midbrain-key`) |
| 4 | `~/.config/midbrain/.midbrain-key` | Global default |
| 5 | `MIDBRAIN_API_KEY` env var | CI / debug fallback only |

Rules:
- `EACCES` on any key file is a hard error (throw, not silent fallthrough).
- Empty key files are a hard error naming the file path.
- Fallthrough from project key to global key emits a WARN to stderr.

Per-client key file locations:
- OpenCode: `~/.config/opencode/.midbrain-key`
- Claude Code: `~/.config/claude/.midbrain-key`
- Codex: `~/.config/codex/.midbrain-key`
- Global default: `~/.config/midbrain/.midbrain-key`
- Project override (recommended): `<projectDir>/.midbrain/.midbrain-key`
- Project override (flat): `<projectDir>/.midbrain-key`

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
- `POST /api/v1/memories/episodic` — body: `{"text": "...", "role": "user"|"assistant", "memory_metadata": {"client": "opencode"}}`
  Append-only. `memory_metadata` is optional; values must be strings.
  Capture hooks tag each memory with the originating client (opencode/claude/codex).
  Returns created memory.
- `GET /health` — no auth. Returns `{"status": "ok"}`

## Per-Project Memory Setup
To scope episodic memory to a project-specific agent:
  1. Create the directory: mkdir -p <project>/.midbrain
  2. Place the API key: echo "your-key" > <project>/.midbrain/.midbrain-key
  3. Set permissions: chmod 600 <project>/.midbrain/.midbrain-key
  4. Add to .gitignore: .midbrain-key
OpenCode, Claude Code, and Codex will automatically detect the project key.
No hook reconfiguration, no env vars, no .mcp.json changes needed for the write path.

### Per-Project Search (MCP Server)
The MCP server (memory_search tool) also needs project awareness for the read
path. Set MIDBRAIN_PROJECT_DIR in the MCP server's environment config:

OpenCode — project-level opencode.json (or opencode.jsonc) in the project root:
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "midbrain-memory": {
        "type": "local",
        "command": ["<absolute-node-path>", "<path-to>/index.js"],
        "environment": {
          "MIDBRAIN_CLIENT": "opencode",
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
        "args": ["<path-to>/index.js"],
        "env": {
          "MIDBRAIN_CLIENT": "claude",
          "MIDBRAIN_PROJECT_DIR": "<project-root>"
        }
      }
    }
  }

Codex — project-level .codex/config.toml in the project root:
  [mcp_servers.midbrain-memory]
  command = "npx"
  args = ["-y", "midbrain-memory-mcp@latest"]

  [mcp_servers.midbrain-memory.env]
  MIDBRAIN_CLIENT = "codex"
  MIDBRAIN_PROJECT_DIR = "<project-root>"

Without MIDBRAIN_PROJECT_DIR, the MCP server falls through to the client
config dir key, which may be a different agent than the project key.
IMPORTANT: Always use absolute node paths in MCP configs — bare `node` fails
when the client's shell environment extraction doesn't include PATH.

### Automated Project Setup
The `memory_setup_project` MCP tool and `node install.mjs --project` CLI
automate per-project memory configuration:
  - Creates .midbrain/.midbrain-key with chmod 600
  - Writes project-level MCP config (opencode.json/.jsonc, .mcp.json, or .codex/config.toml)
  - Patches ~/.claude.json project-local mcpServers (bypasses trust gate)
  - Merges into existing configs without data loss
  - Preserves comments and formatting in JSONC files (via jsonc-parser)
  - Prefers opencode.jsonc over opencode.json when both exist
  - Uses process.execPath for reliable node path resolution
  - Guards existing key files (never overwrites)

Claude Code trust gate: Claude Code requires users to approve .mcp.json
servers via a trust dialog. To bypass this, the setup tool also writes the
MCP server entry directly into ~/.claude.json at the project-local scope
(projects[dir].mcpServers). This loads immediately without user approval,
equivalent to `claude mcp add --scope local`. Both .mcp.json (for team
sharing via git) and ~/.claude.json (for immediate local use) are written.

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
- Use MidbrainApi.create(getClient(id), projectDir) for all API calls.
  Never read key files directly in tool handlers.

## Plugin / Hook Constraints

**CRITICAL: All plugins and hooks MUST use the shared client layer.**
Never read `.midbrain-key` files directly. Never call `fs.readFile` for
keys. Never check env vars for the API key manually. The entire resolution
chain lives in `BaseClient.resolveKey()` — accessed via
`MidbrainApi.create(getClient(id), projectDir)`.

**OpenCode plugin** (`plugins/opencode/midbrain-memory.ts`):
- TypeScript (.ts). Runs in OpenCode's Bun runtime.
- Import { type Plugin } from "@opencode-ai/plugin"
- Use chat.message hook to capture every message.
- Call MidbrainApi.create(getClient('opencode'), directory) for key + API.
- Fire-and-forget: don't block the chat on API response.
- Log errors to console.error, never crash.
- jsonc-parser is NOT available in the Bun plugin runtime — it is lazy-loaded
  inside opencode.mjs only when config writing is needed. The plugin itself
  never calls config-writing methods.

**Claude Code hooks** (`plugins/claude-code/`):
- Node 20. No npm deps (imports only from ../../shared/).
- Import { createApi, debugLog, readStdinJSON } from ./common.mjs.
- createApi(cwd) wraps MidbrainApi.create(getClient('claude'), cwd) — use it.
- Fire-and-forget via api.storeEpisodic(). Fail silently on any error.

**Codex hooks** (`plugins/codex/`):
- Node 20. No npm deps beyond package runtime deps.
- Import { MidbrainApi } from ../../shared/midbrain-api.mjs and
  { getClient } from ../../shared/clients/registry.mjs in common.mjs only.
- createApi(cwd) wraps MidbrainApi.create(getClient('codex'), cwd) — use it.
- Never read key files directly or check MIDBRAIN_API_KEY manually.
- UserPromptSubmit stores prompt text as role "user".
- Stop stores clean assistant answer text separately from one bounded
  reasoning/commentary summary, and flushes one bounded tool summary per turn.
- PostToolUse buffers redacted/truncated tool summaries locally.
- Stop and PostToolUse wrappers must write JSON `{}` to stdout on zero exit.
- Hook config uses canonical `[features].hooks` only when a feature flag write
  is necessary; never write the deprecated Codex hook feature alias.

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

## OpenCode Global Config (~/.config/opencode/opencode.json or opencode.jsonc)
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "midbrain-memory": {
      "type": "local",
      "command": ["npx", "-y", "midbrain-memory-mcp@latest"],
      "environment": {
        "MIDBRAIN_CLIENT": "opencode"
      },
      "enabled": true
    }
  }
}
Note: No API key in environment block — server reads from
~/.config/opencode/.midbrain-key via BaseClient.resolveKey().
MIDBRAIN_CLIENT tells the registry which client adapter to use.

## Plugin Location (OpenCode)
At install time, the following are copied to ~/.config/opencode/plugins/:

  plugins/opencode/midbrain-memory.ts  →  ~/.config/opencode/plugins/midbrain-memory.ts
  shared/midbrain-api.mjs              →  ~/.config/opencode/plugins/midbrain-api.mjs
  shared/logger.mjs                    →  ~/.config/opencode/plugins/logger.mjs
  shared/clients/base.mjs              →  ~/.config/opencode/plugins/clients/base.mjs
  shared/clients/generic.mjs           →  ~/.config/opencode/plugins/clients/generic.mjs
  shared/clients/opencode.mjs          →  ~/.config/opencode/plugins/clients/opencode.mjs
  shared/clients/claude.mjs            →  ~/.config/opencode/plugins/clients/claude.mjs
  shared/clients/registry.mjs          →  ~/.config/opencode/plugins/clients/registry.mjs

The plugin uses relative imports at runtime (./midbrain-api.mjs etc.) which
resolve within the copied plugins/ directory. All 8 files must be present.

## Rules for LLM (put in project AGENTS.md where MCP is used)
- Use memory_search at session start to load relevant context
- Use check_session_status at session start to detect recent activity from
  other sessions or clients. If it reports recent activity, use
  get_episodic_memories_by_date to fetch full context.
- Use grep for exact pattern matches (names, IDs, code, URLs)
- Use list_files and read_file to browse semantic memory documents
- Use get_episodic_memories_by_date for conversation history by date
- NEVER create semantic memories. Semantic is managed by dream consolidation.
- NEVER create episodic memories. Episodic capture is automatic.
- The only memory tools available are search and setup. Use them proactively.
- When the user asks to "continue", "pick up where we left off", or similar,
  use get_episodic_memories_by_date with today's date to retrieve recent context.
  This may include work done in other clients or sessions.
- If a tool response includes a recency hint about newer episodic memories on
  the server, consider fetching them with get_episodic_memories_by_date if
  relevant to the user's current intent.
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

**SOP for PRDs** -- All PRD work in this repo follows
`tasks/sop/prd-to-pr-sop.md` (authoritative, repo-local) which mirrors
`~/Projects/OpenCode-workspace/workflows/prd-to-pr-workflow.md`. When
they disagree, the repo-local file wins.

Session prompts for PRD implementation MUST cover Phases 4
(implementation), 5 (parallel testing subagents: A tests / B ACs vs
actual code / C security), and 6 (PR artifact prep: `context.md` +
`pr-prompt.md` under `tasks/prs/PR-NNN/`) in a SINGLE session. Only
Phase 7 (PR review) runs in a separate fresh session.

Before drafting any `session-prompt.md`:
1. Read `tasks/sop/prd-to-pr-sop.md` (canonical).
2. Copy `tasks/templates/session-prompt-template.md` and customize.
3. Read `tasks/prs/pr-reviewer-profile.md` (review contract).
4. Read the most recent `tasks/prs/PR-NNN-*/` as structural exemplar.
5. Query midbrain memory for "SOP", "PRD session prompt", "Phase 5 Phase 6".

If your draft session-prompt stops at "ready for PR" without Phase 5+6,
it is wrong. The implementation session pushes the branch and writes
PR artifacts; the PR review session (separate) runs the 4-subagent
review and creates the PR.

## Test Architecture

Tests live in `tests/`, using vitest (ESM). Each test file maps 1:1 to a source module:

| Test file | Source module |
|---|---|
| `tests/midbrain-api.test.mjs` | `shared/midbrain-api.mjs` |
| `tests/logger.test.mjs` | `shared/logger.mjs` |
| `tests/client-opencode.test.mjs` | `shared/clients/opencode.mjs` |
| `tests/client-claude.test.mjs` | `shared/clients/claude.mjs` |
| `tests/client-registry.test.mjs` | `shared/clients/registry.mjs` |
| `tests/install.test.mjs` | `install.mjs` (orchestrator only) |
| `tests/mcp.test.mjs` | `mcp.mjs` / `index.js` (MCP tool integration) |
| `tests/docs-regression.test.mjs` | `scripts/check-pinned-spec.sh` + doc files |

Shared mock helper: `tests/fs-mock.mjs` — exports `enoent`, `makeResetMocks`,
`makeExistsFor`, `makeReadFileReturns`. Each test file that needs fs mocks
declares its own `mocks` via `vi.hoisted()` and binds helpers via the factory
functions. The `vi.mock()` calls must live in the test file (vitest hoisting).

**Unit tests** (`midbrain-api`, `logger`, `client-*`, `install`):
- All filesystem operations mocked via `vi.mock('fs/promises')` and `vi.mock('fs')`
- No real files read or written
- Mocks `globalThis.fetch` with `vi.spyOn` for network calls where needed

**Integration tests** (`mcp.test.mjs`):
- Self-contained, in-process: no child process, no stdio, no mock HTTP server
- Imports `createServer()` from `index.js` directly
- Uses MCP SDK `InMemoryTransport.createLinkedPair()` to connect Client <-> Server
- Mocks `globalThis.fetch` with `vi.spyOn` to intercept all API calls
- Routes mock responses by URL path in a `mockFetch()` function
- Temp API key file + env vars set in `beforeAll`, restored in `afterAll`
- `memory_setup_project` tests use real temp dirs for config file I/O

**Writing new tool tests:**
1. Add mock response data to `MOCK_DATA` in `mcp.test.mjs`
2. Add a URL route in `mockFetch()` to return the mock data
3. Write tests that call the tool via `client.callTool()` and assert on
   `result.content[0].text`
4. Test both success and error paths (4xx responses, invalid inputs)

**Writing new unit tests:**
1. Create or add to the test file matching the source module
2. Declare `mocks` via `vi.hoisted()`, wire `vi.mock()`, bind helpers
3. Create temp dirs in `beforeEach`, clean up in `afterEach` if touching real fs
4. Mock `fetch` with `vi.spyOn(globalThis, "fetch")` if needed

## Test Plan (manual smoke tests)
1. node index.js -- should not crash, should print "MCP server running" to stderr
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
