# Session Prompt: PR Review for PRD-008

## Objective

Review pull request for `codex-client-hooks` -> `main`. This PR implements PRD-008: Codex Client Hooks — adding OpenAI Codex (CLI & Desktop) as a supported client with episodic capture hooks, installer TOML patching, and `memory_setup_project` Codex branch. 14 files changed, +1454/-35 lines, 8 commits.

**PR URL:** (fill after `gh pr create`)

**Branch convention:** `codex-client-hooks` — retained until release triangulation passes (`git tag v0.4.0` = `package.json` 0.4.0 = `npm view midbrain-memory-mcp version` 0.4.0) AND no follow-up PRs reference it AND Carlos explicitly confirms deletion. Default: keep.

## First Steps

Read these files in order:

1. **`tasks/prs/pr-reviewer-profile.md`** — your operating profile for this session. Follow it exactly.
2. **`tasks/prs/PR-009-codex-client-hooks/context.md`** — branch details, 8 commits, 14 files changed (+1454/-35), 23 ACs with file:line evidence, test results (331/331), Phase 5 subagent verdicts (all green), security checklist (12/12), draft PR description, known issues.
3. **`AGENTS.md`** — project constraints (especially: no `console.log` in server.js, 40-line function cap, no `process.cwd()`, `process.execPath` not bare `"node"`, no tildes in JSON/TOML values, MCP server constraints, STRICTLY ADDITIVE to install.mjs).
4. **`tasks/PRD-008-codex-embodiment/PRD-008.md`** — the spec, especially: section 3 (implementation design), section 7 (23 acceptance criteria), section 8 (manual QA matrix), section 14 (Codex hook references).

## Execution

Follow `pr-reviewer-profile.md`. This is an **independent second review** — the PRD-008 implementation session already ran a 3-subagent Phase 5 review (findings in `context.md`). Different findings are possible and welcome — that is the point of the fresh review.

### Phase 1: Launch 4 review subagents in parallel

1. **Diff Audit** — full `git diff main...codex-client-hooks` across all 14 changed files. Check for:
   - `console.log(` calls in `server.js` — only pre-authorized lines allowed. Any NEW match = BLOCKER.
   - `process.cwd()` in NEW code (added lines only) = BLOCKER.
   - Bare `"node"` string used as command instead of `process.execPath` = BLOCKER.
   - Tildes (`~`) in JSON/TOML string values (not display strings) = BLOCKER.
   - API keys / Bearer tokens / real secrets in diff = BLOCKER.
   - Any changes to `plugin/midbrain-memory.ts` or `claude-code/*.mjs` = BLOCKER (scope discipline).
   - `package.json` version MUST still be `0.3.2` (BLOCKER if bumped).
   - Functions exceeding 40-line limit in new/modified code = NOTE.
   - MCP tool handlers wrapped in try/catch = BLOCKER if missing.
   - `@iarna/toml` is the ONLY new dependency = BLOCKER if others added.
   - Stop hook wrapper (`codex/capture-assistant.mjs`) MUST contain `process.stdout.write("{}")` = BLOCKER if missing.
   - Shell quoting in hook commands uses proper POSIX escaping = BLOCKER if raw interpolation found.

2. **Test Verification** — run `npm run check` (or at minimum `npx eslint . && npx vitest run --exclude '.claude/**'`). Report:
   - Total test count and pass/fail
   - Any `.only` or `.skip` in test files
   - New test coverage per commit
   - Known pre-existing failures (D-3 docs-regression from local dev configs; worktree race conditions)

3. **Security Scan** — per `pr-reviewer-profile.md` Subagent 3 checklist:
   - chmod 600 on key file writes
   - Shell quoting in hook commands (injection vectors)
   - npm pack --dry-run (no tests/tasks/keys in tarball)
   - .gitignore coverage
   - No `process.cwd()` in new code

4. **PR Description Review** — compare draft PR description in `context.md` against actual diff. Verify summary accuracy, completeness, and that breaking changes section is correct.

### Phase 2: Synthesis

Apply `pr-reviewer-profile.md` §Phase 2:
- Any BLOCKER → fix, re-run that subagent
- Only WARNINGs/NOTEs → proceed to Phase 3

### Phase 3: Create PR

```bash
gh pr create --title "feat: add Codex client hooks with episodic capture and installer support (PRD-008)" --body "$(cat <<'EOF'
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
EOF
)"
```

Update **PR URL** at the top of this file after creation.

### Post-Merge Release Sequence (v0.4.0)

```bash
# 1. Bump version
npm version minor -m "chore: release v%s"

# 2. Push tag
git push origin main --tags

# 3. Publish
npm publish

# 4. Verify
npx -y midbrain-memory-mcp@latest --version
# Expected: 0.4.0

# 5. Update README version references if needed
# 6. Triangulation check: git tag, package.json, npm registry all show 0.4.0
```
