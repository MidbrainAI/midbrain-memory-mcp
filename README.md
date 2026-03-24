# MidBrain Memory MCP

Persistent AI memory for coding agents. An MCP server exposes `memory_search`
for context retrieval; companion hooks auto-capture every message as episodic
memory. Works with **OpenCode** and **Claude Code**.

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

- **server.js** — MCP server (Node 20, stdio transport). Exposes one tool:
  `memory_search`. Reads query, calls the search API, returns formatted results.
- **plugin/midbrain-memory.ts** — OpenCode plugin (Bun/TS). Hooks into
  `chat.message` and `message.updated` events. Fires off a POST to the episodic
  endpoint for every user and assistant message. Fire-and-forget, never blocks.
- **claude-code/** — Standalone Node 20 scripts wired to Claude Code's hook
  system. Same episodic capture, no dependencies beyond Node builtins.
- **shared/midbrain-common.mjs** — Shared utilities (key loading, `storeEpisodic`,
  `makeDebugLogger`) consumed by all of the above. Single source of truth.

## Prerequisites

- Node >= 20
- [OpenCode](https://opencode.ai) and/or [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

## Installation (Recommended)

```sh
npm install
node install.mjs
```

The installer auto-detects OpenCode and Claude Code, prompts for your API key(s)
(supports different keys per client for multi-embodiment), writes per-client key
files with `chmod 600`, copies the plugin and shared lib, and patches all config
files. Running it a second time is safe — it's idempotent.

## Manual Setup

### API Key

Keys are stored in files with `chmod 600` (file-first, env var is CI fallback only).
Each client has its own key file to support multi-embodiment with different keys.

Priority chain (`loadApiKey(projectDir?, configDir?)`):

1. `.midbrain-key` in your project directory (per-project override)
2. `.midbrain-key` in client config directory (per-client)
3. `MIDBRAIN_API_KEY` environment variable (CI/debug)
4. `~/.config/midbrain/.midbrain-key` (global default)

Key file locations:

| Purpose | Path |
|---|---|
| Global default | `~/.config/midbrain/.midbrain-key` |
| OpenCode | `~/.config/opencode/.midbrain-key` |
| Claude Code | `~/.config/claude/.midbrain-key` |
| Project override | `<projectDir>/.midbrain-key` |

Store a global default manually:

```sh
mkdir -p ~/.config/midbrain
echo "<your-api-key>" > ~/.config/midbrain/.midbrain-key
chmod 600 ~/.config/midbrain/.midbrain-key
```

### OpenCode — Manual

#### 1. Install dependencies

```sh
npm install
```

#### 2. Register the MCP server

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "midbrain-memory": {
      "type": "local",
      "command": ["node", "/path/to/MidBrain_Memory_MCP/server.js"],
      "environment": {
        "MIDBRAIN_CONFIG_DIR": "~/.config/opencode"
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

Both files must live in the same directory — the plugin imports from
`./midbrain-common.mjs` at runtime.

### Claude Code — Manual

#### 1. Install MCP server dependencies

```sh
cd /path/to/MidBrain_Memory_MCP && npm install
```

#### 2. Register MCP server in `~/.claude.json`

```json
{
  "mcpServers": {
    "midbrain-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/MidBrain_Memory_MCP/server.js"],
      "env": {
        "MIDBRAIN_CONFIG_DIR": "~/.config/claude"
      }
    }
  }
}
```

#### 3. Add hooks and permissions to `~/.claude/settings.json`

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MIDBRAIN_CONFIG_DIR=~/.config/claude node /absolute/path/to/MidBrain_Memory_MCP/claude-code/capture-user.mjs"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MIDBRAIN_CONFIG_DIR=~/.config/claude node /absolute/path/to/MidBrain_Memory_MCP/claude-code/capture-assistant.mjs"
          }
        ]
      }
    ]
  },
  "permissions": {
    "allow": ["mcp__midbrain-memory__memory_search"]
  }
}
```

The hook scripts read the API key from `~/.config/claude/.midbrain-key`
automatically — no key material in the command string.

## How It Works

1. **Search** — When the LLM invokes `memory_search`, the MCP server POSTs to
   the search API and returns scored results as formatted text.
2. **Capture (OpenCode)** — The plugin hooks into OpenCode's message lifecycle.
   User messages are captured from `chat.message`; assistant messages from
   `message.updated` after completion. Each is POSTed to the episodic endpoint.
3. **Capture (Claude Code)** — Hook scripts fire on `UserPromptSubmit` and
   `Stop` events. Each reads the message from stdin JSON and POSTs to the same
   episodic endpoint. Async, fire-and-forget.

## API Reference

All endpoints use `Authorization: Bearer <key>`.

| Method | Endpoint                    | Body                                           | Returns                                  |
|--------|-----------------------------|------------------------------------------------|------------------------------------------|
| POST   | `/api/v1/memories/search`   | `{"text": "query", "limit": 10}`              | `[{role, text, memory_metadata, score}]` |
| POST   | `/api/v1/memories/episodic` | `{"text": "...", "role": "user\|assistant"}`   | Created memory object                    |
| GET    | `/health`                   | —                                              | `{"status": "ok"}`                       |

## File Structure

```
MidBrain_Memory_MCP/
  server.js                  MCP server (Node 20, plain JS)
  install.mjs                Automated installer
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
  .gitignore
  README.md
```
