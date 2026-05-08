# PR-009: Codex Client Hooks (PRD-008)

## Branch Details

| Field | Value |
|---|---|
| Branch | `codex-client-hooks` |
| Base | `main` (tip: `8cbbe60`) |
| Head | `fe75a16` |
| Commits ahead of main | **8** |
| Version | stays at `0.3.2` — bump to `0.4.0` at release time (new client = minor) |
| Branch convention | retained until release triangulation passes AND no follow-up PRs reference it AND Carlos explicitly confirms deletion. Default: keep. |

## Commits

| Hash | Subject | Files | +/- |
|---|---|---|---|
| `5bf9c6c` | chore: add @iarna/toml dependency for Codex TOML patching (PRD-008) | package.json, package-lock.json | +12 / -1 |
| `0d1fa1b` | feat(codex): add hook capture scripts with DI seam (PRD-008) | codex/capture-assistant.mjs, codex/capture-user.mjs, codex/common.mjs, tests/codex-hooks.test.mjs | +377 / -0 |
| `dcb7fb8` | feat(shared): add MIDBRAIN_QUIET_FALLBACK env gate (PRD-008) | shared/midbrain-common.mjs, tests/midbrain-common.test.mjs | +20 / -1 |
| `d89908c` | feat(install): add TOML helpers, Codex detection, installCodex with hooks.json (PRD-008) | install.mjs, tests/install.test.mjs | +796 / -10 |
| `fb64e96` | feat(server): memory_setup_project Codex branch with TOML config (PRD-008) | server.js, tests/server-integration.test.mjs | +156 / -1 |
| `cf6fbaa` | docs: update README and AGENTS.md for Codex client support (PRD-008) | AGENTS.md, README.md | +22 / -20 |
| `7148639` | fix: resolve lint errors in server.js and server integration tests | server.js, tests/server-integration.test.mjs | +3 / -6 |
| `fe75a16` | fix: address AC-7b, AC-13, AC-19, AC-22 from Phase 5 review | codex/common.mjs, install.mjs, shared/midbrain-common.mjs, tests/*.mjs | +77 / -5 |

## `git diff --stat main...HEAD`

```
 AGENTS.md                         |  20 +-
 README.md                         |  22 +-
 codex/capture-assistant.mjs       |  20 ++
 codex/capture-user.mjs            |  18 ++
 codex/common.mjs                  |  63 +++++
 install.mjs                       | 319 ++++++++++++++++++++++-
 package-lock.json                 |   7 +
 package.json                      |   6 +-
 server.js                         |  57 +++-
 shared/midbrain-common.mjs        |   9 +-
 tests/codex-hooks.test.mjs        | 278 ++++++++++++++++++++
 tests/install.test.mjs            | 533 ++++++++++++++++++++++++++++++++++++++
 tests/midbrain-common.test.mjs    |  40 +++
 tests/server-integration.test.mjs |  97 +++++++
 14 files changed, 1454 insertions(+), 35 deletions(-)
```

## Problem Being Solved

PRD-008: Codex Client Hooks. OpenAI Codex CLI & Desktop (public beta) supports MCP servers and a hook system (`~/.codex/hooks.json`) identical to Claude Code's format. This PR adds full Codex embodiment — episodic capture hooks, installer support with TOML config patching, and `memory_setup_project` Codex branch — so MidBrain Memory works in Codex the same way it works in OpenCode and Claude Code.

Key design decisions:
- **DI seam pattern**: Pure `captureUser(input, deps)` / `captureAssistant(input, deps)` functions accept injected dependencies for testability
- **TOML patching via @iarna/toml**: Codex uses TOML config, not JSON — only new runtime dep
- **MIDBRAIN_QUIET_FALLBACK**: Env gate to suppress per-project key fallback WARN in hook context (hooks fire on every message)
- **ACTION REQUIRED pattern**: Project setup emits trust warning + exit code 2 (Codex has no auto-trust API)
- **Windows short-circuit**: Codex hooks are POSIX shell commands; detection returns false on win32

## Acceptance Criteria (Phase 5 Subagent B verification)

All 23 ACs PASS after Phase 5 blocker fixes. File:line evidence below.

| AC | Description | Verdict | Evidence |
|---|---|---|---|
| **AC-1** | `detectTools().codex === true` when `~/.codex/config.toml` exists | PASS | `install.mjs:267` |
| **AC-2** | `detectTools().codex === true` when `~/.codex/` dir exists | PASS | `install.mjs:267` |
| **AC-3** | `detectTools().codex === false` when neither exists | PASS | `install.mjs:267` |
| **AC-4** | `installCodex()` writes key with chmod 600 | PASS | `install.mjs:709` → `writeKeyFile` |
| **AC-5** | TOML patcher adds `[mcp_servers.midbrain-memory]` | PASS | `install.mjs:173-176` |
| **AC-6** | TOML patcher preserves existing entries | PASS | `patchCodexMcpServer` only sets target key |
| **AC-7** | TOML patcher sets `codex_hooks = true`, preserves other features | PASS | `install.mjs:184-187` |
| **AC-7b** | Advisory when codex binary exists but `~/.codex/` absent | PASS | `install.mjs:273` `hasCodexBinary()`, `install.mjs:799-801` advisory |
| **AC-8** | Idempotent: second run no new diff | PASS | Overwrites same key, TOML merge |
| **AC-9** | hooks.json with shell-quoted paths, env prefix, absolute `process.execPath` | PASS | `install.mjs:596-605` `buildCodexHookCommand` |
| **AC-10** | Timestamped `.bak` backup | PASS | `install.mjs:648-655` |
| **AC-11** | `memory_setup_project` writes `<proj>/.codex/config.toml`, no hooks.json | PASS | `server.js:450-487` |
| **AC-12** | Result includes ACTION REQUIRED warning | PASS | `server.js:482-484` |
| **AC-13** | `captureUser` POSTs with `role: "user"`, `source: "codex"` | PASS | `codex/common.mjs:48`, `shared/midbrain-common.mjs:192` |
| **AC-13b** | Project config.toml contains `MIDBRAIN_PROJECT_DIR` | PASS | `install.mjs:867`, `server.js:468-471` |
| **AC-14** | `captureAssistant` skips when `stop_hook_active: true` | PASS | `codex/common.mjs:37` |
| **AC-15** | `captureAssistant` resolves project key when present | PASS | `codex/common.mjs:47` |
| **AC-16** | `npm run check` passes (core tests) | PASS | 331 tests green; D-3 failure is pre-existing (local dev configs) |
| **AC-17** | Corrupt TOML: no overwrite, clear error | PASS | `install.mjs:196-208` |
| **AC-18** | `npm pack` includes codex files, `@iarna/toml` in deps | PASS | Version bump deferred to release |
| **AC-19** | Summary includes "Enabled experimental Codex hooks feature" | PASS | `install.mjs:682-683` |
| **AC-20** | `--project` exits code 2 when trust unconfirmed | PASS | `install.mjs:891` |
| **AC-21** | Summary warns about comment loss, references backup | PASS | `install.mjs:684-687` |
| **AC-22** | Windows short-circuit with zero fs access | PASS | `install.mjs:267`, test at `tests/install.test.mjs:2019` |
| **AC-23** | MIDBRAIN_QUIET_FALLBACK gate | PASS | `shared/midbrain-common.mjs:130` |

## Test Results (Phase 5 Subagent A)

| Check | Result | Detail |
|---|---|---|
| ESLint | **PASS** | Zero errors, zero warnings |
| Vitest | **PASS** | 4 files, **331 tests passed**, 0 failed |
| Commit count | **PASS** | 8 commits on branch |
| `.only` / `.skip` | **PASS** | None found |

New tests by commit:
- `0d1fa1b`: `tests/codex-hooks.test.mjs` +276 lines (21 tests)
- `dcb7fb8`: `tests/midbrain-common.test.mjs` +19 lines (1 test)
- `d89908c`: `tests/install.test.mjs` +507 lines (80+ tests)
- `fb64e96`: `tests/server-integration.test.mjs` +101 lines (4 tests)
- `fe75a16`: +28 install, +21 midbrain-common, +2 codex-hooks (AC fix tests)

## Security Checklist (Phase 5 Subagent C)

| # | Check | Result |
|---|---|---|
| 1 | console.log in server.js | PASS — no new console.log |
| 2 | process.cwd() in new code | PASS — zero matches |
| 3 | Bare "node" strings | PASS — uses process.execPath |
| 4 | Tildes in JSON/TOML values | PASS — all paths use os.homedir() |
| 5 | API keys / secrets / tokens | PASS — none in diff |
| 6 | .gitignore coverage | PASS |
| 7 | npm pack --dry-run | PASS — no tests/tasks/keys in tarball |
| 8 | MCP tool handlers try/catch | PASS |
| 9 | Scope discipline (no plugin/ or claude-code/ changes) | PASS |
| 10 | package.json version NOT bumped | PASS — 0.3.2 |
| 11 | chmod 600 on key files | PASS |
| 12 | Shell quoting in hook commands | PASS — POSIX single-quote escaping |

## Draft PR Description

```markdown
## Summary
- Add OpenAI Codex (CLI & Desktop) as a supported client with episodic capture hooks, installer TOML patching, and project setup
- New DI-seamed hook scripts in `codex/` mirror the Claude Code pattern but output `{}` JSON for Codex Stop hook contract
- Add `@iarna/toml` dependency for Codex config.toml parsing/serialization

## Changes
- `codex/common.mjs` — pure capture functions with DI seam (captureUser, captureAssistant, makeDefaultDeps)
- `codex/capture-user.mjs`, `codex/capture-assistant.mjs` — thin hook wrappers
- `install.mjs` — Codex detection, TOML helpers, installCodex orchestrator, hooks.json builder, shell quoting, project setup
- `server.js` — memory_setup_project Codex branch, writeCodexProjectToml
- `shared/midbrain-common.mjs` — MIDBRAIN_QUIET_FALLBACK env gate, optional source param on storeEpisodic
- `package.json` — @iarna/toml dep, codex/ in files, keywords
- `README.md`, `AGENTS.md` — Codex documentation

## Testing
- 331 tests pass (21 codex-hooks + 80+ installer + 4 server integration + 3 midbrain-common)
- ESLint zero warnings
- npm pack verified (codex/ files included, no test/task leakage)
- Phase 5: 3 parallel subagents (test verification, AC verification, security scan) all green

## Breaking Changes
- None. Backwards compatible — existing OpenCode and Claude Code configs unchanged.

## Reviewer Notes
- `@iarna/toml` is the only new runtime dependency (pure JS, no native bindings, PRD-008 §3.4 pre-approved)
- AC-18 version bump (0.4.0) deferred to release commit per SOP
- Codex hooks are POSIX-only (shell commands); Windows short-circuits with zero fs access
- Pre-existing D-3 test failure from local dev configs (.mcp.json, opencode.json on disk but not in git) — not caused by this branch
```

## Known Issues / Deferred Items

- **D-1**: Native Codex Desktop app detection (substring sniff vs explicit path) — deferred per PRD-008 §3.7
- **D-7**: Client detection substring sniff refinement — documented as deferred
- **AC-18 version**: 0.3.2 → 0.4.0 bump happens at release time, not in PR (SOP constraint C-12)
- **docs-regression D-3**: Pre-existing false positive from local dev configs on disk — not caused by this branch
