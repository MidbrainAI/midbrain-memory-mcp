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
- Durable NanoClaw config must use `midbrain-memory-mcp@latest`, not a pinned version or a package-store path.

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

Add the MCP server for the selected group with an auto-updating `npx @latest`
command:

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

## Phase 4: Install Proactive Memory Rules

Resolve the selected group's `folder` from:

```bash
bash bin/ncl groups get --id "$AGENT_GROUP_ID" --json
```

Update `groups/<folder>/CLAUDE.local.md`. Preserve all existing content and
replace only a byte-recognized MidBrain block shipped by this package. Preserve
unknown customized or malformed blocks for manual review; never delete custom
MidBrain hardening. Otherwise append the block once. Do not edit the composed
`CLAUDE.md`, which NanoClaw regenerates.

<!-- midbrain-memory-rules:start -->
### Tool loading

- NanoClaw: if MidBrain is deferred, `ToolSearch` for `memory_search` or the
  needed function—not only the server name—then call it. Discovery is the only
  allowed pre-recall action. Continue externalized results only with `Read`.

## MidBrain Memory

- Before substantive work, recall relevant MidBrain context; skip only trivial
  self-contained work or explicit opt-out. Start with contextual
  `memory_search`. Search one target per call. Treat every request ID, name,
  file, and date as a retrieval anchor: copy it verbatim into the query; never
  merge or generalize targets. Never use `check_session_status` as a default
  primer; use it only when the user signals session/client continuity or
  recent-session metadata is itself needed, then perform targeted search/date
  recall.
- Use recovered context. Refine irrelevant or incomplete results before acting
  and recall again only for a new material target.
- Tools: `memory_search(all)` for broad context; episodic search for prior
  conversations/decisions; `get_episodic_memories_by_date` for known periods
  or continuity; semantic search plus `list_files`/`read_file` for stored
  documents; `grep` for exact semantic anchors only. MidBrain
  `list_files`/`read_file` read remote memory, so local-filesystem bans do
  not prohibit them.
- Reliability outranks cost. Start near 10 results; if the target is absent or
  noisy, repeat at the supported maximum (currently 50). Then refine anchors or
  surfaces, paginate, or traverse dates while useful. Ranked misses are not
  absence; recall depth is uncapped. Stop on direct recovery.
- Current/latest claims require the underlying state-changing episode or direct
  current evidence; assistant restatements are insufficient. Current repos,
  configs, and live systems override memory.
- Report only `found`, `maybe found`, or `not found after search`; report
  tool failure separately. Never infer or reconstruct missing memory.
- Never query secrets/large sensitive blobs or create memories.
  `memory_setup_project` requires an explicit setup request.
- Procedural knowledge is not injected automatically unless
  `MIDBRAIN_ENABLE_PK_INJECTION=1`.
<!-- midbrain-memory-rules:end -->

## Phase 5: Prepare Durable Hook Commands

Hooks call the stable MidBrain shim, which the MCP server installs and keeps
fresh at `~/.midbrain/bin/claude-hook` on every server start (inside NanoClaw
containers the home directory is `/home/node`):

```bash
HOOK_SHIM="/home/node/.midbrain/bin/claude-hook"
USER_HOOK_CMD="MIDBRAIN_API_KEY=${MIDBRAIN_API_KEY} '${HOOK_SHIM}' user"
ASSISTANT_HOOK_CMD="MIDBRAIN_API_KEY=${MIDBRAIN_API_KEY} '${HOOK_SHIM}' assistant"
```

Key delivery is double-covered: at server start the MCP server persists its
env key to the global key file for hook child processes, and the inline
`MIDBRAIN_API_KEY` prefix rides on the hook command as a fallback. Self-repair
preserves leading inline `MIDBRAIN_*` assignments when it rewrites hook
entries.

Do not discover or write `/pnpm/.../midbrain-memory-mcp@<version>/...` hook
paths. Versioned package-store paths pin hooks to an old release. The shim
resolves `midbrain-memory-mcp@latest` internally, so NanoClaw cold starts
always run the current package.

## Phase 6: Direct Settings Merge

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
- Use the shim commands from Phase 5, with `"timeout": 30` on both hooks and
  `"async": true` on the `Stop` hook — self-repair enforces exactly this
  shape.
- Redact inline keys in all summaries, diffs, and chat messages.

