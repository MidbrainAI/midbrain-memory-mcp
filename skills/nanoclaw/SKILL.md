---
name: add-midbrain
description: Add MidBrain persistent memory. Agents recall past conversations and learned procedures via MCP tools, and new conversations are captured automatically.
---

# Add MidBrain Memory

Installs [midbrain-memory-mcp](https://github.com/MidbrainAI/midbrain-memory-mcp) for the agent group. Memory is stored server-side via the MidBrain API (https://memory.midbrain.ai) and persists across container restarts, agent groups, and clients.

## Prerequisites

- A MidBrain API key (get one at https://memory.midbrain.ai)
- Agent group using the default Claude provider (`AGENT_PROVIDER=claude`)

## Phase 1: Pre-flight

### Check if already applied

```bash
bash bin/ncl groups list --json 2>/dev/null | grep -q 'midbrain-memory' && echo "MCP already wired" || echo "Not applied"
```

If already applied, skip to Phase 3 (Verify).

## Phase 2: Apply

### 1. Collect the MidBrain API key

Ask the user for their MidBrain API key (from https://memory.midbrain.ai).
It starts with `mb-` or is a UUID-style string. Store it for use in steps
2-4. Be explicit: "What is your MidBrain API key?"

### 2. Install the package into the container image

Use the `install_packages` self-mod tool to bake midbrain-memory-mcp into
the per-group container image:

```
install_packages({ npm: ["midbrain-memory-mcp"], reason: "MidBrain persistent memory" })
```

This requires admin approval. Wait for approval before continuing.

### 3. Wire the MCP server

Use the `add_mcp_server` self-mod tool:

```
add_mcp_server({
  name: "midbrain-memory",
  command: "npx",
  args: ["-y", "midbrain-memory-mcp@latest"],
  env: {
    MIDBRAIN_CLIENT: "claude",
    MIDBRAIN_API_KEY: "<the-key-from-step-1>"
  }
})
```

This requires admin approval.

### 4. Wire episodic capture hooks

The `.claude/` directory is mounted from the host into the container at
`/home/node/.claude`. Writing hook configs to the host-side settings file
makes them persistent across container restarts.

#### 4a. Find the agent group ID and settings path

```bash
AGENT_GROUP_ID=$(bash bin/ncl groups list --json | jq -r '.[0].id')
SETTINGS_DIR="data/v2-sessions/${AGENT_GROUP_ID}/.claude-shared"
SETTINGS_FILE="${SETTINGS_DIR}/settings.json"
mkdir -p "$SETTINGS_DIR"
```

#### 4b. Discover the hook script paths inside the container

Wait for the container to restart after steps 2-3, then resolve the
package path via pnpm. The hook directory varies by version:

- v0.3.x: `<pnpm-root>/midbrain-memory-mcp/claude-code/`
- v0.4.0+: `<pnpm-root>/midbrain-memory-mcp/plugins/claude-code/`

Discover the correct path:

```bash
CONTAINER=$(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1)
PKG_ROOT=$(docker exec "$CONTAINER" sh -c 'echo "$(pnpm root -g)/midbrain-memory-mcp"')

# Check which path structure exists
if docker exec "$CONTAINER" test -d "$PKG_ROOT/plugins/claude-code"; then
  HOOK_DIR="$PKG_ROOT/plugins/claude-code"
else
  HOOK_DIR="$PKG_ROOT/claude-code"
fi
echo "Hook directory: $HOOK_DIR"
```

Verify the hooks exist inside the container:

```bash
docker exec "$CONTAINER" ls "$HOOK_DIR/capture-user.mjs" "$HOOK_DIR/capture-assistant.mjs"
```

Both files should be listed. If not, `install_packages` may not have
completed — wait for the per-group image build to finish and restart.

#### 4c. Write hooks to the mounted settings

Read the existing settings (or start with empty object):

```bash
cat "$SETTINGS_FILE" 2>/dev/null || echo '{}'
```

Merge the following hook entries into the `hooks` key of the settings JSON.
**Preserve any existing hooks** (like mnemon). Append to existing arrays,
don't replace them. Use `$HOOK_DIR` from step 4b and `<MIDBRAIN_API_KEY>`
from step 1.

**Important:** The API key must be inline in the hook command because
container-level env vars are not passed to hook child processes.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "MIDBRAIN_API_KEY=<the-key-from-step-1> node <HOOK_DIR>/capture-user.mjs"
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
            "command": "MIDBRAIN_API_KEY=<the-key-from-step-1> node <HOOK_DIR>/capture-assistant.mjs"
          }
        ]
      }
    ]
  }
}
```

Replace `<the-key-from-step-1>` with the actual MidBrain API key and
`<HOOK_DIR>` with the actual path discovered in step 4b.

Write the merged settings back to `$SETTINGS_FILE`.

### 5. Add the API key to .env

Add to `.env` (skip if already present):

```bash
MIDBRAIN_API_KEY=<the-key-from-step-1>
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### 6. Restart the service

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
```

## Phase 3: Verify

### Confirm MCP server is wired

```bash
docker logs $(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1) 2>&1 | grep -i midbrain
```

Should show `Additional MCP server: midbrain-memory (npx)`.

### Confirm hooks are registered

```bash
AGENT_GROUP_ID=$(bash bin/ncl groups list --json | jq -r '.[0].id')
cat "data/v2-sessions/${AGENT_GROUP_ID}/.claude-shared/settings.json" | grep capture
```

Should show `capture-user.mjs` and `capture-assistant.mjs`.

### Test memory capture and search

1. Send a test message:

```bash
pnpm run chat "Remember this: the test code is alpha99"
```

2. Search for it (wait ~30 seconds for indexing):

```bash
pnpm run chat "Use the memory_search tool to search for alpha99"
```

If the search finds the test message, the full pipeline is working.

## MCP Tools Available

| Tool | Purpose |
|------|---------|
| `memory_search` | Semantic search across all memories |
| `grep` | Exact pattern matching |
| `get_episodic_memories_by_date` | Conversation history by date |
| `check_session_status` | Detect recent activity from other sessions |
| `procedural_knowledge` | Recall learned procedures and workflows |
| `list_files` | Browse semantic memory documents |
| `read_file` | Read a semantic memory document |
| `memory_setup_project` | Configure per-project memory scoping |

## Troubleshooting

### `memory_search` returns "No memories found"

The MCP server is running but no conversations have been captured yet.
Send a few messages first, then search.

### Hooks not capturing conversations

Verify the hooks are in the mounted settings:

```bash
AGENT_GROUP_ID=$(bash bin/ncl groups list --json | jq -r '.[0].id')
cat "data/v2-sessions/${AGENT_GROUP_ID}/.claude-shared/settings.json" | grep capture
```

If absent, re-run Phase 2 step 4.

### Invalid API key errors

```bash
curl -H "Authorization: Bearer <your-key>" https://memory.midbrain.ai/health
```

Should return `{"status": "ok"}`.

### MCP server not available to agent

```bash
bash bin/ncl groups config get --id <agent-group-id> | grep midbrain
```

If absent, re-run Phase 2 step 3.

### Hook scripts not found in container

The package may not be installed in the per-group image. Verify:

```bash
CONTAINER=$(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1)
docker exec "$CONTAINER" pnpm ls -g midbrain-memory-mcp
```

If not listed, re-run Phase 2 step 2 (`install_packages`).

## Removing MidBrain Memory

### Remove MCP server

```bash
bash bin/ncl groups config remove-mcp-server --id <agent-group-id> --name midbrain-memory
```

### Remove hooks

Edit `data/v2-sessions/<groupId>/.claude-shared/settings.json` and remove
the `capture-user.mjs` and `capture-assistant.mjs` hook entries.

### Remove from environment

Remove `MIDBRAIN_API_KEY` from `.env` and `data/env/env`.

### Restart

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)
```
