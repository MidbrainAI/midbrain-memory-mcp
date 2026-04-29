# MidBrain Memory MCP

Persistent AI memory for long running agents. An MCP server that gives LLMs
long-term memory — semantic search, episodic recall, and per-project
scoping — with automatic capture of every conversation.

Works with [OpenCode](https://opencode.ai) and
[Claude Code](https://docs.anthropic.com/en/docs/claude-code).

[![npm version](https://img.shields.io/npm/v/midbrain-memory-mcp.svg?style=flat-square)](https://www.npmjs.com/package/midbrain-memory-mcp)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-brightgreen?style=flat-square)](#prerequisites)

---

## Quick Start

### 1. Get your API key

Sign up at [memory.midbrain.ai](https://memory.midbrain.ai), create an
agent, and generate an API key.

### 2. Install

```bash
npx midbrain-memory-mcp install
```

The installer detects OpenCode and/or Claude Code on your machine, prompts
for your API key, writes per-client key files (chmod 600), patches MCP
configs, and copies plugin files. One command, done.

### 3. Restart and verify

Restart OpenCode or Claude Code. The `memory_search` tool should be
available. Send a few messages, then search — your messages should appear.

```sh
# Quick version check (optional)
npx -y midbrain-memory-mcp@latest --version
```

---

## How It Works

```
OpenCode / Claude Code session
  |
  |-- MCP stdio -----> server.js -------> memory.midbrain.ai
  |                    (search, browse)    /api/v1/memories/search
  |
  |-- Hooks ----------> capture hooks --> memory.midbrain.ai
                       (auto-capture)     /api/v1/memories/episodic
```

**Search** — The LLM calls `memory_search` via MCP. The server queries the
API and returns scored results as formatted text.

**Capture** — Companion hooks fire on every message and POST to the
episodic endpoint. Fire-and-forget, never blocks. OpenCode uses a Bun/TS
plugin; Claude Code uses standalone Node scripts wired to its hook system.

**Project Setup** — The LLM calls `memory_setup_project` via MCP to scope
memory to a specific project, then tells the user to restart.

### MCP Tools

| Tool | Purpose |
|---|---|
| `memory_search` | Semantic search across all memories |
| `grep` | Exact pattern matching (names, IDs, code, URLs) |
| `get_episodic_memories_by_date` | Conversation history by date range |
| `list_files` | Browse semantic memory documents |
| `read_file` | Read a semantic memory document by line range |
| `memory_setup_project` | Configure per-project memory scoping |

---

## Per-Project Memory

By default, all memory goes to a single agent (your global key).
Per-project setup scopes memory to a project-specific agent so each
project has its own isolated memory space.

### Option A: CLI (recommended)

```sh
# 1. Place your project API key
mkdir -p .midbrain
echo "sk-your-project-key" > .midbrain/.midbrain-key
chmod 600 .midbrain/.midbrain-key

# 2. Run project setup
npx midbrain-memory-mcp install --project /absolute/path/to/project
```

Non-interactive. Resolves the API key from existing files, creates per-client
MCP configs, outputs JSON to stdout. All progress goes to stderr.

### Option B: MCP Tool

> **Warning:** Never paste your API key into a chat prompt. Place the key
> in a file first (step 1 above), then ask the assistant to configure the
> project.

**OpenCode:**
```
Set up midbrain memory for this project
```

**Claude Code** (name the tool — lazy loading):
```
Use the memory_setup_project tool to configure this project
```

Restart after setup for the project memory to take effect.

### Option C: Manual

See [Configuration Reference](#configuration-reference) below for the
full config format. Create the key file, add a project-level MCP config
with `MIDBRAIN_PROJECT_DIR`, and restart.

---

## Auto-Update

The installer writes `npx -y midbrain-memory-mcp@latest` as the MCP
command. This re-resolves the latest published version from the npm
registry on every client cold start — when a new version ships, your
next restart picks it up automatically.

| Spec form | Behavior |
|---|---|
| `midbrain-memory-mcp@latest` | Auto-updates on every cold start (recommended) |
| `midbrain-memory-mcp@0.3.2` | Pinned — you are responsible for bumping |
| `midbrain-memory-mcp` (bare) | Looks auto-updating but is sticky on first resolved version — avoid |

Run `npx -y midbrain-memory-mcp@latest --version` to check your resolved
version. The MCP server also logs its version to stderr on startup:
`MCP server running (midbrain-memory-mcp v0.3.2)`.

---

## Configuration Reference

### Environment Variables

| Variable | Purpose | Set by |
|---|---|---|
| `MIDBRAIN_CONFIG_DIR` | Client config dir for key resolution | MCP config `environment`/`env` block |
| `MIDBRAIN_PROJECT_DIR` | Project dir for per-project key resolution | Project-level MCP config |
| `MIDBRAIN_API_KEY` | API key (CI/debug fallback only) | User environment |

### API Key Resolution

Keys are stored in files with `chmod 600`. Resolution order:

| # | Location | Source |
|---|---|---|
| 1a | `<projectDir>/.midbrain-key` | Per-project (flat) |
| 1b | `<projectDir>/.midbrain/.midbrain-key` | Per-project (recommended) |
| 2a | `$MIDBRAIN_PROJECT_DIR/.midbrain-key` | Per-project via env (flat) |
| 2b | `$MIDBRAIN_PROJECT_DIR/.midbrain/.midbrain-key` | Per-project via env |
| 3 | `<configDir>/.midbrain-key` | Per-client config dir |
| 4 | `$MIDBRAIN_CONFIG_DIR/.midbrain-key` | Per-client via env |
| 5 | `$MIDBRAIN_API_KEY` | Environment variable (CI only) |
| 6 | `~/.config/midbrain/.midbrain-key` | Global default |

- `EACCES` on any key file is a hard error (not silent fallthrough)
- Empty key files are a hard error naming the file path
- Fallthrough from project to global key emits a warning to stderr

### MCP Config Examples

**OpenCode** — `~/.config/opencode/opencode.json` (global) or
`<project>/opencode.json` (per-project):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "midbrain-memory": {
      "type": "local",
      "command": ["npx", "-y", "midbrain-memory-mcp@latest"],
      "environment": {
        "MIDBRAIN_CONFIG_DIR": "/Users/you/.config/opencode"
      },
      "enabled": true
    }
  }
}
```

**Claude Code** — `~/.claude.json` (global) or `<project>/.mcp.json`
(per-project):

```json
{
  "mcpServers": {
    "midbrain-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "midbrain-memory-mcp@latest"],
      "env": {
        "MIDBRAIN_CONFIG_DIR": "/Users/you/.config/claude"
      }
    }
  }
}
```

For per-project configs, add `"MIDBRAIN_PROJECT_DIR": "/absolute/path/to/project"` to the environment/env block.

**Important:**
- All paths must be absolute. JSON does not expand `~`.
- OpenCode uses `mcp`. Claude Code uses `mcpServers`. Wrong key = silent failure.
- MCP servers in `~/.claude/settings.json` are silently ignored — use `~/.claude.json`.

---

## LLM Rules

Add to your project's `AGENTS.md` or `CLAUDE.md`:

```markdown
## MidBrain Memory Rules
- Use memory_search at session start to load relevant context
- Use grep for exact pattern matches (names, IDs, code, URLs)
- Use list_files and read_file to browse semantic memory documents
- Use get_episodic_memories_by_date for conversation history by date
- NEVER create semantic memories. Semantic is managed by dream consolidation.
- NEVER create episodic memories. Episodic capture is automatic.
- The only memory tools available are search and setup. Use them proactively.
- When the user asks to set up MidBrain memory for a project, ALWAYS use the
  memory_setup_project tool. NEVER manually create key files or configs.
```

---

## Troubleshooting

### Version check

```sh
npx -y midbrain-memory-mcp@latest --version
# Expected: 0.3.2
```

If it shows an old version, your npx cache is stale:

```sh
npx_cache=$(npm config get cache)/_npx
find "$npx_cache" -type d -name "midbrain-memory-mcp" -exec rm -rf {} + 2>/dev/null
npx -y midbrain-memory-mcp@latest --version
```

### MCP server not connecting

**Symptom:** `memory_search` not available in your session.

**Check:**
```sh
npx -y midbrain-memory-mcp@latest --version   # Does the package resolve?
curl https://memory.midbrain.ai/health         # Is the API reachable?
```

**Common causes:**
- Stale npx cache (see version check above)
- `MIDBRAIN_CONFIG_DIR` not set or pointing to wrong directory
- Key file missing or wrong permissions (`chmod 600`)
- Claude Code: MCP entry in `~/.claude/settings.json` instead of `~/.claude.json`

### Memory going to wrong agent

**Cause:** Session started before the project key was created. The key is
resolved at init time and cached.

**Fix:** Restart the client after running project setup.

### Claude Code ignores the setup tool

**Cause:** Lazy tool loading. Name the tool explicitly:
```
Use the memory_setup_project tool to configure this project
```

### Permission denied / empty key file

```sh
chmod 600 /path/to/.midbrain-key   # Fix permissions
# Or remove an empty key file so resolution falls through
```

---

## API Reference

Base URL: `https://memory.midbrain.ai`
Auth: `Authorization: Bearer <key>` (except `/health`)

| Method | Endpoint | Params / Body | Returns |
|---|---|---|---|
| GET | `/api/v1/memories/search/semantic` | `?query=...&limit=10` | `[{role, text, score, occurred_at}]` |
| GET | `/api/v1/memories/search/lexical` | `?pattern=...&source=...&limit=50` | `[{source, line_number, text}]` |
| GET | `/api/v1/memories/episodic` | `?page=1&limit=100&start_date=...&end_date=...` | `{items, total, page, limit}` |
| GET | `/api/v1/memories/semantic/files` | -- | `[{source, chunk_count}]` |
| GET | `/api/v1/memories/semantic/files/{path}` | `?start_line=1&num_lines=200` | `{path, start_line, content}` |
| POST | `/api/v1/memories/episodic` | `{"text": "...", "role": "user\|assistant"}` | Created memory |
| GET | `/health` | -- | `{"status": "ok"}` |

---

## Development

### Setup

```sh
git clone https://github.com/MidbrainAI/midbrain-memory-mcp.git
cd midbrain-memory-mcp
npm run bootstrap   # install deps + git hooks (one-time)
```

### Dev install

To point your MCP clients at your working tree instead of `@latest`,
run the installer directly from the cloned repo with `--dev`:

```sh
node install.mjs --dev                               # interactive
node install.mjs --project /abs/path/to/project --dev  # per-project
```

This writes absolute paths into configs instead of `npx @latest`.

### Commands

| Command | Purpose |
|---|---|
| `npm run bootstrap` | First-time setup: deps + git hooks |
| `npm test` | Full test suite (vitest) |
| `npm run test:watch` | Watch mode |
| `npm run lint` | ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run check` | Lint + tests + doc-regression checks |

### Pre-commit hook

Every `git commit` runs lint-staged (ESLint, zero warnings) and the full
test suite. Commit is rejected if either fails.

### Architecture

```
server.js                  MCP server (Node 20, plain JS, stdio)
install.mjs                Installer CLI + --project mode
shared/midbrain-common.mjs Shared: key loading, API helpers, constants
plugin/midbrain-memory.ts  OpenCode plugin (Bun/TS, episodic capture)
claude-code/               Claude Code hook scripts (episodic capture)
scripts/                   CI guards (pinned-spec regression)
tests/                     vitest (unit, integration, installer, doc-regression)
```

### Dependencies

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP protocol |
| `jsonc-parser` | JSONC parsing with comment preservation |
| `zod` | Schema validation |

Dev: eslint, vitest, husky, lint-staged. Not shipped to users.

---

## Prerequisites

- Node >= 20
- [OpenCode](https://opencode.ai) and/or [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- A MidBrain API key ([memory.midbrain.ai](https://memory.midbrain.ai))

## License

MIT