The resulting settings must contain commands equivalent to this redacted shape:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MIDBRAIN_API_KEY=<redacted> '/home/node/.midbrain/bin/claude-hook' user",
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MIDBRAIN_API_KEY=<redacted> '/home/node/.midbrain/bin/claude-hook' assistant",
            "timeout": 30,
            "async": true
          }
        ]
      }
    ]
  }
}
```

When writing the real file, replace `<redacted>` with the local key value. Do
not show the real command afterward.

### Legacy form (pre-0.4.8)

Older installs wrote inline-key npx hook commands —
`midbrain-memory-mcp@latest hook claude user` and
`midbrain-memory-mcp@latest hook claude assistant`. Self-repair migrates those
entries to the shim form on server start and preserves leading `MIDBRAIN_*`
assignments. Do not write the npx form for new installs.

## Phase 7: Environment File

If the group also needs an env file, add the key without printing it:

```bash
printf 'MIDBRAIN_API_KEY=%s\n' "$MIDBRAIN_API_KEY" >> .env
mkdir -p data/env
cp .env data/env/env
```

Do not commit `.env`, `data/env/env`, or any NanoClaw group settings.

Container env files do not reach hook child processes; hooks get their key
from the Phase 5 delivery paths (server-start persistence plus the inline
prefix).

## Phase 8: Restart With Approval

Ask the operator before restarting the selected group or service. Use the NanoClaw command appropriate for the local installation.

## Phase 9: Verify

Verify MCP tools:

```bash
bash bin/ncl groups config get --id "$AGENT_GROUP_ID" | grep midbrain-memory
```

Verify hook registration without printing keys (quiet grep — matching lines
carry the inline key and must never be echoed):

```bash
grep -Fq ".midbrain/bin/claude-hook" "$SETTINGS_FILE" && echo "midbrain hooks registered"
```

Verify memory search from the agent:

1. Send a harmless test phrase.
2. Wait for indexing.
3. Use `memory_search` to find the phrase.

Verify `groups/<folder>/CLAUDE.local.md` contains exactly one
`midbrain-memory-rules:start` / `midbrain-memory-rules:end` block.

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

Procedural knowledge is not injected automatically by MidBrain hooks. Use the
explicit memory tools for recall; do not call or expect a separate
procedural-knowledge MCP tool. Legacy PK injection only runs when
`MIDBRAIN_ENABLE_PK_INJECTION=1` is set explicitly in the hook environment.

## Troubleshooting

### MCP server not available

Check the selected group config:

```bash
bash bin/ncl groups config get --id "$AGENT_GROUP_ID" | grep midbrain-memory
```

### Hooks not capturing

Check mounted settings and redact any inline key before sharing output:

```bash
grep -F ".midbrain/bin/claude-hook" "$SETTINGS_FILE"
```

Capture is fail-open: a hook that cannot resolve a key exits 0 silently and
logs `NO KEY` to `~/.local/state/midbrain/midbrain-claude.log` inside the
container. The MCP server persists its env key to
`~/.config/midbrain/.midbrain-key` at server start; if that file is missing
after a fresh session, confirm the group's MCP env still carries
`MIDBRAIN_API_KEY`, then restart the group with approval.

When rotating the group's key, update the MCP env and recreate the group's
container with approval: the persisted key file is absence-only, and a fresh
container rebuilds it from the new env. A restarted (not recreated) container
keeps its old file, and the stale key outranks the new env until recreation.

### Hooks still show an old version

If `settings.json`, `container.json`, or `bash bin/ncl groups config get` shows
`midbrain-memory-mcp@0.3.2` or any other pinned version, remove the old
`midbrain-memory` MCP server, add it again with
`midbrain-memory-mcp@latest`, replace the MidBrain hook entries with the
Phase 5 shim commands, then restart the group.

```bash
bash bin/ncl groups config remove-mcp-server --id "$AGENT_GROUP_ID" --name midbrain-memory
bash bin/ncl groups config add-mcp-server \
  --id "$AGENT_GROUP_ID" \
  --name midbrain-memory \
  --command npx \
  --args '["-y", "midbrain-memory-mcp@latest"]' \
  --env '{"MIDBRAIN_CLIENT": "claude", "MIDBRAIN_API_KEY": "<redacted>"}'
```

Do not approve stale pending requests that mention a pinned MidBrain version.

## Removing MidBrain Memory

Remove the MidBrain MCP server from the selected group, remove only MidBrain hook entries from `data/v2-sessions/<group-id>/.claude-shared/settings.json`, remove local key env entries, and restart with operator approval.
