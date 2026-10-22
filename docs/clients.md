# Supported Clients

This page tracks each client MidBrain supports, what it gets, and the gaps
that are still open. The [README](../README.md) has the setup and
troubleshooting details for each client. Update this page in the same change
that adds or removes a client capability.

Last reviewed: 2026-10-16 (v0.4.10, plus PR #98).

## Capability matrix

| Client | Memory tools (MCP) | Prompt capture | Reply capture | Tool summary | Reasoning summary | Persona and profile | PK injection (opt-in) | Auto-repair |
|---|---|---|---|---|---|---|---|---|
| Claude Code | Yes | Yes (`UserPromptSubmit`) | Yes (`Stop`) | No | No | Yes: `SessionStart` context | Yes | Yes: hook entries and `claude-hook` shim |
| Codex | Yes | Yes (`UserPromptSubmit`) | Yes (`Stop`) | Yes (`PostToolUse`) | Yes, when Codex writes plaintext summaries | Yes: `SessionStart` context | Yes | Yes: hook entries and `codex-hook` shim |
| OpenCode | Yes | Yes (`chat.message`) | Yes (`message.updated`) | No | No | Yes: system prompt, once per session | Yes | Yes: plugin bundle copy |
| Cursor | Yes | Yes (`beforeSubmitPrompt`; headless from the session transcript) | Yes (`afterAgentResponse`) | Yes (`postToolUse`) | No | Yes: MCP server instructions | No | Yes: hook entries and `cursor-hook` shim |
| Hermes Agent | Yes | Yes (`pre_llm_call`) | Yes (`post_llm_call`) | No | No | Yes: first turn of the session | Yes | Yes: hook entries and `hermes-hook` shim |
| OpenClaw | Yes | Yes (`agent_end`) | Yes (`agent_end`) | No | No | Yes: `appendSystemContext`, once per session | No | Yes: plugin file copy |
| Prime Agent | Yes, from the Python REPL | Yes (skill watcher) | Yes (skill watcher) | Yes (skill watcher) | No | **No** (see [open gaps](#open-gaps)) | No | Yes: skill files and `prime-agent-hook` shim |
| NanoClaw, Claude provider | Yes | Yes (Claude Code hooks) | Yes (Claude Code hooks) | No | No | Yes: `SessionStart` context | Yes | Yes |
| NanoClaw, other providers | **No**: the MCP server fails to start (#104) | Through that provider's hooks, labeled with the provider's name | Same | Same | Same | Codex provider: yes, when the `SessionStart` hook is installed | — | **No** (#104) |

"PK injection" is the legacy procedural-knowledge injection. It is off unless
`MIDBRAIN_ENABLE_PK_INJECTION=1` is set.

## Rules and project setup

| Client | Global rules file | `install --project` |
|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md` | Project MCP entry and `CLAUDE.md` block |
| Codex | `~/.codex/AGENTS.md` | Project MCP entry and `AGENTS.md` block |
| OpenCode | `~/.config/opencode/AGENTS.md` | Project MCP entry and `AGENTS.md` block |
| Cursor | None (paste the block into Cursor Settings -> Rules) | `<project>/.cursor/mcp.json` and `AGENTS.md` block; hooks stay global |
| Hermes Agent | Active `SOUL.md` | MCP entry with `${TERMINAL_CWD}`; hooks stay global |
| OpenClaw | Default workspace `AGENTS.md`, only when OpenClaw created it | Nothing: OpenClaw has no project config |
| Prime Agent | `~/.prime/agent/AGENTS.md` | Optional `<project>/.prime/agent/settings.json` |
| NanoClaw | `container/CLAUDE.md` and each group's `CLAUDE.local.md` | Through the `/add-midbrain` skill, per group |

## Validated surfaces

| Client | Surface | Last live check |
|---|---|---|
| Cursor | Desktop app, CLI interactive, CLI headless (`agent -p`) | 2026-10-09 (headless), 2026-10-16 (persona and profile, CLI) |
| OpenClaw | Local agent runs and gateway-served runs | 2026-10-02 (capture), 2026-10-16 (persona and profile) |
| Prime Agent | Headless, TUI, RPC, background, forked sessions | 2026-10-13 (Prime Agent 0.10.0) |
| Claude Code, Codex, OpenCode, Hermes | CLI | 2026-10-16 (persona and profile, PR #98) |
| NanoClaw | Codex-provider group, after a manual hook repair | 2026-10-16 (persona and profile, PR #98) |

## Open gaps

| Gap | Client | Blocked by | Tracking |
|---|---|---|---|
| MCP server fails to start in non-Claude provider groups; no self-repair there | NanoClaw | MidBrain | #104 |
| Persona and profile are not added | Prime Agent | Upstream: no hook can add session context. The proposed `SessionStart` hook rejects context output | PrimeIntellect-ai/prime-agent#3642, discussion #3200 |
| Capture uses a log watcher, not hooks | Prime Agent | Upstream: no lifecycle hooks in 0.10 | PrimeIntellect-ai/prime-agent#3642 |
| PK injection is not available | Cursor, OpenClaw, Prime Agent | Client: no prompt-time context surface | — |
| Codex hooks need one approval in `/hooks` before they run | Codex | Client: hook trust | — |
| Tool calls and reasoning are not captured | OpenClaw | MidBrain: `agent_end` capture stores prompt and reply only | — |
| Global rules are not installed | Cursor | Client: no file-based global rules | — |
| Persona and profile changes apply after the MCP server restarts | Cursor | Client: MCP instructions are read when the server starts | — |
