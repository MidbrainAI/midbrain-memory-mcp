# MidBrain Memory MCP

## What This Is
MCP server + OpenCode plugin for persistent AI memory.
API: https://memory.midbrain.ai

## Architecture
- `server.js` — MCP server (Node 20, plain JS). Exposes 1 tool: `memory_search`
- `plugin/midbrain-memory.ts` — OpenCode plugin. Auto-stores every message as
  episodic memory via `chat.message` hook. Runs in Bun (OpenCode's runtime).

## API Reference
- Auth: `Authorization: Bearer <key>` header
- `POST /api/v1/memories/search` — body: `{"text": "query", "limit": 10}`
  Returns: `[{role, text, memory_metadata, score}]`
- `POST /api/v1/memories/episodic` — body: `{"text": "...", "role": "user"|"assistant"}`
  Append-only. Returns created memory.
- `GET /health` — no auth. Returns `{"status": "ok"}`

## API Key
- Store in: ~/.config/opencode/.midbrain-key
- Server reads key at runtime with priority:
  1. MIDBRAIN_API_KEY env var
  2. .midbrain-key in process.cwd() (project-specific)
  3. ~/.config/opencode/.midbrain-key (global)

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
- Read API key same way as server (env var → local file → global file)
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
        "MIDBRAIN_API_KEY": "<your-key>"
      },
      "enabled": true
    }
  }
}
Note: Pass MIDBRAIN_API_KEY via environment block. process.cwd() is "/" when
launched by OpenCode, so file-based key resolution from cwd is unreliable.

## Plugin Location
Copy plugin/midbrain-memory.ts to ~/.config/opencode/plugins/midbrain-memory.ts

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
