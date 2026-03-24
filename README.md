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

- **server.js** -- MCP server (Node 20, stdio transport). Exposes one tool:
  `memory_search`. Reads query, calls the search API, returns formatted results.
- **plugin/midbrain-memory.ts** -- OpenCode plugin (Bun/TS). Hooks into
  `chat.message` and `message.updated` events. Fires off a POST to the episodic
  endpoint for every user and assistant message. Fire-and-forget, never blocks.
- **claude-code/** -- Standalone Node 20 scripts wired to Claude Code's hook
  system. Same episodic capture, no dependencies beyond Node builtins.

## Prerequisites

- Node >= 20
- [OpenCode](https://opencode.ai) and/or [Claude Code](https://docs.anthropic.com/en/docs/claude-code)

## OpenCode Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Configure API key

Set via environment variable (preferred):

```sh
export MIDBRAIN_API_KEY=<your-api-key>
```

Or create a key file:

```sh
echo "<your-api-key>" > ~/.config/opencode/.midbrain-key
```

### 3. Register the MCP server

Add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "midbrain-memory": {
      "type": "local",
      "command": ["node", "/path/to/MidBrain_Memory_MCP/server.js"],
      "environment": {
        "MIDBRAIN_API_KEY": "<your-api-key>"
      },
      "enabled": true
    }
  }
}
```

### 4. Install the plugin

```sh
cp plugin/midbrain-memory.ts ~/.config/opencode/plugins/midbrain-memory.ts
```

## Claude Code Setup

### 1. Install MCP server dependencies

```sh
cd /path/to/MidBrain_Memory_MCP && npm install
```

### 2. Add to `~/.claude/settings.json`

Replace every `<your-api-key>` and `/absolute/path/to` with your actual values:

```json
{
  "mcpServers": {
    "midbrain-memory": {
      "command": "node",
      "args": ["/absolute/path/to/MidBrain_Memory_MCP/server.js"],
      "env": {
        "MIDBRAIN_API_KEY": "<your-api-key>"
      }
    }
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MIDBRAIN_API_KEY=<your-api-key> node /absolute/path/to/MidBrain_Memory_MCP/claude-code/capture-user.mjs",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MIDBRAIN_API_KEY=<your-api-key> node /absolute/path/to/MidBrain_Memory_MCP/claude-code/capture-assistant.mjs",
            "async": true,
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Works identically on Claude Code CLI and the Claude Mac app.

## How It Works

1. **Search** -- When the LLM invokes `memory_search`, the MCP server POSTs to
   the search API and returns scored results as formatted text.
2. **Capture (OpenCode)** -- The plugin hooks into OpenCode's message lifecycle.
   User messages are captured from `chat.message`; assistant messages from
   `message.updated` after completion. Each is POSTed to the episodic endpoint.
3. **Capture (Claude Code)** -- Hook scripts fire on `UserPromptSubmit` and
   `Stop` events. Each reads the message from stdin JSON and POSTs to the same
   episodic endpoint. Async, fire-and-forget.

## API Reference

All endpoints use `Authorization: Bearer <key>`.

| Method | Endpoint                        | Body                                  | Returns                              |
|--------|---------------------------------|---------------------------------------|--------------------------------------|
| POST   | `/api/v1/memories/search`       | `{"text": "query", "limit": 10}`     | `[{role, text, memory_metadata, score}]` |
| POST   | `/api/v1/memories/episodic`     | `{"text": "...", "role": "user"\|"assistant"}` | Created memory object |
| GET    | `/health`                       | --                                    | `{"status": "ok"}`                   |

## File Structure

```
MidBrain_Memory_MCP/
  server.js                  MCP server (Node 20, plain JS)
  plugin/
    midbrain-memory.ts       OpenCode plugin (Bun/TS)
  claude-code/
    common.mjs               Shared key resolution, POST, logging
    capture-user.mjs         UserPromptSubmit hook
    capture-assistant.mjs    Stop hook
  package.json
  AGENTS.md                  LLM project instructions
  .gitignore
  README.md
```
