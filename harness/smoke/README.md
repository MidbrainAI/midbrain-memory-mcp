# MCP package smoke checks

This directory tests the MidBrain MCP package and its client connections without
model prompts. It is source tooling, excluded from the published npm package.

The PR-only `MCP PR smoke` workflow builds one npm archive, verifies the same
checksum-bound archive with Claude Code and Codex in parallel, and combines their
receipts into a strict gate. It uses GitHub-hosted runners, synthetic credentials,
a loopback API and a read-only Actions token. No model or service credentials are
required. Superseded runs are cancelled. Four jobs execute by default: package
build, two client jobs, and the report gate.

The smoke runner supports Linux and macOS. Windows native smoke is blocked until
its client launchers are implemented and validated; the repository's existing
Windows product tests remain separate.

## Read results

Open the PR check's **Details**, then the Actions **Summary**. Each client has a
readable assertion summary; failures identify the expectation, observation and
next evidence to inspect. The final gate requires both clients, complete coverage,
matching package identity, zero model calls and clean monitored host state.

Download `release-dry-smoke-claude` or `release-dry-smoke-codex`, unzip the whole
archive, and open its nested `report.html`. Keep the adjacent files for evidence
links. HTML includes expandable tool exchanges; JSON and JUnit support automation.
Artifacts expire after seven days. Full test homes and credentials are excluded
from uploads. Injected failures may be expected behavior in a passing scenario.

## Run locally

From the repository root, after `npm ci`:

```sh
npm run smoke:test
node harness/smoke/cli.mjs --clients claude,codex --root /tmp/mcp-smoke
```

The source command builds and packs this checkout once. For an existing package:

```sh
node harness/smoke/cli.mjs --clients claude,codex --root /tmp/mcp-smoke-release \
  --candidate-tarball /absolute/path/candidate.tgz \
  --candidate-sha256 FULL_SHA256 --candidate-version 0.4.10 \
  --candidate-source-sha FULL_COMMIT_SHA
```

Use `--install-clients` to install pinned npm clients into the run's temporary
tools directory, even when a host binary is already installed. Installed host clients can also be used; their actual
versions are recorded. Hermes requires a preinstalled binary. Python 3 is needed
for bounded archive extraction. Dependencies are installed with lifecycle scripts
disabled for the candidate; its installer is invoked explicitly in an isolated
home. Source SHA association is caller-supplied; the archive checksum itself is
verified before and after installation. Hosted CI tests the PR merge commit.

Checks cover install/reinstall, preserving a sibling MCP integration, configured
transport, reviewed tool schemas and calls, invalid inputs, authentication and
backend failures, recovery, account-key rollback, project/global key isolation,
restart, shutdown, and native connection/discovery. Native discovery is labelled
separately from direct SDK tool calls. Results do not establish production service
availability, retrieval quality, or agent reasoning/capture quality.
Client installation diagnostics are saved in `evidence/<client>/dry-smoke/client-setup.json`,
including failed setup attempts. Local source runs record whether the checkout
includes uncommitted changes; an archive-only run cannot attest to clean source.

## Reuse and extension API

Import `index.mjs` from a pinned checkout of this repository. `SMOKE_API_VERSION`
is 1. This component has no imports into other application tooling. It uses Node
built-ins and the MCP SDK, JSONC, TOML and YAML libraries already declared by the
repository. Dependency resolution must make those libraries available to this
directory, for example through the caller's ancestor `node_modules`.

```js
import {SMOKE_API_VERSION,runDrySmoke,freezeReleaseCandidate} from './harness/smoke/index.mjs';
if (SMOKE_API_VERSION !== 1) throw new Error('Review the smoke API upgrade');
await runDrySmoke(flags, {
  prepareCandidate: async (flags, options) => freezeReleaseCandidate({
    ...options, tarball: flags['candidate-tarball'],
    sha256: flags['candidate-sha256'], version: flags['candidate-version'],
    sourceSha: flags['candidate-source-sha'],
  }),
});
```

Optional hooks are `prepareCandidate(flags, {directory, env})`,
`verifyCandidate(candidate)` and `selectClients(ids)`. Preparation returns the
candidate shape produced by `freezeReleaseCandidate`: a frozen `repoRoot`, archive,
identity, hashes and runner file snapshot. Client descriptors supply `id`,
`displayName`, `binary`, `os`, `detectionFixtures`, `install` and `preflight`.
Extensions must preserve the supplied isolated environment and strict evidence
checks. The engine fingerprints its own files independently of candidate hooks.
Source callers can use the composite Action at `harness/smoke/action.yml` after
installing the repository's dependencies; its inputs are defined in that file.

Protocol tests, fixtures, contracts and report rendering belong here. Review
contract updates against the actual MCP implementation. Add adapters through the
documented hooks rather than copying the smoke engine.

Call `runDrySmoke` sequentially within a Node process. Cleanup completes before
the next invocation; overlapping invocations are rejected because signal handling,
child-process tracking and host-state monitoring are process-wide. Use separate
processes or the CI client matrix for parallel runs.
