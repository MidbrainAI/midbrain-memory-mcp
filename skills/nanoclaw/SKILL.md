---
name: add-midbrain
description: Add MidBrain persistent memory. Agents recall past conversations and learned procedures via MCP tools, and new conversations are captured automatically.
---

# Add MidBrain Memory

Installs [midbrain-memory-mcp](https://github.com/MidbrainAI/midbrain-memory-mcp) in the agent container. On each container start, the installer registers Claude Code hooks that capture conversations as episodic memories and wires the MCP server for memory search, procedural knowledge, and cross-session context.

Memory is stored server-side via the MidBrain API (https://memory.midbrain.ai) and persists indefinitely across container restarts, agent groups, and clients.

## Prerequisites

- A MidBrain API key (get one at https://memory.midbrain.ai)
- Agent group using the default Claude provider (`AGENT_PROVIDER=claude`)

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'midbrain-memory-mcp' container/Dockerfile && echo "Already applied" || echo "Not applied"
```

If already applied, re-run Phase 2 anyway (every step is idempotent), then continue to Phase 3 (Verify).

### Check latest version

```bash
curl -fsSL https://registry.npmjs.org/midbrain-memory-mcp/latest | grep '"version"'
```

Note the version (e.g. `0.4.0`) — use it as `MIDBRAIN_MCP_VERSION` in the next step.

## Phase 2: Apply Changes

### 1. Collect the MidBrain API key

Ask the user for their MidBrain API key (from https://memory.midbrain.ai). It starts with `mb-` or is a UUID-style string. Store it for use in steps 2 and 3. Be explicit: "What is your MidBrain API key?"

### 2. Dockerfile — install midbrain-memory-mcp

Insert the midbrain block immediately above the `# ---- Bun runtime` section of `container/Dockerfile` (skip if `grep -q 'MIDBRAIN_MCP_VERSION' container/Dockerfile` already matches):

```dockerfile
# ---- midbrain-memory-mcp — persistent AI memory ------------------------------
ARG MIDBRAIN_MCP_VERSION=0.4.0
RUN npm install -g midbrain-memory-mcp@${MIDBRAIN_MCP_VERSION}
```

### 3. Entrypoint — run midbrain install on each container start

The installer is idempotent. Run it once per `container/entrypoint.sh`. First check whether the line is already present:

```bash
grep -q 'midbrain-memory-mcp' container/entrypoint.sh && echo "Already wired" || echo "Wire it"
```

If it prints `Wire it`, add the install call right after `set -e`, before the `cat` that captures stdin, so the result looks like:

```bash
#!/bin/bash
# NanoClaw agent container entrypoint.
#
# ...existing header comment...

set -e

npx -y midbrain-memory-mcp@latest install --non-interactive >/dev/stderr 2>&1 || true

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
```

`>/dev/stderr 2>&1` routes output to stderr (docker logs) so it doesn't interfere with the JSON stdin handshake. `|| true` ensures a failed install doesn't prevent the agent from starting.

### 4. Environment — add the API key

Add to `.env` (skip if already present):

```bash
MIDBRAIN_API_KEY=<the-key-from-step-1>
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### 5. Container config — wire the MCP server

For each agent group that should have memory, run:

```bash
bash bin/ncl groups config add-mcp-server \
  --id <agent-group-id> \
  --name midbrain-memory \
  --command npx \
  --args '["-y", "midbrain-memory-mcp@latest"]' \
  --env '{"MIDBRAIN_CLIENT": "claude", "MIDBRAIN_API_KEY": "<the-key-from-step-1>"}'
```

To apply to all agent groups:

```bash
bash bin/ncl groups list --json | jq -r '.[].id' | while read gid; do
  bash bin/ncl groups config add-mcp-server \
    --id "$gid" \
    --name midbrain-memory \
    --command npx \
    --args '["-y", "midbrain-memory-mcp@latest"]' \
    --env "{\"MIDBRAIN_CLIENT\": \"claude\", \"MIDBRAIN_API_KEY\": \"<the-key-from-step-1>\"}"
done
```

### 6. Rebuild and verify the image

```bash
./container/build.sh
docker run --rm --entrypoint npx nanoclaw-agent:latest -y midbrain-memory-mcp@latest --version
```

## Phase 3: Restart and Verify

### Restart the service

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# launchctl kickstart -k gui/$(id -u)/$(launchd_label)   # macOS
```

### Confirm hooks are registered

After the next container starts, check that install ran:

```bash
docker logs $(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1) 2>&1 | grep -i midbrain
```

Then inspect the hooks inside the running container:

```bash
docker exec $(docker ps --filter name=nanoclaw-v2 --format '{{.Names}}' | head -1) \
  cat /home/node/.claude/settings.json | grep -A5 midbrain
```

### Test memory capture and search

1. Send a test message:

```bash
pnpm run chat "Remember this: the test code is alpha99"
```

2. Search for it:

```bash
pnpm run chat "Use the memory_search tool to search for alpha99"
```

If the search finds the test message, the full pipeline is working: conversation capture (hooks) + memory search (MCP server).

## MCP Tools Available

Once installed, agents have access to:

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

The MCP server is running but no conversations have been captured yet. Send a few messages first, then search.

### Hooks not capturing conversations

Verify the install ran inside the container:

```bash
docker exec <container> cat /home/node/.claude/settings.json | grep capture
```

If no capture hooks are present, the entrypoint install may have failed. Check container startup logs:

```bash
docker logs <container> 2>&1 | grep midbrain
```

### Invalid API key errors

Verify the API key is correct:

```bash
curl -H "Authorization: Bearer <your-key>" https://memory.midbrain.ai/health
```

Should return `{"status": "ok"}`.

### MCP server not available to agent

Verify the MCP server is wired in the agent group config:

```bash
bash bin/ncl groups config get --id <agent-group-id> | grep midbrain
```

If absent, re-run Phase 2 step 5.

## Removing MidBrain Memory

### Remove MCP server from agent groups

```bash
bash bin/ncl groups config remove-mcp-server --id <agent-group-id> --name midbrain-memory
```

### Remove from Dockerfile

Delete the `# ---- midbrain-memory-mcp` block from `container/Dockerfile`.

### Remove from entrypoint

Delete the `npx -y midbrain-memory-mcp@latest install` line from `container/entrypoint.sh`.

### Remove from environment

Remove `MIDBRAIN_API_KEY` from `.env` and `data/env/env`.

### Rebuild

```bash
./container/build.sh
```
