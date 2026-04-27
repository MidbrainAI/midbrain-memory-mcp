#!/usr/bin/env bash
# scripts/check-pinned-spec.sh (PRD-010)
#
# Fails the build if any tracked source file (outside the exclusions
# below) contains the bare package name "midbrain-memory-mcp" not
# followed by "@" or another safe continuation char. The goal is to
# prevent regressions to the unpinned-npx footgun where a config example
# in the docs says `npx -y midbrain-memory-mcp` without `@latest` and
# teaches users a cache-sticky install pattern.
#
# Regex:  midbrain-memory-mcp([^@a-zA-Z0-9_/.-]|$)
#   Matches the bare package name followed by anything NOT in the safe
#   set, or by end-of-line. Safe set:
#     @   permits "@latest", "@0.3.1", "@beta" etc.
#     /   permits "midbrain-memory-mcp/server.js" paths (runtime
#         migration handles those cases)
#     .   permits URL fragments like "midbrain-memory-mcp.git"
#     -   permits hypothetical sibling packages like
#         "midbrain-memory-mcp-extension"
#     _   permits identifier-like uses
#     a-zA-Z0-9  permits longer identifiers (should almost never hit)
#
# Exclusions:
#   - node_modules/ / .git/
#   - tasks/          internal PRDs, backlog, review notes (intentionally
#                     contain historical bare references)
#   - tests/          fixtures for stale-pattern detection contain the
#                     bare form on purpose
#   - shared/midbrain-common.mjs
#                     defines NPM_PACKAGE_NAME = "midbrain-memory-mcp"
#                     as the single source of truth
#   - server.js       PRD-005 update hint string: "npm update -g ..."
#   - package.json / package-lock.json
#                     self-referential (the package IS midbrain-memory-mcp)
#   - CHANGELOG.md / BACKLOG.md
#                     historical references permitted
#   - team-rollout-*.md / TEAM-ROLLOUT-*.md
#                     release-notes scratchpads, gitignored

set -euo pipefail

FOUND=$(grep -rn -E "midbrain-memory-mcp([^@a-zA-Z0-9_/.-]|$)" \
    --include="*.md" --include="*.json" --include="*.mjs" \
    --include="*.ts" --include="*.js" --include="*.sh" \
    --exclude-dir=node_modules --exclude-dir=tasks --exclude-dir=.git \
    --exclude-dir=tests \
    --exclude="package.json" --exclude="package-lock.json" \
    --exclude="CHANGELOG.md" --exclude="BACKLOG.md" \
    --exclude="team-rollout-*.md" --exclude="TEAM-ROLLOUT-*.md" \
    --exclude="midbrain-common.mjs" \
    --exclude="server.js" \
    --exclude="check-pinned-spec.sh" \
    . || true)

if [ -n "$FOUND" ]; then
  echo "ERROR: unpinned 'midbrain-memory-mcp' references found."
  echo "Use 'midbrain-memory-mcp@latest' or '@X.Y.Z'."
  echo ""
  echo "$FOUND"
  exit 1
fi

echo "OK: no unpinned midbrain-memory-mcp references."
