# Changelog

All notable public release changes for `midbrain-memory-mcp` are tracked here.
Full release-note bodies live in `docs/releases/`.

## 0.4.5

Full notes: [docs/releases/v0.4.5.md](docs/releases/v0.4.5.md)

### Added

- Added a file-backed NDJSON cache for failed episodic memory writes.
- Added `MIDBRAIN_SIMULATE_OFFLINE=1` as a test/debug path for cache-on-failure
  behavior without making network requests.

### Fixed

- Scoped episodic cache files by API key and project so cached entries do not
  flush across accounts or workspaces.
- Added explicit processing-batch ownership so a losing concurrent flusher
  cannot delete or merge another process's claimed batch.
- Preserved interrupted `.processing` batches, survivor entries, and concurrent
  live appends across later flush attempts.

### Notes

- The MCP tool surface, install flow, API key resolution, generated configs,
  and procedural-knowledge behavior are unchanged.
- Breaking changes: None.

## 0.4.4

Full notes: [docs/releases/v0.4.4.md](docs/releases/v0.4.4.md)

### Added

- Added browser/device-code authorization for first-run global installer setup.
- Let interactive global installs create or select an agent, create an API key,
  write key files, and patch supported client configs from one command.

### Fixed

- Made `--no-login` correctly skip browser/device auth and stay on the manual
  key fallback path.
- Updated README onboarding to match the sign-in, install, restart flow.

### Notes

- Existing users with key files keep the same behavior by default.
- Manual setup remains available with `npx midbrain-memory-mcp install
  --no-login`.
- Breaking changes: None.

## 0.4.3

Full notes: [docs/releases/v0.4.3.md](docs/releases/v0.4.3.md)

### Changed

- Disabled automatic procedural-knowledge injection by default for Codex,
  Claude Code, and OpenCode hooks.
- Kept legacy PK injection helpers and runtime behavior available only behind
  explicit opt-in with `MIDBRAIN_ENABLE_PK_INJECTION=1`.
- Preserved assistant-side scrubbing for old injected PK blocks.

### Notes

- Installer-generated configs and hooks do not set the opt-in flag, so users
  get the disabled behavior automatically when upgrading.
- Explicit memory tools and episodic capture are unchanged.
- Breaking changes: None.

## 0.4.2

Full notes: [docs/releases/v0.4.2.md](docs/releases/v0.4.2.md)

### Fixed

- Stabilized Codex hook trust by routing MidBrain Codex capture through the
  local `~/.midbrain/bin/codex-hook` shim.
- Added Codex hook CLI dispatch for `hook codex user`, `hook codex tool`, and
  `hook codex assistant`.
- Migrated stale legacy/direct MidBrain Codex hook commands to stable shim
  commands.
- Preserved foreign hooks in `~/.codex/hooks.json` during MidBrain hook
  migration.
- Hardened startup repair so stale MidBrain Codex hooks are repaired without
  auto-installing capture hooks where none existed.

### Notes

- Codex users may need one `/hooks` approval after upgrading because the trusted
  command changes to `~/.midbrain/bin/codex-hook`.
- Normal MidBrain package updates, npm cache changes, and Node path changes
  should stop forcing repeated Codex hook re-approval after that migration.
- Approving the shim means trusting MidBrain's auto-updating package command
  through `midbrain-memory-mcp@latest`, not one specific npm cache file.
- Breaking changes: None.

## 0.4.1

Full notes: [docs/releases/v0.4.1.md](docs/releases/v0.4.1.md)

### Fixed

- Fixed the OpenCode plugin loader failure reported as `Plugin export is not a function`.
- Hardened OpenCode plugin repair so freshness checks compare the installed plugin and bundle contents, not only the marker file.
- Added stable NanoClaw hook dispatch commands through the published package:
  `npx -y midbrain-memory-mcp@latest hook claude user|assistant`.
- Updated NanoClaw setup docs and skill guidance to use `npx -y midbrain-memory-mcp@latest hook claude user|assistant` instead of versioned package-store hook paths.

### Notes

- Existing NanoClaw groups already pinned to `midbrain-memory-mcp@0.3.2` or `/pnpm/.../midbrain-memory-mcp@<version>/...` still need a one-time migration to `@latest`.
- Codex runtime behavior is unchanged from `0.4.0`; no Codex runtime fix was present in the `v0.4.0..HEAD` diff.
- Breaking changes: None.

## 0.4.0

Full notes: [docs/releases/v0.4.0.md](docs/releases/v0.4.0.md)

### Added

- Added supported setup paths for Codex and NanoClaw.
- Added `check_session_status` for continuity checks across recent sessions and clients.
- Added `memory_type` filtering to `memory_search`.
- Added memory-first project instruction rules for `AGENTS.md` and `CLAUDE.md`.
- Added automatic procedural knowledge injection before supported user turns.

### Changed

- Reworked client-specific setup around shared client adapters, centralized key resolution, and shared API/capture helpers.
- Hardened installer behavior, stale hook and plugin repair, project setup, and package contents.

### Notes

- No intentional breaking change was expected for existing OpenCode or Claude Code users.
