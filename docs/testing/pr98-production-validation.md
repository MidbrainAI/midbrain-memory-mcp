# PR #98: production API validation, 2026-10-06

Product revision tested: `2fce56eb992c0b7951b3ad4543963292dbd111e5`.
This supplements the [earlier fixture-backed evidence](https://github.com/MidbrainAI/midbrain-memory-mcp/pull/98#issuecomment-6014996666).

## Why repeat the fixture tests?

The earlier paired tests used real model providers but a local MidBrain HTTP fixture. That made populated, blank, and failing responses deterministic without editing an account's stored identity. They tested injection wiring, not the production API integration.

The runs below use `https://memory.midbrain.ai`, existing client credential resolution, and this checkout. No production persona/profile values were written. The account's existing test persona names **Lumen Harbor 61** and its profile says the user collects **river stones**. The identity prompts did not include either answer and prohibited tools, file inspection, and memory search.

## Native production smoke tests

| Client | Provider / model | Result |
| --- | --- | --- |
| Codex 0.160.1 | OpenAI / gpt-6-astra | Both identity fields returned. |
| Hermes 0.21.5+7752.g3285923 | openai-codex / gpt-6-astra | Both fields returned. |
| OpenCode 1.18.34 | OpenAI / gpt-6-astra | First attempt returned persona only; next fresh session returned both. The first transcript contains no injected profile section. |
| OpenCode 1.18.34 | OpenCode / Big Pickle | Both fields returned. |
| Cursor CLI 2026.10.01-e373342 | Native configured model | Both fields returned. |
| Cursor desktop 3.23.12 | Grok 4.7 High Fast | Current connection positive/control/positive sequence passed; details below. |
| OpenClaw 2026.9.6 | OpenAI / gpt-6-astra, Codex harness | Both fields returned; runtime reported no provider fallback. |
| NanoClaw 2.4.0 | Codex 0.155.1 / gpt-6-astra | Cold-container run returned both fields; user and assistant captures verified in production. |
| Claude Code 2.1.291 | Native subscription | Blocked by provider HTTP 429 weekly quota; reset reported October 7 at 18:00 Europe/Zurich. Not a pass. |

The first OpenCode omission remains in the results. Five subsequent direct production read pairs all returned HTTP 200 and both fields; one profile read took 1,693 ms against the existing 2,000 ms bound. The initial request was not instrumented, so its precise failure cause is unknown. Later successes do not establish that production reads always succeed.

### Cursor desktop: current connection, not stale identity

Initial desktop runs reused an MCP connection started the previous day. Those runs alone were insufficient evidence for the reviewed revision. A native configuration refresh subsequently established a new server connection, whose log recorded a 290-character signed identity block from the current checkout.

Three fresh chats then produced:

1. Current checkout and real API: both identity fields.
2. Real API read, with a test wrapper locally replacing the returned MCP instructions with the neutral baseline: exactly `MISSING`.
3. Original native configuration restored: both identity fields again.

The control changed only the instructions sent to Cursor; the production fields were unchanged. Configuration was compared with its backup after restoration. The old unsigned instruction files were retired by the reviewed migration; no test manually populated Cursor's instruction cache.

Screenshots: [restored production connection](pr98/cursor-production.png), [local suppression control](pr98/cursor-control.png). These are unedited native desktop screenshots, not CLI results.

### NanoClaw: cold container and production capture

The dedicated approved test group used the mounted checkout, durable Codex state, its own previously authorized OpenAI login through OneCLI, and the Codex provider. The container started at `2026-10-06T13:51:49.516Z`. The test marker was `PR98-20261006-COLD`.

The answer returned both fields. Production lexical reads subsequently confirmed the triggering user capture (record `413178`) and assistant capture (record `413180`). Both carried the same Codex session identifier and `/workspace/agent` cwd. Capture metadata still says `codex`, not `nanoclaw`.

This was a cold container with a **resumed model session**, not a new model conversation. A later `/clear` request was rejected by NanoClaw because the CLI sender lacks admin access; no permission changes were made. Thus this run proves cold-start capture and identity availability, but does not independently prove identity in a history-free NanoClaw model session.

## Memory-priming experiment

The controlled experiment runs real native Codex, Hermes, and OpenCode processes against the real MidBrain API, all using `gpt-6-astra`. It compares identity enabled with identity locally disabled. Memory rules are generated from the same `buildRulesBlock` implementation for both conditions, with each client's normal tool-discovery adaptation.

- Three tasks: the project-binding investigation in `issue #92`, the cold-start races in `issue #52`, and a deliberately unrecorded rollout identifier.
- Two repetitions per task and condition per client: **36 trials**, 18 in each condition.
- Fresh native model session per trial; ON/OFF order reverses in repetition two.
- ON calls the production persona/profile methods through the native user hook/plugin. OFF intercepts those methods locally and returns null. Neither arm changes production data or uses a fake API server.
- Memory tools call the current checkout and production API. Benchmark MCP exposes only read-oriented tools and disables startup repair. Capture methods are locally suppressed to avoid storing trial answers and contaminating subsequent retrievals.
- Codex uses an isolated `CODEX_HOME` and the same application's existing auth store; Hermes uses an isolated native profile with its supported auth fallback; OpenCode uses isolated configuration and the source plugin. Provider credentials are neither printed nor copied between applications.
- The three clients run concurrently; each client's trials are sequential. Codex/OpenCode have a 125-second process limit; Hermes also has a 100-second native run budget and 12-turn limit.

Six separate no-tool identity controls validated the final isolation approach before scoring: every ON run returned both production values, and every OFF run returned exactly `MISSING`. An additional six controls passed with the portable checked-in harness.

Earlier pilot results are excluded. The pilot exposed that Codex's global hooks still ran despite `--ignore-user-config`, storing pilot prompts/answers. The final harness isolates `CODEX_HOME`; scored tasks use different anchors from that pilot. The pilot also exposed an MCP wrapper that imported the entry point without starting the server; that wrapper was corrected before scoring.

### Scoring

`memoryFirst` requires the first native action after permitted tool discovery to be MidBrain `memory_search`. Reading a skill or running a shell command first counts as failure. The first *audited MidBrain tool* alone is insufficient to establish this ordering.

`initialAnchorPreserved` checks the literal task anchor in the first search only. `startsNear10` checks a first limit of 8–12. `widened50` means a subsequent or initial **memory_search** used 50; a `grep(limit=50)` does not satisfy that metric. Widening is not required when initial recall already recovered the target. Answer completion and factual grounding are reviewed separately from these structural checks.

Results are recorded in the accompanying sanitized JSON. Raw transcripts, retrieved memory text, and native authentication/configuration artifacts remain outside the repository.

### Results (36 scored trials)

| Client | Identity | Recall first | Literal anchor | Request ID | Process completed | Grounded outcome | Median wall time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| codex | on | 4/6 | 5/6 | 6/6 | 5/6 | 5/6 | 86.9 s |
| codex | off | 5/6 | 5/6 | 6/6 | 4/6 | 4/6 | 96.7 s |
| hermes | on | 6/6 | 6/6 | 6/6 | 6/6 | 5/6 | 108.3 s |
| hermes | off | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 77.5 s |
| opencode | on | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 62.9 s |
| opencode | off | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 56.4 s |

Data: [sanitized per-trial results](pr98/priming-results.json). Grounded outcome includes a substantiated answer for known targets or an honest searched-and-not-found answer for the deliberately absent identifier. It is distinct from merely exiting successfully.

- Strict recall-first: **16/18 ON versus 17/18 OFF**. All three misses were Codex reading `using-superpowers/SKILL.md` before memory recall (two ON, one OFF). This small sample does not establish whether identity caused the difference.
- All 36 first searches retained the request ID and began with limit 10. Two Codex queries used `#52` rather than the full literal phrase `issue #52`; those fail the stricter literal-anchor metric but retain the issue ID.
- All 36 production identity GETs in the ON condition returned populated fields. All OFF identity methods were locally suppressed.
- Three Codex recovery trials hit the 125-second process limit (one ON, two OFF). Hermes produced one honest abstention on the recovery task with identity ON; it did not invent the missing history. These four trials are not counted as grounded task outcomes.
- All **12 absent-record trials** widened memory search to 50, performed further exact-target checking, and declined to invent a rollout decision.
- One Codex OFF lexical query received HTTP 400 because it used a capturing regex group; the production API requires a non-capturing group. The model recovered and completed the task. The tool description’s generic POSIX-regex wording warrants a separate follow-up.

Wall times include the process cap for timed-out trials, and are descriptive only. Native per-step token counters are retained in the JSON. In the separate portable no-tool controls, ON added 162 reported input tokens in Codex and 109 each in Hermes/OpenCode for this short identity. These are individual observations, not a general context-cost estimate.

### Scope of conclusions

This is a descriptive smoke benchmark, not a statistically powered non-inferiority study. Different native system prompts, reasoning defaults, caches, and concurrent execution prevent direct cross-client latency/token comparisons. Even equal success counts would not prove absence of regression. The identity is short and benign; long or adversarial identity text is not covered by these live trials. Desktop, NanoClaw, and OpenClaw are covered by the production integration tests above, not this paired priming experiment. Claude remains quota-blocked.

## Reproduce

Requires Node, Python 3, repository dependencies, the native `codex`, `hermes`, and `opencode` commands, their existing provider logins, and production MidBrain client credentials. This is an explicit live experiment, excluded from the unit suite.

```sh
# First verify the local ON/OFF manipulation against the existing test identity.
PR98_REPS=1 PR98_TASK=identity node scripts/benchmark-memory-priming.mjs --live

# The default scored matrix is 3 clients × 3 tasks × 2 conditions × 2 repetitions.
node scripts/benchmark-memory-priming.mjs --live

# Use the artifactDir printed by the runner.
python3 scripts/score-memory-priming.py /path/to/artifactDir
```

Optional selection: `PR98_CLIENTS=codex,hermes,opencode`, `PR98_TASK=decision|recovery|missing|identity`, `PR98_REPS=1..20`. Executable overrides: `CODEX_BIN`, `HERMES_BIN`, `OPENCODE_BIN`. The portable runner generates a new unrecorded identifier each invocation. It also isolates and seeds the update-check throttle; the original measured run used the existing native throttle. Raw result files are mode 0600 under a private temporary directory. Inspect only `summary.json` for publication; keep `scored-results.json`, audit logs, native profiles, and auth links private. Remove the experiment's temporary directories and its named Hermes profile after retaining any evidence needed locally.
