# MidBrain Memory MCP

Persistent experience for long running agents. An MCP server that gives agents
long-term memory through semantic search, episodic recall, and automatic capture
that consolidates into procedural knowledge over time.

Works with [OpenCode](https://opencode.ai),
[Claude Code](https://docs.anthropic.com/en/docs/claude-code),
[OpenAI Codex](https://developers.openai.com/codex), and
[Hermes Agent](https://github.com/NousResearch/hermes-agent), plus
[NanoClaw](https://nanoclaw.dev) via the bundled `/add-midbrain` skill.

[![npm version](https://img.shields.io/npm/v/midbrain-memory-mcp.svg?style=flat-square)](https://www.npmjs.com/package/midbrain-memory-mcp)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-brightgreen?style=flat-square)](#prerequisites)

---

## Quick Start

### 1. Sign in

Sign up or sign in at [memory.midbrain.ai](https://memory.midbrain.ai).

### 2. Install

```bash
npx midbrain-memory-mcp install
```

The installer detects OpenCode, Claude Code, Codex, Hermes Agent, and/or
NanoClaw on your
machine, opens browser-based authentication, creates or selects a memory agent,
writes key files (chmod 600), patches MCP configs, copies hook/plugin/skill
files, and adds a bounded MidBrain rules block to project instruction files
when project setup is used. One command, done.

If browser authentication is unavailable, use the manual fallback and paste an
existing API key when prompted:

```sh
npx midbrain-memory-mcp install --no-login
```

### 3. Restart and verify

Restart OpenCode, Claude Code, or Codex. The `memory_search` tool should be
available. Send a few messages, then search; your messages should appear.

```sh
# Quick version check (optional)
npx -y midbrain-memory-mcp@latest --version
```

---

## How It Works

```
OpenCode / Claude Code / Codex session
  |
  |-- MCP stdio -----> index.js -------> memory.midbrain.ai
  |                    (search, browse)    /api/v1/memories/search
  |
  |-- Hooks ----------> capture hooks --> memory.midbrain.ai
                       (auto-capture)     /api/v1/memories/episodic
```

**Search**: The LLM calls `memory_search` via MCP. The server queries the
API and returns scored results as formatted text.

**Capture**: Companion hooks POST conversation events to the episodic
endpoint. OpenCode submits capture without awaiting the API response. Claude
Code and Codex hooks complete capture and any required stdout before their
throttled self-update check; that check may delay hook exit by up to
`UPDATE_FETCH_TIMEOUT_MS`. Capture and update failures are non-fatal. OpenCode
uses a Bun/TS plugin; Claude Code and Codex use standalone Node scripts wired
to their hook systems. Codex captures prompts, assistant messages, plaintext
reasoning summaries when available, and bounded per-turn tool summaries.
Codex assistant capture stores the clean assistant answer separately from one
bounded reasoning/commentary summary, so interim commentary does not create
many standalone memories.

**Procedural knowledge**: Automatic procedural-knowledge injection is disabled
by default in v0.4.3 while the experience layer is redesigned. Hooks do not
call `/api/v1/memories/search/procedural` or prepend procedural context unless
`MIDBRAIN_ENABLE_PK_INJECTION=1` is explicitly set in the hook environment.
There is no manual MCP tool for procedural knowledge; agents should use the
normal memory tools for explicit recall.

Over time, captured memory can consolidate into procedural knowledge: the
experience layer that helps agents adapt how they work, not just recall what
happened.

When the legacy opt-in path is enabled, injected PK context is capped at
160 characters per title, 2,000 characters per entry body, and 6,000 characters
total. Marker-like text in PK is escaped, and trusted injected blocks include
`ctx-meta nonce` metadata plus a signature over the PK ids so user-authored
marker examples cannot spoof deduplication or strip prompt text.

**Project Setup**: The LLM calls `memory_setup_project` via MCP to scope
memory to a specific project, then tells the user to restart.

### MCP Tools

| Tool | Purpose |
|---|---|
| `memory_search` | Semantic search across all memories |
| `grep` | Exact pattern matching (names, IDs, code, URLs) |
| `get_episodic_memories_by_date` | Conversation history by date range |
| `list_files` | Browse semantic memory documents |
| `read_file` | Read a semantic memory document by line range |
| `check_session_status` | Check for recent activity from other clients/sessions |
| `memory_setup_project` | Configure per-project memory scoping |

---

## Memory Setup

MidBrain supports two useful memory scopes:

- **Global memory** is the default. It is good for your general working context:
  preferences, common workflows, recurring collaborators, and things you want
  available across clients and projects.
- **Per-project memory** is an override for one repository or workspace. It is
  good when a project needs its own isolated history, decisions, terminology,
  or security boundary.

Most people start with global setup. That gives OpenCode, Claude Code, Codex,
and other configured clients one shared memory agent for day-to-day work.

Use per-project setup when the project itself should have a separate memory
agent. For example, you might use your global MidBrain key for general coding,
but create a new MidBrain agent/key for a client repo. When that repo has
`<project>/.midbrain/.midbrain-key`, MidBrain uses the project key there and
falls back to your global key everywhere else.

In practice:

- Working in random scratch projects -> global memory is used.
- Working inside `/work/acme-mobile` after project setup -> the Acme project
  memory is used.
- Leaving `/work/acme-mobile` -> your normal global memory is used again.

This lets broad personal context and project-specific context coexist without
mixing every project's conversation history into one memory space.

### Global Memory

Run the normal installer once to configure global memory:

```sh
npx midbrain-memory-mcp install
```

This is the right default for most users. It gives your configured clients one
shared memory agent unless a project overrides it.

### Per-Project Memory

Use this when a repo needs its own isolated memory agent.

#### Option A: CLI (recommended)

```sh
# 1. Place your project API key
mkdir -p .midbrain
echo "your-project-api-key" > .midbrain/.midbrain-key
chmod 600 .midbrain/.midbrain-key

# 2. Run project setup
npx midbrain-memory-mcp install --project /absolute/path/to/project
```

Non-interactive. Resolves the API key from existing files, creates per-client
MCP configs, writes the MidBrain rules block to `AGENTS.md` and `CLAUDE.md`,
and outputs JSON to stdout. All progress goes to stderr.

Project setup never clobbers existing instructions. It appends or replaces only
the sentinel-bounded MidBrain block:

```html
<!-- midbrain-memory-rules:start -->
...
<!-- midbrain-memory-rules:end -->
```

To manage project instruction files yourself, opt out:

```sh
npx midbrain-memory-mcp install --project /absolute/path/to/project --no-rules
```

#### Option B: MCP Tool

> **Warning:** Never paste your API key into a chat prompt. Place the key
> in a file first (step 1 above), then ask the assistant to configure the
> project.

**OpenCode:**
```
Set up midbrain memory for this project
```

**Claude Code / Codex** (name the tool if your client lazy-loads tools):
```
Use the memory_setup_project tool to configure this project
```

Restart after setup for the project memory to take effect.

The MCP setup tool configures keys and MCP client files only. It does not write
`AGENTS.md` or `CLAUDE.md`; rule injection through the MCP tool is deferred.

#### Option C: Manual

See [Configuration Reference](#configuration-reference) below for the
full config format. Create the key file, add a project-level MCP config
with `MIDBRAIN_PROJECT_DIR`, and restart.

---

## Auto-Update

The installer writes `npx -y midbrain-memory-mcp@latest` as the MCP
command. `@latest` re-resolves the newest published version only when npx has
no warm cache for that spec. Once npx has populated its `_npx/<hash>` cache with
a version that satisfies the recorded semver range, it reuses that cached
install and does **not** re-contact the registry — so `@latest` alone freezes at
whatever version was current when the cache was first populated.

To make updates actually propagate, MidBrain self-heals the npx cache: on
startup (and from capture hooks), it uses a best-effort cache to check the npm
registry at most once per 24h when that cache state can be persisted. When the
running version is older than `latest`, it removes its own `_npx/<hash>` cache
directory. The next cold start finds no cache, re-resolves `@latest`, and
installs the newer version. Before deletion, the check parses the
target package metadata and requires the exact `midbrain-memory-mcp` package
name. Startup begins this best-effort work only after the MCP server connects.
Capture hooks finish capture and any required stdout first; hook exit may then
wait up to `UPDATE_FETCH_TIMEOUT_MS` for the throttled registry check. Registry,
cache, and deletion failures are non-fatal.

POSIX paths and normal drive-letter Windows npm caches are supported. Custom
UNC-configured Windows caches may not self-heal; the package check normally
fails closed, leaving the cache untouched.

| Spec form | Behavior |
|---|---|
| `midbrain-memory-mcp@latest` | Self-healing auto-update via cache clear (recommended) |
| `midbrain-memory-mcp@X.Y.Z` | Pinned. You are responsible for bumping |
| `midbrain-memory-mcp` (bare) | Looks auto-updating but is sticky on first resolved version. Avoid |

**Already-stuck clients:** a client running a version *older* than the release
that introduced self-healing cannot self-heal (its code predates the fix). Clear
the npx cache once manually, then it re-resolves `@latest` and stays current
automatically:

```bash
npx clear-npx-cache
# or delete the _npx dir directly:
#   macOS/Linux: rm -rf "$(npm config get cache)/_npx"
#   PowerShell:  Remove-Item -Recurse -Force "$(npm config get cache)\_npx"
```

Manual `_npx` clearing also removes cached installs for other npx tools; each
tool downloads again on its next cold start.

### Automatic Hook & Plugin Repair

When the MCP server starts, it detects whether installed hooks and plugin
files match the canonical stable targets. If they are stale (e.g., legacy
direct script paths, an old npx cache hash, or a missing shim), they are
automatically repaired. No manual `install` needed. This covers:

- **Claude Code:** Rewrites MidBrain hook entries in
  `~/.claude/settings.json` to call the stable
  `~/.midbrain/bin/claude-hook` shim (user hooks you added yourself are
  preserved)
- **Codex:** Installs a stable `~/.midbrain/bin/codex-hook` shim and
  rewrites MidBrain hook entries in `~/.codex/hooks.json` to call that shim
- **Hermes:** Same pattern via `~/.midbrain/bin/hermes-hook`
- **OpenCode:** Re-copies the plugin bundle to `~/.config/opencode/plugins/`

Repair only ever writes canonical, location-independent values (the stable
shims and `npx -y midbrain-memory-mcp@latest`) — never the running
instance's own path. Writes are content-compared: an already-canonical
config is left completely untouched (no mtime churn, so Hermes hook
approvals survive).

Repair is **cross-client by design**: starting MidBrain from any one client
converges every detected client's midbrain-owned state to the same canonical
values. It changes only positively owned MidBrain state — hook commands are
matched by the exact stable-shim path or positively identified legacy forms,
so your own hooks (even near-names like `claude-hook-wrapper` or your own
`capture-user.mjs`) and every other user-owned file are never touched.
Shim freshness checks the actual file, not mere existence: the body must be
canonical (or dev-marked) and executable, and repair restores both without
mtime churn.

Repair is also **context-gated**: a server launched from a temp directory,
a git worktree, or CI skips repair entirely and prints one stderr line
(`[midbrain] self-repair skipped: running from <kind> (<path>); ...`). This
prevents throwaway checkouts from ever writing themselves into your
permanent client configs. npx-cache launches are the canonical install mode
and still self-repair — deliberately, the `_npx` classification outranks the
tmp and CI rules, because a relocated npm cache or a CI job running the
published package is still a canonical launch. Entries, shims, and OpenCode
plugin copies written by `install --dev` carry dev markers and are never
reverted by automatic repair; run a plain `install` to restore canonical.

Repair happens silently on startup (fire-and-forget, never blocks). If
something goes wrong, the server continues normally. Repair failures are
logged to stderr but never crash the process.

Codex has an extra trust step: it trusts command hooks by their command
definition. v0.4.2 migrates MidBrain's Codex hooks to the stable shim above, so
you may need to approve MidBrain once in Codex with `/hooks`. After that,
normal MidBrain package updates, npm cache changes, and Homebrew Node updates
should not change the trusted hook command.

Run `npx -y midbrain-memory-mcp@latest --version` to check your resolved
version. The MCP server logs the resolved package version to stderr on startup.

---

## Configuration Reference

### Environment Variables

| Variable | Purpose | Set by |
|---|---|---|
| `MIDBRAIN_CLIENT` | Which client adapter to use (`opencode`, `claude`, `codex`, or `nanoclaw`) | MCP config `environment`/`env` block |
| `MIDBRAIN_PROJECT_DIR` | Project dir for per-project key resolution | Project-level MCP config |
| `MIDBRAIN_API_KEY` | API key for CI/debug environments | User environment |

### API Key Resolution

Keys are stored in files with `chmod 600`. The full resolution chain is
owned by `BaseClient.resolveKey()` in `shared/clients/base.mjs`. All
components: MCP server, OpenCode plugin, Claude Code hooks, and Codex hooks
obtain their key through `MidbrainApi.create(getClient(id), projectDir)`.
Never read key files directly or implement resolution manually.

Resolution order:

| # | Location | Notes |
|---|---|---|
| 1a | `<projectDir>/.midbrain/.midbrain-key` | Per-project (recommended) |
| 1b | `<projectDir>/.midbrain-key` | Per-project (flat override) |
| 2a | `$MIDBRAIN_PROJECT_DIR/.midbrain/.midbrain-key` | Per-project via env |
| 2b | `$MIDBRAIN_PROJECT_DIR/.midbrain-key` | Per-project via env (flat) |
| 3 | Client key file (e.g. `~/.config/opencode/.midbrain-key`) | Per-client adapter |
| 4 | `~/.config/midbrain/.midbrain-key` | Global default |
| 5 | `$MIDBRAIN_API_KEY` | Environment variable (CI only) |

- `EACCES` on any key file is a hard error (not silent fallthrough)
- Empty key files are a hard error naming the file path
- Fallthrough from project to global key emits a warning to stderr

By default the installer writes a single global key at
`~/.config/midbrain/.midbrain-key` and relies on the resolution chain above —
it does **not** duplicate that key into each client's config directory. When two
or more clients are detected, the interactive installer asks whether to share
one key across all of them. Answer no to enter a distinct key per client; those
keys are written to the per-client locations (row 3) and take priority over the
global key. Distinct per-client keys already present on disk are preserved.
Non-interactive installs always use the single shared (global) key.

### MCP Config Examples

**OpenCode**: `~/.config/opencode/opencode.json` (global) or
`<project>/opencode.json` (per-project):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "midbrain-memory": {
      "type": "local",
      "command": ["npx", "-y", "midbrain-memory-mcp@latest"],
      "environment": {
        "MIDBRAIN_CLIENT": "opencode"
      },
      "enabled": true
    }
  }
}
```

**Claude Code**: `~/.claude.json` (global) or `<project>/.mcp.json`
(per-project):

```json
{
  "mcpServers": {
    "midbrain-memory": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "midbrain-memory-mcp@latest"],
      "env": {
        "MIDBRAIN_CLIENT": "claude"
      }
    }
  }
}
```

Claude Code global install also writes `UserPromptSubmit` and `Stop` capture
hooks into `~/.claude/settings.json`. The hooks call a stable local shim
(30-second timeout; the `Stop` hook is async):

```text
~/.midbrain/bin/claude-hook user
~/.midbrain/bin/claude-hook assistant
```

The shim resolves `npx -y midbrain-memory-mcp@latest hook claude <role>`, so
the hook command in `settings.json` stays stable across package updates, npm
cache cleans, and Node upgrades.

**Codex**: `~/.codex/config.toml` (global) or
`<project>/.codex/config.toml` (per-project):

```toml
[mcp_servers.midbrain-memory]
command = "npx"
args = ["-y", "midbrain-memory-mcp@latest"]

[mcp_servers.midbrain-memory.env]
MIDBRAIN_CLIENT = "codex"
```

Codex global install also writes `~/.codex/hooks.json` with
`UserPromptSubmit`, `PostToolUse`, and `Stop` capture hooks. Project setup
writes only `.codex/config.toml`; it does not write project-local hooks to
avoid duplicate captures from multiple matching hook layers. Use `/hooks` in
Codex to review and trust hook changes if prompted.

Codex hooks call a stable local shim:

```text
~/.midbrain/bin/codex-hook user
~/.midbrain/bin/codex-hook tool
~/.midbrain/bin/codex-hook assistant
```

The shim resolves `midbrain-memory-mcp@latest` internally. This keeps
`~/.codex/hooks.json` stable across package and Node updates, avoiding repeated
Codex hook re-approval for normal updates. The tradeoff is explicit: approving
the shim means you trust MidBrain's auto-updating package command, not one
specific npm cache file.

Codex may invoke `Stop` more than once during a turn. MidBrain buffers
commentary/reasoning-only stops and stores them only when the final assistant
answer appears: one clean assistant answer, one reasoning/commentary summary,
and one separate tool activity summary when tools ran.

For per-project configs, add `"MIDBRAIN_PROJECT_DIR": "/absolute/path/to/project"`
to the JSON environment/env block or `MIDBRAIN_PROJECT_DIR = "/absolute/path/to/project"`
to the Codex TOML env table.

**Hermes Agent**: the active Hermes config (`~/.hermes/config.yaml` by
default, or `$HERMES_HOME/config.yaml`):

```yaml
mcp_servers:
  midbrain-memory:
    command: npx
    args: ["-y", "midbrain-memory-mcp@latest"]
    env:
      MIDBRAIN_CLIENT: hermes
      MIDBRAIN_PROJECT_DIR: "${TERMINAL_CWD}"
hooks:
  pre_llm_call:
    - command: "~/.midbrain/bin/hermes-hook user"
      timeout: 30
  post_llm_call:
    - command: "~/.midbrain/bin/hermes-hook assistant"
      timeout: 30
```

Hermes stores config in YAML and exposes both an `mcp_servers` map (for
`memory_search` and the other tools) and a `hooks` map (for episodic capture).
MidBrain wires the MCP entry for search and adds two shell hooks for capture:
`pre_llm_call` records the user prompt and `post_llm_call` records the
assistant's response. These fire in both the Hermes CLI and gateway.

Hermes hooks call a stable local shim, exactly like Codex:

```text
~/.midbrain/bin/hermes-hook user
~/.midbrain/bin/hermes-hook assistant
```

The shim resolves `midbrain-memory-mcp@latest` internally, keeping the hook
command in `config.yaml` stable across package and Node updates. Hermes prompts
once per `(event, command)` pair to approve a shell hook and remembers the
decision; for non-interactive use (gateway, CI) approve on first run or set
`hooks_auto_accept: true` in `config.yaml` (or `HERMES_ACCEPT_HOOKS=1`). The
installer does not flip that global toggle for you — it is security-sensitive
and stays under your control. Project setup writes only the `mcp_servers` entry
to the active Hermes config and uses Hermes' `${TERMINAL_CWD}` expansion for
project key scoping; capture hooks remain global. It does not create an inactive
`<project>/.hermes/config.yaml`. If a Hermes gateway is already running, restart
that gateway after setup so it reloads the MCP configuration. The YAML editor
preserves comments and key order on untouched nodes and fails closed on
unparseable config.

The YAML config is edited through the `yaml` document API, mirroring how the
Codex adapter uses `smol-toml`. The parser is lazily imported and marked
`--external` in the OpenCode plugin bundle so it never bloats the runtime.

**Important:**
- All paths must be absolute. JSON does not expand `~`.
- OpenCode uses `mcp`. Claude Code uses `mcpServers`. Codex uses
  `[mcp_servers.<id>]` TOML tables. Wrong key = silent failure.
- MCP servers in `~/.claude/settings.json` are silently ignored. Use `~/.claude.json`.

### Logging

Capture hooks and plugins write debug logs to a platform-appropriate
directory (not your home directory):

| Platform | Log directory |
|---|---|
| Linux/other | `$XDG_STATE_HOME/midbrain` or `~/.local/state/midbrain` |
| macOS | `~/Library/Logs/midbrain` |
| Windows | `%LOCALAPPDATA%\midbrain\logs` |

Per-client files: `midbrain-opencode.log`, `midbrain-claude.log`,
`midbrain-codex.log`.

- Logs default to the `info` level. Per-request detail (individual REST
  calls, payload sizes) is logged at `debug` and suppressed by default.
- Set `MIDBRAIN_LOG_LEVEL=debug` in the hook/plugin environment for verbose
  output, or `MIDBRAIN_LOG_LEVEL=error` to keep only failures. Valid values:
  `error`, `warn`, `info`, `debug`.
- Logs rotate to `<file>.1` once they exceed 5 MiB (override with
  `MIDBRAIN_LOG_MAX_SIZE`, in bytes). Only one rotated generation is kept.
- Override the log directory entirely with `MIDBRAIN_LOG_DIR`.

### NanoClaw

NanoClaw runs Claude Code inside Docker containers. MidBrain integrates via
NanoClaw's skill system. The installer copies a `/add-midbrain` skill that
handles group-scoped setup.

**Install the skill:**

```bash
npx -y midbrain-memory-mcp@latest install
# Detects NanoClaw and copies the skill to .claude/skills/add-midbrain/
```

**Run the skill (from the NanoClaw directory):**

```bash
claude
# Then type: /add-midbrain
```

The skill instructs Claude Code to:
1. Prompt for your MidBrain API key
2. Ask you to choose the target group when multiple agent groups exist
3. Wire the MCP server for that group with `npx -y midbrain-memory-mcp@latest`
4. Directly merge Claude capture hooks into
   `data/v2-sessions/<group-id>/.claude-shared/settings.json`
5. Use `npx -y midbrain-memory-mcp@latest hook claude user` and
   `npx -y midbrain-memory-mcp@latest hook claude assistant` for capture hooks,
   so hooks re-resolve through the published package instead of a pinned
   package-store path
6. Preserve existing settings and hooks, redact inline hook keys in output,
   and restart only after approval

After the skill completes, agents have full memory search and automatic
episodic capture. Memory persists server-side across container restarts.

**Manual setup (alternative):**

```bash
# Wire MCP server (persistent, survives restarts)
bash bin/ncl groups config add-mcp-server \
  --id <agent-group-id> \
  --name midbrain-memory \
  --command npx \
  --args '["-y", "midbrain-memory-mcp@latest"]' \
  --env '{"MIDBRAIN_CLIENT":"claude","MIDBRAIN_API_KEY":""}'

# Restart to apply
bash bin/ncl groups restart --id <agent-group-id> --message "Added midbrain memory"
```

Note: Manual `add-mcp-server` gives MCP tools only (search, browse). Episodic
capture requires the direct `.claude-shared/settings.json` settings merge
performed by the skill. Those hooks should use the `npx @latest hook` commands
above, not `/pnpm/.../midbrain-memory-mcp@<version>/...` paths.

---

## Memory-First Agent Rules

Project CLI setup writes this block automatically to `AGENTS.md` and
`CLAUDE.md`, unless `--no-rules` is used. Existing content is preserved and
only the sentinel-bounded MidBrain block is updated on later runs.

If you manage rules manually, use this distilled block:

```markdown
## MidBrain Memory Rules
- Use memory_search at session start to load relevant context
- Use check_session_status at session start to detect recent activity from
  other sessions or clients. If it reports recent activity, use
  get_episodic_memories_by_date to fetch full context.
- Use grep for exact pattern matches (names, IDs, code, URLs)
- Use list_files and read_file to browse semantic memory documents
- Use get_episodic_memories_by_date for conversation history by date
- When the user asks to "continue", "pick up where we left off", or similar,
  use get_episodic_memories_by_date with today's date to retrieve recent context.
- If a tool response includes a recency hint about newer episodic memories on
  the server, consider fetching them with get_episodic_memories_by_date if
  relevant to the user's current intent.
- NEVER create semantic memories. Semantic is managed by dream consolidation.
- NEVER create episodic memories. Episodic capture is automatic.
- Procedural knowledge is not injected automatically. Use explicit memory tools
  for recall; do not call or expect a manual procedural knowledge MCP tool.
  Legacy PK injection only runs when `MIDBRAIN_ENABLE_PK_INJECTION=1` is set.
  Injected PK blocks include `ctx-meta nonce` trust metadata plus an id
  signature, and are capped at 160 title characters, 2,000 content characters
  per entry, and 6,000 characters total.
- The memory tools are memory_search, grep, get_episodic_memories_by_date,
  list_files, read_file, check_session_status, and memory_setup_project. Use
  them proactively.
- When the user asks to set up MidBrain memory for a project, ALWAYS use the
  memory_setup_project tool. NEVER manually create key files or configs.
```

---

## Troubleshooting

### Version check

```sh
npx -y midbrain-memory-mcp@latest --version
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
- `MIDBRAIN_CLIENT` not set or set to wrong value (`opencode`, `claude`, or `codex`)
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
Auth: send an `Authorization` header with your local API key, except for
`/health`.

| Method | Endpoint | Params / Body | Returns |
|---|---|---|---|
| GET | `/api/v1/memories/search/semantic` | `?query=...&limit=10` | `[{role, text, score, occurred_at}]` |
| GET | `/api/v1/memories/search/lexical` | `?pattern=...&source=...&limit=50` | `[{source, line_number, text}]` |
| GET | `/api/v1/memories/episodic` | `?page=1&limit=100&start_date=...&end_date=...` | `{items, total, page, limit}` |
| GET | `/api/v1/memories/semantic/files` | -- | `[{source, chunk_count}]` |
| GET | `/api/v1/memories/semantic/files/{path}` | `?start_line=1&num_lines=200` | `{path, start_line, content}` |
| GET | `/api/v1/memories/search/procedural` | `?query=...&limit=5&min_score=0.5&exclude_ids=...` | `[{id, title, content, source_ids, score}]` |
| POST | `/api/v1/memories/episodic` | `{"text": "...", "role": "user\|assistant", "memory_metadata": {"client": "opencode"}}` | Created memory |
| GET | `/health` | -- | `{"status": "ok"}` |

`memory_metadata` on POST is optional. Values must be strings. Capture hooks
tag each memory with the originating client (`opencode`, `claude`, or `codex`).

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

This writes absolute paths into configs instead of `npx @latest`, marks each
MCP entry with `MIDBRAIN_DEV: "1"`, writes dev-marked hook shim bodies, and
dev-flags the OpenCode plugin marker (your checkout's plugin bytes stay
pinned). Automatic self-repair recognizes the markers and never reverts a
dev install;
starting a server from a temp clone, worktree, or CI never overwrites them
either (self-repair is skipped there entirely). To return to the canonical
auto-updating setup, run a plain install:

```sh
npx midbrain-memory-mcp install
```

### Commands

| Command | Purpose |
|---|---|
| `npm run bootstrap` | First-time setup: deps + build + git hooks |
| `npm run build:plugin` | Bundle shared/ into dist/midbrain-shared.mjs |
| `npm test` | Full test suite (vitest) |
| `npm run test:watch` | Watch mode |
| `npm run lint` | ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run check` | Build + lint + tests + doc-regression checks |

### Pre-commit hook

Every `git commit` runs lint-staged (ESLint, zero warnings) and the full
test suite. Commit is rejected if either fails.

### Architecture

```
index.js                       MCP server (Node 20, plain JS, stdio)
mcp.mjs                        MCP tool definitions (createServer factory)
install.mjs                    Installer CLI + --project mode + auto-repair
shared/
  midbrain-api.mjs             MidbrainApi class: ALL API calls go here
  logger.mjs                   makeLogger(), logFile(), logDir()
  plugin-entry.mjs             esbuild bundle entry point
  clients/
    utils.mjs                  Shared constants + utilities (deduplication)
    base.mjs                   BaseClient: owns the full key resolution chain
    opencode.mjs               OpenCode adapter (JSONC config, plugin copy)
    claude.mjs                 Claude Code adapter (hooks, .mcp.json)
    codex.mjs                  Codex adapter (TOML config, hooks.json)
    generic.mjs                Fallback adapter
    registry.mjs               getClient(id), detectClients()
plugins/
  opencode/
    midbrain-memory.ts         OpenCode plugin (Bun/TS, episodic capture)
    midbrain-shared.mjs        Dev shim (re-exports from ../../shared/)
  claude-code/                 Claude Code hook scripts (Node 20, episodic capture)
  codex/                       Codex hook scripts (Node 20, episodic capture)
dist/
  midbrain-shared.mjs          Built bundle (all of shared/ in one file)
scripts/                       CI guards (pinned-spec regression)
tests/                         vitest (unit, integration, installer, doc-regression)
```

**The shared client layer is the single source of truth** for key
resolution and API access. Every component, including MCP server tools, the
OpenCode plugin, Claude Code hooks, and Codex hooks, must call
`MidbrainApi.create(getClient(id), projectDir)`. Direct `fs.readFile`
calls for key files or manual env var checks are forbidden.

**Plugin bundling:** The OpenCode plugin imports from `./midbrain-shared.mjs`.
In development, this resolves to a 5-line re-export shim. At install time,
the esbuild bundle (`dist/midbrain-shared.mjs`) is copied in its place.
Only 2 files are ever copied to `~/.config/opencode/plugins/` regardless of
how many modules exist in `shared/`.

### Adding a Client

New client support should be added through the shared adapter layer, not by
branching inside MCP tools or hook scripts.

1. **Create an adapter.** Add `shared/clients/<client>.mjs` extending
   `BaseClient`. Implement `id`, `displayName`, `isInstalled()`,
   `resolveClientKey()`, `writeKey()`, `installGlobal()`, `installProject()`,
   and `projectConfigFiles()`.
2. **Register it.** Import and instantiate the adapter in
   `shared/clients/registry.mjs`. The installer and MCP server should continue
   to call `getClient(id)`, `detectClients()`, and `allClients()` rather than
   introducing ad hoc client branches.
3. **Use shared key resolution.** Do not read `.midbrain-key` files directly and
   do not manually fall back through environment variables. Key resolution
   belongs in `BaseClient.resolveKey()`. Runtime code should call
   `MidbrainApi.create(getClient('<client>'), projectDir)`.
4. **Write configs idempotently.** Global install should wire the client MCP
   server and capture hooks/plugins. Project install should write only the
   project-scoped config files needed for `MIDBRAIN_PROJECT_DIR`, preserving
   comments and existing settings when that client's format supports it.
5. **Choose a capture surface.** Use a plugin when the client exposes a runtime
   message hook (OpenCode). Use hook scripts when the client exposes lifecycle
   hooks (Claude Code, Codex). OpenCode submits capture without awaiting the
   API response. Claude Code and Codex hooks complete capture and any required
   stdout before the throttled self-update check, which may delay hook exit by
   up to `UPDATE_FETCH_TIMEOUT_MS`; capture and update failures remain
   non-fatal.
6. **Package runtime files.** Add any new plugin, hook, or skill directory to
   `package.json#files` if it is not already covered. Verify with
   `npm pack --dry-run`.
7. **Test it.** Add `tests/client-<client>.test.mjs`, installer tests for
   global/project config writes, MCP coexistence tests when setup behavior is
   touched, and hook/plugin runtime tests for stdout safety, key resolution,
   capture, and procedural-knowledge injection.
8. **Document it.** Update the client matrix, setup notes, troubleshooting, and
   this architecture section. Do not document support until installer wiring,
   runtime capture, tests, and package contents are all present.

### Dependencies

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk` | MCP protocol |
| `jsonc-parser` | JSONC parsing with comment preservation |
| `smol-toml` | Codex `config.toml` parsing and serialization |
| `yaml` | Hermes `config.yaml` parsing and serialization (comment-preserving) |
| `zod` | Schema validation |

Dev: esbuild (plugin bundler), eslint, vitest, husky, lint-staged.
Not shipped to users.

---

## Prerequisites

- Node >= 20
- [OpenCode](https://opencode.ai), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenAI Codex](https://developers.openai.com/codex), [Hermes Agent](https://github.com/NousResearch/hermes-agent), and/or [NanoClaw](https://nanoclaw.dev)
- A MidBrain account ([memory.midbrain.ai](https://memory.midbrain.ai))

## License

MIT
