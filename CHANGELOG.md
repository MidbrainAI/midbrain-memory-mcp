# [0.5.0](https://github.com/MidbrainAI/midbrain-memory-mcp/compare/npm-v0.4.10...npm-v0.5.0) (2026-11-13)


### Bug Fixes

* accept the legacy capture-user and capture-assistant hook commands ([b1392c6](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/b1392c66c5819dddb95953c57da387e175dbcab7)), closes [#92](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/92)
* **claude:** skip Cursor-hosted runs when the Cursor hooks capture the turn ([4474062](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/4474062433db58b72e2a0ab9a2a56ad9a4abc44a)), closes [#61](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/61) [#100](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/100)
* **cursor:** bound every headless store and keep literal prompt tags ([119a6ed](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/119a6ed328aacec04b3a93946cb73c05adbb5157))
* **cursor:** drop the legacy instruction-cache migration ([628a686](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/628a6868b8a774d12b3656e02f6ad3584071cccf))
* **cursor:** remove live-capture markers untouched for a day ([c702a28](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/c702a28704b5db2ada4a05d02066340d6edb0475))
* describe grep as searching semantic and episodic memory in agent rules ([aeff544](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/aeff544e0986f52483e8559c6c8a148dfdced442)), closes [#82](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/82) [#66](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/66)
* **import:** count a Cursor chat's newest message as its last write ([d257c3b](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/d257c3bb736333dc2daa0b0bd23083ebb91c5721))
* **import:** count stored characters in the preview ([6effdff](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/6effdff71708893e18c1cfdebde9deb04e010473))
* **import:** drop the cut-off copy of input typed while Codex works ([90f8361](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/90f836134aee953068bf99f4a03f6877e9b2e46e))
* **import:** end a Cursor transcript turn at an image-only prompt ([1174eb3](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/1174eb3af1f3437c3ac0019e5b7fdd4e1079e025))
* **import:** end an OpenClaw turn at an image-only prompt ([83e14b7](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/83e14b762dd00d27326e9ab3272a1fa413ad1800)), closes [#110](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/110)
* **import:** find OpenClaw claude-cli sessions OpenClaw did not link ([1bc020b](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/1bc020bc3d8f15e7913a01aa000cc724fbc114a9))
* **import:** keep a Claude Code turn open across meta rows ([42a255d](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/42a255d6bd3bfe3be0664275890bfb79900b499b))
* **import:** keep JSON valid and skip code and prose in redaction ([a5c4dc5](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/a5c4dc57284b523e556af5392adb93bb2c654ac5))
* **import:** link OpenClaw sessions to their claude-cli session ([8fdab56](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/8fdab56e3132c5f146a47a04ffbf394fdd174d69))
* **import:** match live captures by text, and by linked session ids ([cb7edba](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/cb7edbab362ec38a9f8e07da7fc5c870a90ec8bc))
* **import:** one attempt per entry on v3, per-entry keys, fail-closed check ([0671582](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/067158260a0983dddc69440cc7cb633c106217ad))
* **import:** open Codex rollouts through the guarded reader ([fdad7de](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/fdad7dec1de7c25800fc7aa1359094525bb03873))
* **import:** open Cursor transcripts inside the projects folder ([4026a55](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/4026a55c846aeb57bd9ad95faacffbc69590ac8c))
* **import:** open Prime Agent logs through the guarded reader ([6eb4860](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/6eb4860f30487b118c0a5bdbe5bf9e87a9f81d97))
* **import:** read compressed Codex rollouts ([441f677](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/441f6777de40be7db00ea4fadf8b5dba1c7a2a46))
* **import:** read linked Claude Code sessions from OpenClaw's projects folder ([075dcbd](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/075dcbd974ff01318982d4aa9263f5db0ac9633c))
* **import:** read Prime Agent's session archive ([596c875](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/596c875a14fdad7b1c0b9d39fecb23032e8c2f96))
* **import:** report a Cursor store that cannot be listed instead of an empty chat ([84ff91f](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/84ff91f2b5905634e782d217f6eef1f4aabe01a9))
* **import:** report Cursor's never-written chats as empty ([74a9452](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/74a94521e9d062835fbe1b55669a155d575ac462))
* **import:** report folders without a project key once ([f024297](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/f024297be554269266b33a2b96bec11d63b3f961))
* **import:** report history that cannot be listed instead of showing none ([a08867f](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/a08867f064194bca2a10aec23cff7f62e216eb6a))
* **import:** retry a failed store twice before stopping ([cab1be5](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/cab1be595669a01d05637af618e1178079f23fe2))
* **import:** review fixes for duplicate clients, per-destination checks and 403s ([79bd819](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/79bd81939acea38f037bb505fe5d8350cbe01e48))
* **import:** review fixes for the Claude Code reader ([0c7829b](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/0c7829b366cb43df7ad9ae3ecfcaf789e8bce4b4))
* **import:** review fixes for the core and the Claude Code reader ([398c608](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/398c608c85b9bdff7bea034d6f8cd4135dc06047))
* **import:** review fixes for the Cursor reader ([94faa79](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/94faa7984ec891542cd4620d9a048d484f6eafd0))
* **import:** review fixes for the Hermes reader ([7a21d42](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/7a21d424196138ba21c0a06103b27aee87b604f2))
* **import:** review fixes for the Hermes reader (round 2) ([c3bc5c4](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/c3bc5c40366c14e8a531ea65dd866214fb6353b5))
* **import:** review fixes for the OpenClaw reader ([923fe0e](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/923fe0e48bcd3873bd3b8b4691e76d336f2196db))
* **import:** review fixes for the OpenClaw reader (round 2) ([b151178](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/b151178a81b84e5299f8c8a65b5a34a0879f40cd))
* **import:** review fixes for the OpenCode reader ([c6db1c8](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/c6db1c80366dfc6295bc3246a1779e3eedf49f61))
* **import:** review fixes for the OpenCode reader (round 2) ([48bfabb](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/48bfabb05e368d20602a7088384d7d42dbfb7724))
* **import:** review fixes for the Prime Agent reader ([cdfe071](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/cdfe0719534f741476461d4bfec1ada48134d420))
* **import:** skip a Cursor chat with made-up prompt times once live capture holds any of it ([a52cf3d](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/a52cf3d5914101ffcd31a2a179a6f769115d29e6))
* **import:** skip a session an earlier import read differently ([39335fe](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/39335fe6750cd3149a43392872125095fda1a3d2))
* **import:** skip Codex goal continuations ([082aa90](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/082aa90a877069b6c150cd3a1477b426d4047b8b))
* **import:** stop at once when the account is out of credits ([b829e1c](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/b829e1c46c4fd8b1a045014505f805350577f60c))
* **import:** strip MidBrain's own blocks from imported prompts ([2e77b9d](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/2e77b9dac9ceb4a5362e3ab7322eca64ffa3e792))
* **import:** tell a session with no prompts from one outside --since ([93e1155](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/93e1155a876344f1a8c3ed9267be297eb06556ea))
* **import:** treat codex exec runs as automated ([0313fd1](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/0313fd1870c2106e651ede704f200ec08ebfc328))
* isolate identity context and preserve Codex durable state ([2fce56e](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/2fce56eb992c0b7951b3ad4543963292dbd111e5))
* never cache an OpenClaw capture twice, and keep one when the turn ends early ([c8f65dc](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/c8f65dcb36345450093adf756b754b03b1423d3f))
* never hold the Cursor prompt on capture; report unchanged installs ([4643252](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/46432523c6a0c606d83eb07eef1674b36d3cbcd9))
* release assistant capture reservations after lookup failure ([4eda2c3](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/4eda2c38ee104cb6c47e3b064bb45ad8488eca9b))
* resolve the project key from parent directories and git worktrees ([0288061](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/02880610f90a884eef3bd7fe70e0a478e460c5d8)), closes [#92](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/92)
* support OpenCode v2 hooks while preserving v1 compatibility ([af7f946](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/af7f9461bbf4c50e41918a11434c98e1b500b450))
* validate openclaw.json before copying the plugin; keep the CLI patch to merges ([2398782](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/23987827b22795a72f9a4e974e4640ecbab2195c))


### Features

* add an opt-in import of earlier conversations ([#75](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/75)) ([51e0246](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/51e0246478b43df735b2cbece1cc8fe57903d6d2))
* add Cursor client support ([e1f8f37](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/e1f8f37ef687aee83af66429e14f29fe4e9f3c9e)), closes [#72](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/72)
* add OpenClaw client support ([785ec76](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/785ec76e5400a229a6e2879286a6ae1aff38c906)), closes [#73](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/73)
* add Prime Agent client support ([e398699](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/e398699ac5bb630261326a0249ae938e3498592c))
* **cursor:** capture headless agent -p runs from the sessionEnd transcript ([4a525a2](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/4a525a22f658b05e83632c81bcec0b5b5276514b)), closes [#97](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/97)
* **cursor:** inject persona and profile via MCP instructions ([7c2ec88](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/7c2ec884e2984da3b9abefff1b145d630284a445))
* **import:** import Claude Code history ([#75](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/75)) ([cb2535d](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/cb2535d97f2857245835c021554a9ad733f697b9))
* **import:** import Codex history ([#75](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/75)) ([6404328](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/6404328415c4db4e7b614310105f841fa565bf27))
* **import:** import Cursor history ([#75](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/75)) ([66854c5](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/66854c59d857c3d0c83785eb7b39f29f67d24a5d))
* **import:** import Hermes Agent history ([#75](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/75)) ([259170d](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/259170d9027c8824f449eb1c5ec5992f3367d0f6))
* **import:** import OpenClaw history ([#75](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/75)) ([17b36d8](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/17b36d8b3c88fe17f7ca9e40615903a0ad9e7d07))
* **import:** import OpenCode history ([#75](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/75)) ([41b7f34](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/41b7f3484a5c383eae5df05214cf4e2268843c78))
* **import:** import Prime Agent history ([#75](https://github.com/MidbrainAI/midbrain-memory-mcp/issues/75)) ([4e31a16](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/4e31a169ee44228008d7e0d5b77681670d2887e4))
* **import:** say how far an import got and how to continue when it stops ([5a7b785](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/5a7b785f4bfd0e5b03a3f0a2f4bd5414e1714c24))
* **import:** upload entries in parallel, up to 8 in flight ([30d5204](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/30d5204ad4fe6c878a32742e00dc2c5faad5a864))
* inject persona and profile into the session turn ([b8a1643](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/b8a1643d4e0e43cf71ab4210dbf4602712a6b6f6))
* mark read-only MCP tools with readOnlyHint ([fc57f98](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/fc57f9808b21fea9c6ba1efc2b40efbab3147b74))
* **openclaw:** add persona and profile to the system prompt ([00c128e](https://github.com/MidbrainAI/midbrain-memory-mcp/commit/00c128e5771367582306117a2e5a48eca8e50d83))

# Changelog

All notable public release changes for `midbrain-memory-mcp` are tracked here.
Historical release-note bodies live in `docs/releases/`. Automated releases
record their notes here and in GitHub Releases.

## 0.4.10

Full notes: [docs/releases/v0.4.10.md](docs/releases/v0.4.10.md)

### Changed

- Made `grep` preserve both semantic and episodic lexical matches by default,
  with an optional `memory_type` filter and stable formatting for mixed API
  result shapes.

### Fixed

- Kept `read_file` missing-file responses on the semantic-file endpoint's GET
  path so a real 404 returns the existing friendly response without an invalid
  POST retry.
- Recovered the opening user message for the exact untouched NanoClaw legacy
  cold-start case where the historical v0.4.8 `UserPromptSubmit` shim fails
  before self-repair, while preserving normal assistant capture.

### Notes

- Legacy-opener recovery is narrowly transcript-attested and NanoClaw-only.
  It makes one terminal recovery POST attempt and never adds the recovered user
  to spool or cache.
- The recovery receipt provides an at-most-once attempt boundary, not
  crash-atomic delivery; server-side idempotency would be required to close
  the remaining crash window.
- No MCP tools, bins, configuration formats, dependencies, or credential
  locations changed. Breaking changes: None.

## 0.4.9

Full notes: [docs/releases/v0.4.9.md](docs/releases/v0.4.9.md)

### Added

- Added optional `cwd` and `session_id` metadata to episodic captures across
  OpenCode, Claude Code, Codex, Hermes, and NanoClaw, with cross-user path
  privacy normalization.
- Added `X-Midbrain-User-Agent` to authenticated memory and account requests,
  reporting the package version and resolved client identity without replacing
  the standard user-agent header.

### Changed

- Moved failed episodic-cache replay to one bounded, paced, binding-scoped
  boot pass instead of replaying the backlog from successful capture hooks.
- Made NanoClaw's MidBrain-owned state relocatable to its durable Claude mount,
  including keys, shims, host config, keystore, and offline cache.

### Fixed

- Migrated existing NanoClaw groups to the `nanoclaw` capture label before MCP
  readiness while leaving ordinary Claude Code hosts labeled `claude`.
- Recovered the first user and assistant captures on a cold NanoClaw wake with
  bounded key resolution and a binding-scoped, loss-preserving recovery spool.
- Prevented offline-cache replay amplification and cross-binding replay while
  preserving failed, malformed, torn, concurrent, and rate-limited evidence.
- Kept NanoClaw spool and offline-cache recovery metadata aligned with direct
  capture metadata.

### Notes

- No MCP tools were removed or renamed, and there are no breaking changes.
- Recovery remains deliberately at-least-once; uncertain evidence is retained
  rather than discarded.

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
