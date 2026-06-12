---
name: add-midbrain
description: Add MidBrain persistent memory. Agents recall past conversations and learned procedures via MCP tools, and new conversations are captured automatically.
---

# Add MidBrain Memory

Installs [`midbrain-memory-mcp@latest`](https://github.com/MidbrainAI/midbrain-memory-mcp) for one NanoClaw agent group. Memory is stored server-side via the MidBrain API and persists across container restarts, agent groups, and clients.

## Safety Rules

- Ask the operator before changing a group, rebuilding an image, or restarting NanoClaw.
- Never print, paste, or store the real MidBrain API key in chat output.
- When showing hook commands, always redact inline keys as `MIDBRAIN_API_KEY=<redacted>`.
- Preserve existing MCP servers, settings, hooks, and environment values.
- Use the direct `.claude-shared/settings.json` settings merge design. Do not add container boot scripts.

## Prerequisites

- A MidBrain API key from https://memory.midbrain.ai.
- A NanoClaw agent group using the Claude provider.
- Access to NanoClaw self-mod tools, or operator approval to run the equivalent commands.

## Phase 1: Choose The Agent Group

List groups:

```bash
bash bin/ncl groups list --json
```

If exactly one group exists, you may select it and say which group was selected.

If multiple agent groups exist, ask the operator to choose the target group by ID or name. Do not silently choose the first group.

Set:

```bash
AGENT_GROUP_ID="<operator-selected-group-id>"
SETTINGS_DIR="data/v2-sessions/${AGENT_GROUP_ID}/.claude-shared"
SETTINGS_FILE="${SETTINGS_DIR}/settings.json"
mkdir -p "$SETTINGS_DIR"
```

## Phase 2: Collect The Key

Ask the operator for their MidBrain API key. Keep it only in local shell variables or the approved NanoClaw config files. Do not echo it back.

```bash
MIDBRAIN_API_KEY="<operator-provided-key>"
```

## Phase 3: Install MCP For The Group

Use NanoClaw self-mod tooling when available:

```text
install_packages({ npm: ["midbrain-memory-mcp@latest"], reason: "MidBrain persistent memory" })
```

Then add the MCP server for the selected group:

```text
add_mcp_server({
  name: "midbrain-memory",
  command: "npx",
  args: ["-y", "midbrain-memory-mcp@latest"],
  env: {
    MIDBRAIN_CLIENT: "claude",
    MIDBRAIN_API_KEY: "<redacted>"
  }
})
```

If using the NanoClaw CLI instead of self-mod tooling, preserve existing group config and run the equivalent `bash bin/ncl groups config add-mcp-server` command for the selected `AGENT_GROUP_ID`.

## Phase 4: Discover Hook Paths In The Container

After the package install completes and the group image is available, find the running container and installed package root:

```bash
CONTAINER=$(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1)
PKG_NAME="midbrain-memory-mcp"
PKG_ROOT=$(docker exec "$CONTAINER" sh -c "echo \"$(pnpm root -g)/${PKG_NAME}\"")

if docker exec "$CONTAINER" test -d "$PKG_ROOT/plugins/claude-code"; then
  HOOK_DIR="$PKG_ROOT/plugins/claude-code"
else
  HOOK_DIR="$PKG_ROOT/claude-code"
fi

NODE_BIN=$(docker exec "$CONTAINER" sh -c "command -v node")
docker exec "$CONTAINER" test -f "$HOOK_DIR/capture-user.mjs"
docker exec "$CONTAINER" test -f "$HOOK_DIR/capture-assistant.mjs"
```

## Phase 5: Direct Settings Merge

Merge MidBrain hooks directly into the mounted Claude settings file:

```bash
cat "$SETTINGS_FILE" 2>/dev/null || echo '{}'
```

Rules for the merge:

- Preserve every existing top-level setting.
- Preserve every non-MidBrain hook entry.
- Replace old MidBrain hook entries instead of duplicating them.
- Add `UserPromptSubmit` and `Stop` command hooks.
- Use inline `MIDBRAIN_API_KEY` only in the local mounted settings file.
- Redact inline keys in all summaries, diffs, and chat messages.

The resulting settings must contain commands equivalent to this redacted shape:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "MIDBRAIN_API_KEY=<redacted> ${NODE_BIN} ${HOOK_DIR}/capture-user.mjs"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "MIDBRAIN_API_KEY=<redacted> ${NODE_BIN} ${HOOK_DIR}/capture-assistant.mjs"
          }
        ]
      }
    ]
  }
}
```

When writing the real file, replace `<redacted>` with the local key value and expand `NODE_BIN` and `HOOK_DIR`. Do not show the real command afterward.

## Phase 6: Environment File

If the group also needs an env file, add the key without printing it:

```bash
printf 'MIDBRAIN_API_KEY=%s\n' "$MIDBRAIN_API_KEY" >> .env
mkdir -p data/env
cp .env data/env/env
```

Do not commit `.env`, `data/env/env`, or any NanoClaw group settings.

## Phase 7: Restart With Approval

Ask the operator before restarting the selected group or service. Use the NanoClaw command appropriate for the local installation.

## Phase 8: Verify

Verify MCP tools:

```bash
bash bin/ncl groups config get --id "$AGENT_GROUP_ID" | grep midbrain-memory
```

Verify hook registration without printing keys:

```bash
grep -E 'capture-user\.mjs|capture-assistant\.mjs' "$SETTINGS_FILE"
```

Verify memory search from the agent:

1. Send a harmless test phrase.
2. Wait for indexing.
3. Use `memory_search` to find the phrase.

## MCP Tools Available

| Tool | Purpose |
|------|---------|
| `memory_search` | Semantic search across memories |
| `grep` | Exact pattern matching |
| `get_episodic_memories_by_date` | Conversation history by date |
| `check_session_status` | Detect recent activity from other sessions |
| `list_files` | Browse semantic memory documents |
| `read_file` | Read a semantic memory document |
| `memory_setup_project` | Configure per-project memory scoping |

Procedural knowledge is injected automatically by MidBrain hooks when relevant.
Do not call or expect a separate procedural-knowledge MCP tool.

## Troubleshooting

### MCP server not available

Check the selected group config:

```bash
bash bin/ncl groups config get --id "$AGENT_GROUP_ID" | grep midbrain-memory
```

### Hooks not capturing

Check mounted settings and redact any inline key before sharing output:

```bash
grep -E 'capture-user\.mjs|capture-assistant\.mjs' "$SETTINGS_FILE"
```

### Hook scripts not found

Verify the package in the container:

```bash
PKG_NAME="midbrain-memory-mcp"
docker exec "$CONTAINER" pnpm ls -g "$PKG_NAME"
```

If missing, re-run the package installation step and wait for the image build to complete.

## Removing MidBrain Memory

Remove the MidBrain MCP server from the selected group, remove only MidBrain hook entries from `data/v2-sessions/<group-id>/.claude-shared/settings.json`, remove local key env entries, and restart with operator approval.
