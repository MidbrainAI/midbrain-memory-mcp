# MidBrain Memory MCP

Persistent AI memory for OpenCode. An MCP server exposes `memory_search` for
context retrieval; a companion plugin auto-captures every message as episodic
memory.

## Architecture

```
OpenCode session
  |
  |-- MCP stdio -----> server.js ----> POST /api/v1/memories/search
  |                                        memory.midbrain.ai
  |-- Plugin hook ---> midbrain-memory.ts -> POST /api/v1/memories/episodic
                                               memory.midbrain.ai
```

- **server.js** -- MCP server (Node 20, stdio transport). Exposes one tool:
  `memory_search`. Reads query, calls the search API, returns formatted results.
- **plugin/midbrain-memory.ts** -- OpenCode plugin (Bun/TS). Hooks into
  `chat.message` and `message.updated` events. Fires off a POST to the episodic
  endpoint for every user and assistant message. Fire-and-forget, never blocks.

## Prerequisites

- Node >= 20
- [OpenCode](https://opencode.ai)

## Setup

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

## How It Works

1. **Search** -- When the LLM invokes `memory_search`, the MCP server POSTs to
   the search API and returns scored results as formatted text.
2. **Capture** -- The plugin hooks into OpenCode's message lifecycle. User
   messages are captured inline from `chat.message`; assistant messages are
   captured from `message.updated` after completion. Each message is POSTed to
   the episodic endpoint. Deduplication is handled via a message ID set.

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
  package.json
  AGENTS.md                  LLM project instructions
  .gitignore
  README.md
```
