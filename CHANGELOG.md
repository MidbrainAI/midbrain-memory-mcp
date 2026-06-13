# Changelog

All notable public release changes for `midbrain-memory-mcp` are tracked here.
Full release-note bodies live in `docs/releases/`.

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
