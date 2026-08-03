# Changelog

All notable public release changes for `midbrain-memory-mcp` are tracked here.
Full release-note bodies live in `docs/releases/`.

## 0.4.8

Full notes: [docs/releases/v0.4.8.md](docs/releases/v0.4.8.md)

### Added

- Added a `memory_diagnostics` MCP tool for authentication and
  capture-failure visibility.
- Added an account-management keystore for storing and switching between
  multiple account credentials; capture-hook credential resolution never
  consults it.

### Changed

- Made the MCP server and capture hooks resolve the API host identically so
  self-hosted configurations cannot split across origins.

### Fixed

- Restored NanoClaw/containerized episodic capture silently broken by
  v0.4.7's hook migration: the MCP server now persists its environment API
  key to the global key file at startup — absence-only, atomic, skipped for
  self-hosted `MIDBRAIN_API_URL` configurations and when a file credential
  is already active — so environment-less hook children can authenticate.
  Broken installs self-heal on the first fresh container after updating.
- Added a validated, fail-open capture-client marker so containerized
  Claude Code captures can carry their host agent's label (the NanoClaw
  skill writes `nanoclaw`); hosts without the marker are unchanged.
- Routed every credential write through one guarded atomic writer and
  removed installer credential promotion across scopes.

### Internal

- Hardened test-suite credential isolation and sandbox containment.

## 0.4.7

Full notes: [docs/releases/v0.4.7.md](docs/releases/v0.4.7.md)

### Added

- Added first-class Hermes Agent detection, YAML MCP configuration, stable
  capture hooks, project scoping, installer support, and user/assistant
  episodic capture.
- Added proactive MidBrain memory rules for Codex, OpenCode, Claude Code,
  Hermes, and NanoClaw, including client-specific deferred-tool adapters.

### Changed

- Made automatic self-repair context-aware and canonical so temporary
  worktrees, `/private/tmp`, and npx-cache package paths cannot become durable
  client configuration.
- Moved Claude Code capture to a stable local shim and unified stable-shim,
  ownership, development-install, and no-churn repair behavior across Claude
  Code, Codex, and Hermes.
- Made global and project setup update the instruction surfaces actually used
  by detected clients while preserving custom or uncertain user hardening.

### Fixed

- Restricted hook and plugin migration to positively identified MidBrain state
  so similarly named user hooks and OpenCode plugin files survive repair.
- Made installer and repair tests independent of ambient client-path
  environment variables and expanded real-home drift detection.

### Notes

- `--no-rules` remains available for users who manage instruction files
  themselves.
- Existing marked development installs remain pinned during automatic repair;
  an explicit non-development install restores canonical state.
- Live validation found some exact-retrieval variance in noisy memory corpora;
  follow-up prompt hardening is planned. MCP loading, capture, installer
  correctness, and configuration safety are unaffected.
- Breaking changes: None.

## 0.4.6

Full notes: [docs/releases/v0.4.6.md](docs/releases/v0.4.6.md)

### Changed

- Made global installs write one shared MidBrain key by default instead of
  duplicating it into every detected client config directory.
- Replaced unconditional debug-file writes with the shared `makeLogger()`,
  `logFile()`, and `logDir()` logger API.
- Moved hook and plugin logs into platform log directories with log levels and
  one-file rotation.

### Fixed

- Kept non-interactive installs on the global shared-key path even when
  detected clients already have distinct existing key files.
- Suppressed debug-level request and payload detail by default unless
  `MIDBRAIN_LOG_LEVEL=debug` is set.

### Notes

- Interactive multi-client installs can still choose distinct per-client keys,
  and existing distinct per-client keys are preserved.
- The MCP tool surface, existing key resolution chain, and generated client
  config shape are unchanged.
- Breaking changes: None.

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
