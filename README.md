# MidBrain Memory MCP

Persistent AI memory for coding agents. An MCP server exposes `memory_search`
and `memory_setup_project` for context retrieval and project configuration;
companion hooks auto-capture every message as episodic memory. Works with
**OpenCode** and **Claude Code**.

API: https://memory.midbrain.ai

---

## Prerequisites

- Node >= 20
- [OpenCode](https://opencode.ai) and/or [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- A MidBrain API key (get one at https://memory.midbrain.ai)

---

## Quick Start

```sh
git clone https://github.com/MidbrainAI/MidBrain_Memory_MCP.git
cd MidBrain_Memory_MCP
npm install
node install.mjs
```

The installer auto-detects OpenCode and Claude Code, prompts for your API
key(s), writes per-client key files (`chmod 600`), copies the plugin and shared
lib, patches all config files, and sets MCP tool permissions. Running it again
is safe (idempotent).

**Verify it works:**

```sh
# 1. Health check
curl https://memory.midbrain.ai/health
# Expected: {"status":"ok"}

# 2. Start a session in OpenCode or Claude Code
# 3. The memory_search tool should be available
# 4. Send a few messages, then search — your messages should appear
```

---

## Per-Project Setup

By default, all memory goes to a single agent (your global key). Per-project
setup scopes memory to a project-specific agent, so each project has its own
isolated memory space.

### Option A: MCP Tool (Recommended)

Inside your coding session, tell the AI assistant to use the setup tool.

**OpenCode:**

```
Set up midbrain memory for this project with API key sk-your-key-here
```

**Claude Code** (you must name the tool explicitly due to lazy tool loading):

```
Use the memory_setup_project tool to configure this project with API key sk-your-key-here
```

The tool creates:
- `.midbrain/.midbrain-key` (chmod 600) — project-scoped API key
- `opencode.json` or `.mcp.json` — project-level MCP config with `MIDBRAIN_PROJECT_DIR`

**After setup, restart the application** for the project memory to take effect.
The current session continues using the previous key until restart.

### Option B: CLI

```sh
node install.mjs --project /absolute/path/to/your/project
```

Non-interactive. Resolves the API key from existing key files (no prompts),
creates the key file and MCP configs for all detected clients, outputs JSON
to stdout. All progress goes to stderr.

```sh
# Example output (stdout)
{
  "success": true,
  "project_dir": "/Users/you/myproject",
  "key_file": "/Users/you/myproject/.midbrain/.midbrain-key",
  "key_created": true,
  "key_source": "/Users/you/.config/opencode/.midbrain-key",
  "configs_written": ["opencode.json", ".mcp.json"],
  "restart_required": true,
  "warnings": []
}
```

### Option C: Manual

```sh
# 1. Create the key file
mkdir -p /path/to/project/.midbrain
echo "sk-your-key" > /path/to/project/.midbrain/.midbrain-key
chmod 600 /path/to/project/.midbrain/.midbrain-key

# 2. Add .midbrain-key to .gitignore
echo ".midbrain-key" >> /path/to/project/.gitignore
```

Then create a project-level MCP config (see [Configuration Reference](#configuration-reference) below).

**Important:** Always use absolute paths for the node binary and `server.js` in
MCP configs. Bare `node` fails when the client's shell environment doesn't
include PATH.

---

## Architecture

```
OpenCode session
  |
  |-- MCP stdio -----> server.js ----> POST /api/v1/memories/search
  |                                        memory.midbrain.ai
  |-- Plugin hook ---> midbrain-memory.ts -> POST /api/v1/memories/episodic
                                               memory.midbrain.ai

Claude Code session
  |
  |-- MCP stdio -----> server.js ----> POST /api/v1/memories/search
  |                                        memory.midbrain.ai
  |-- Hook scripts --> capture-user.mjs -----> POST /api/v1/memories/episodic
  |                    capture-assistant.mjs      memory.midbrain.ai
```

- **server.js** -- MCP server (Node 20, stdio transport). Exposes two tools:
  `memory_search` (query past memories) and `memory_setup_project` (configure
  per-project memory). Plain JavaScript, no build step.
- **plugin/midbrain-memory.ts** -- OpenCode plugin (Bun/TS). Hooks into
  `chat.message` and `message.updated` events. POSTs every message to the
  episodic endpoint. Fire-and-forget, never blocks.
- **claude-code/** -- Standalone Node 20 scripts wired to Claude Code's hook
  system. Same episodic capture, no dependencies beyond Node builtins.
- **shared/midbrain-common.mjs** -- Shared utilities (`loadApiKey`,
  `storeEpisodic`, `makeDebugLogger`) consumed by all components. Single source
  of truth for key resolution, API endpoints, and constants.

---

## How It Works

1. **Search** -- The LLM invokes `memory_search` via MCP. The server POSTs to
   the search API and returns scored results as formatted text.
2. **Capture (OpenCode)** -- The plugin hooks into OpenCode's message lifecycle.
   User messages are captured from `chat.message`; assistant messages from
   `message.updated` after completion. Each is POSTed to the episodic endpoint.
3. **Capture (Claude Code)** -- Hook scripts fire on `UserPromptSubmit` and
   `Stop` events. Each reads the message from stdin JSON and POSTs to the same
   episodic endpoint. Async, fire-and-forget.
4. **Project Setup** -- The LLM invokes `memory_setup_project` via MCP. The
   server creates the key file and project-level MCP config, then instructs
   the LLM to tell the user to restart.

---

## Configuration Reference

### Environment Variables

| Variable | Purpose | Set by |
|---|---|---|
| `MIDBRAIN_CONFIG_DIR` | Client config directory for key resolution | MCP config `environment`/`env` block |
| `MIDBRAIN_PROJECT_DIR` | Project directory for per-project key resolution | Project-level MCP config |
| `MIDBRAIN_API_KEY` | API key (CI/debug fallback only) | User environment |

### API Key Resolution

Keys are stored in files with `chmod 600`. The resolution chain (in order):

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

**Rules:**
- Permission denied (`EACCES`) on any key file is a hard error (not silent fallthrough)
- Empty key files are a hard error naming the file path
- When a project dir is specified but no project key found, a warning is emitted if resolution falls through to the global key

### Key File Locations

| Purpose | Path |
|---|---|
| Global default | `~/.config/midbrain/.midbrain-key` |
| OpenCode client | `~/.config/opencode/.midbrain-key` |
| Claude Code client | `~/.config/claude/.midbrain-key` |
| Project (flat) | `<projectDir>/.midbrain-key` |
| Project (recommended) | `<projectDir>/.midbrain/.midbrain-key` |

### Project-Level MCP Configs

**OpenCode** -- `<project>/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "midbrain-memory": {
      "type": "local",
      "command": ["<absolute-node-path>", "<absolute-path-to>/server.js"],
      "environment": {
        "MIDBRAIN_CONFIG_DIR": "<absolute-path>/.config/opencode",
        "MIDBRAIN_PROJECT_DIR": "<absolute-project-dir>"
      },
      "enabled": true
    }
  }
}
```

**Claude Code** -- `<project>/.mcp.json`:

```json
{
  "mcpServers": {
    "midbrain-memory": {
      "command": "<absolute-node-path>",
      "args": ["<absolute-path-to>/server.js"],
      "env": {
        "MIDBRAIN_CONFIG_DIR": "<absolute-path>/.config/claude",
        "MIDBRAIN_PROJECT_DIR": "<absolute-project-dir>"
      }
    }
  }
}
```

**Important:**
- All paths must be absolute. JSON does not expand `~`.
- Use the absolute path to the `node` binary (not bare `node`).
- OpenCode uses the `mcp` key. Claude Code uses `mcpServers`. Using the wrong
  key for either client will silently fail.

---

## LLM Rules for Your Project

Add these rules to your project's `AGENTS.md` (or `CLAUDE.md` for Claude Code)
so the AI assistant uses memory correctly:

```markdown
## MidBrain Memory Rules
- Use memory_search at session start to load relevant context
- NEVER create semantic memories. Semantic is managed by dream consolidation.
- NEVER create episodic memories. Episodic capture is automatic.
- The only memory tools available are search and setup. Use them proactively.
- When the user asks to set up, configure, or initialize MidBrain memory for a
  project, ALWAYS use the memory_setup_project tool. NEVER manually create
  .midbrain-key files, .mcp.json, or opencode.json with shell commands.
  The tool handles permissions, config merging, and path resolution correctly.
  Manual setup will break.
```

---

## Troubleshooting

### MCP server not connecting

**Symptom:** `memory_search` tool not available in your session.

**Check:**
```sh
# Verify the server starts
node /path/to/MidBrain_Memory_MCP/server.js
# Should print "MCP server running" to stderr
```

**Common causes:**
- Bare `node` in MCP config instead of absolute path (e.g., `/usr/local/bin/node`)
- `server.js` path is relative instead of absolute
- Missing `npm install` (MCP SDK not installed)
- Claude Code: check `~/.claude.json` for the MCP entry (NOT `~/.claude/settings.json` -- MCP servers in settings.json are silently ignored)

### Memory going to wrong agent

**Symptom:** Messages appear in the global agent dashboard instead of the project agent.

**Cause:** The session started before the project key was created. The plugin/hooks resolve the API key at init time and cache it.

**Fix:** Restart the application after running project setup. The restart message from `memory_setup_project` reminds you of this.

### Claude Code doesn't use the setup tool

**Symptom:** Claude Code web-searches for "Midbrain" instead of calling `memory_setup_project`.

**Cause:** Claude Code lazy-loads MCP tools. If your message doesn't trigger tool loading, it doesn't know the tool exists.

**Fix:** Name the tool explicitly:
```
Use the memory_setup_project tool to configure this project with API key sk-your-key
```

### Permission denied on key file

**Symptom:** `EACCES` error when the server starts or searches.

**Fix:**
```sh
chmod 600 /path/to/.midbrain-key
```

### Empty key file error

**Symptom:** Error message naming a specific key file as empty.

**Fix:** Either add a valid key to the file or remove it so the resolution chain falls through to the next source.

---

## API Reference

Base URL: `https://memory.midbrain.ai`

All endpoints use `Authorization: Bearer <key>` (except `/health`).

| Method | Endpoint | Body | Returns |
|---|---|---|---|
| POST | `/api/v1/memories/search` | `{"text": "query", "limit": 10}` | `[{role, text, memory_metadata, score}]` |
| POST | `/api/v1/memories/episodic` | `{"text": "...", "role": "user\|assistant"}` | Created memory object |
| GET | `/health` | -- | `{"status": "ok"}` |

---

## Manual Setup

If you prefer not to use the automated installer, follow these steps.

### Global API Key

```sh
mkdir -p ~/.config/midbrain
echo "sk-your-api-key" > ~/.config/midbrain/.midbrain-key
chmod 600 ~/.config/midbrain/.midbrain-key
```

### OpenCode

#### 1. Install dependencies

```sh
cd /path/to/MidBrain_Memory_MCP && npm install
```

#### 2. Register the MCP server

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "midbrain-memory": {
      "type": "local",
      "command": ["<absolute-node-path>", "<absolute-path-to>/server.js"],
      "environment": {
        "MIDBRAIN_CONFIG_DIR": "<absolute-path>/.config/opencode"
      },
      "enabled": true
    }
  }
}
```

#### 3. Install the plugin and shared lib

```sh
cp shared/midbrain-common.mjs ~/.config/opencode/plugins/midbrain-common.mjs
cp plugin/midbrain-memory.ts  ~/.config/opencode/plugins/midbrain-memory.ts
```

Both files must live in the same directory -- the plugin imports from
`./midbrain-common.mjs` at runtime.

### Claude Code

#### 1. Install dependencies

```sh
cd /path/to/MidBrain_Memory_MCP && npm install
```

#### 2. Register MCP server in `~/.claude.json`

```json
{
  "mcpServers": {
    "midbrain-memory": {
      "type": "stdio",
      "command": "<absolute-node-path>",
      "args": ["<absolute-path-to>/server.js"],
      "env": {
        "MIDBRAIN_CONFIG_DIR": "<absolute-path>/.config/claude"
      }
    }
  }
}
```

**Note:** MCP servers must be in `~/.claude.json`, not `~/.claude/settings.json`.
Entries in `settings.json` are silently ignored for MCP server registration.

#### 3. Add hooks and permissions to `~/.claude/settings.json`

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MIDBRAIN_CONFIG_DIR=<absolute-path>/.config/claude <absolute-node-path> <absolute-path-to>/claude-code/capture-user.mjs",
            "timeout": 10,
            "async": true
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MIDBRAIN_CONFIG_DIR=<absolute-path>/.config/claude <absolute-node-path> <absolute-path-to>/claude-code/capture-assistant.mjs",
            "timeout": 10,
            "async": true
          }
        ]
      }
    ]
  },
  "permissions": {
    "allow": [
      "mcp__midbrain-memory__memory_search",
      "mcp__midbrain-memory__memory_setup_project"
    ]
  }
}
```

---

## File Structure

```
MidBrain_Memory_MCP/
  server.js                  MCP server (Node 20, plain JS, 2 tools)
  install.mjs                Automated installer + --project CLI mode
  shared/
    midbrain-common.mjs      Shared utilities: key loading, store, logging
  plugin/
    midbrain-memory.ts       OpenCode plugin (Bun/TS)
  claude-code/
    common.mjs               Re-exports shared utils + readStdinJSON
    capture-user.mjs         UserPromptSubmit hook
    capture-assistant.mjs    Stop hook
  package.json
  AGENTS.md                  LLM project instructions
  README.md
```
