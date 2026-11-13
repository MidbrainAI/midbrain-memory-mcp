# Automated npm releases

Development lands on `main`. When ready to ship, merge `main` into the long-lived
`release` branch using a **merge commit**, preserving the individual conventional
commits. That push starts `.github/workflows/release.yml`; no second release PR
or manual version bump is required. npx consumes the package published to npm.

The workflow runs the existing Ubuntu, Windows, and macOS tests plus the full
Ubuntu check. Only after they pass does semantic-release calculate the version,
write the changelog and package/lockfile versions, dry-run npm publishing, commit
the generated files to `release`, push the tag, publish to npm `latest`, and
create the GitHub release. The generated commit uses `[skip ci]` to avoid loops.
The bundle rebuilds after the version bump so its embedded version is current.
Release runs are serialized and never cancelled midway through publication.

## One-time setup before merging into release

1. Review and merge the automation into `main`. This change does not create a
   branch, tag, commit, GitHub release, or npm publication by itself.
2. In the npm package's settings, configure a **GitHub Actions trusted publisher**:
   organization `MidbrainAI`, repository `midbrain-memory-mcp`, workflow filename
   `release.yml`, environment `npm`, with permission to publish. These values
   refer to the canonical GitHub repository; the old underscore Git remote
   redirects there. No `NPM_TOKEN` secret is needed. The workflow uses Node 24;
   trusted publishing requires npm 11.5.1 or newer.
3. Create the GitHub environment `npm` and restrict its deployment branches to
   `release`. Leave required reviewers off if merging should be the only approval.
4. Optional (deferred for the initial setup): protect `release`. Require reviewed promotion PRs and passing CI, disable
   force pushes and deletion, and restrict who can merge. The release bot must
   also be able to push the generated version/changelog commit and `npm-v*` tags.
   If your rules block `GITHUB_TOKEN`, configure `RELEASE_TOKEN` with a dedicated
   bot's fine-grained token (repository Contents read/write) and give that actor
   the narrowly scoped ruleset bypass needed for generated release commits/tags.
   Do not disable protection for all contributors. GitHub issue/PR comments are
   disabled; the workflow needs only Contents write and OIDC token permissions.
5. Create `release` from the published `v0.4.10` commit, then open the first
   `main` → `release` promotion PR. Creating it directly from current `main`
   would immediately publish all accumulated changes once this workflow exists.

These account settings must be configured by a repository/npm package owner.
Nothing in this implementation changes them automatically.

## Versions and tags

| Commit since the previous release | Result |
| --- | --- |
| `fix: ...` or `perf: ...` | Patch, e.g. 0.4.10 → 0.4.11 |
| `feat: ...` | Minor, e.g. 0.4.10 → 0.5.0 |
| A `BREAKING CHANGE:` footer | Major, e.g. 0.4.10 → 1.0.0 |
| Only docs, tests, chores, or refactors | No publication |

The largest change wins. Use conventional titles when squash-merging feature
PRs into `main`. Use a merge commit for promotions to preserve those titles and
commit bodies. Use the explicit `BREAKING CHANGE:` footer for breaking changes;
this setup uses semantic-release's default commit parser and semver policy,
including major bumps before 1.0. Review accumulated commits before promotion.

The historical `v1.1.0` tag predates the npm 0.x series. Sorting all `v*` tags
would incorrectly select it as the baseline. Automated releases therefore use
`npm-vX.Y.Z`. On each runner, an `npm-v0.4.10` bootstrap alias points to the
verified `v0.4.10` commit `b09f9f6ce0e9eb19655d1062c8db92f7c079a8ad`.
semantic-release pushes this alias along with the first new release tag; it does
not republish 0.4.10 or create a GitHub release for the alias. Existing tags are
preserved. Subsequent automated tags supply
the release baseline. The registry guard requires the previous selected tag's
version to equal npm `latest`, and rejects existing or decreasing next versions.

The package stays at 0.4.10 in this implementation. The first actual release
includes all releasable commits since v0.4.10; it is not forced to be a patch.

## After each release

Merge `release` back into `main` with a merge commit to bring back the generated
package version, lockfile, changelog, and release ancestry. Do this before the
next promotion. Do not squash this synchronization or manually bump versions.
Resolve any lockfile conflicts with `npm install --package-lock-only` and run
`npm run check`. `release` must remain a descendant of the previous release tag.

Future release notes are generated in `CHANGELOG.md` and GitHub Releases.
Historical hand-written files under `docs/releases/` remain historical records.

## Failures and recovery

- Failed checks: fix on `main`, then promote the fix. No release was attempted.
- No releasable commits: success with no new version is expected.
- Failure before a new tag is pushed: correct the configuration and re-run the
  failed workflow. The npm dry-run verifies packaging, not successful OIDC upload.
- Failure after a tag is pushed: **do not blindly rerun or delete the tag**.
  semantic-release creates the tag before npm publication. The preflight guard
  fails on an unpublished tag even when there are no new commits. Inspect the tag, generated commit,
  GitHub Release, npm version, and `latest` dist-tag first.
  If npm is missing that version, an npm owner must check out the exact tag,
  run `npm ci`, `npm run check`, and `npm publish --dry-run`, inspect the package,
  then finish `npm publish --access public` using their authorized npm login.
  If npm already has the version, do not republish it; finish only the missing
  GitHub release from the existing tag and changelog. Never reuse an uploaded
  npm version. The registry guard intentionally blocks the next release while
  tags and npm disagree.

Do not run `npm run release` locally to inspect configuration: it is the publishing
command. Tests and `npm publish --dry-run` are safe local checks. Running Actions
with the configured publisher is the final integration test; no real publication
is performed while reviewing this change.

References: [semantic-release](https://github.com/semantic-release/semantic-release),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[release commits](https://github.com/semantic-release/git).
