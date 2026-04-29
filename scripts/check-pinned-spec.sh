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

# Step 1: bare grep. Step 2: filter out known-safe "midbrain-memory-mcp install"
# invocations (PRD-011 subcommand) — that invocation is pinned via the `install`
# subcommand contract, not via `@latest`, but it is a legitimate public command
# the docs MUST lead with.

RAW=$(grep -rn -E "midbrain-memory-mcp([^@a-zA-Z0-9_/.-]|$)" \
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

# Strip allowed "midbrain-memory-mcp install" tokens from each line, then
# re-check the residual for bare unpinned references. A line-level grep -v
# would forgive a mixed line that has both allowed and unsafe references on
# the same line — the strip-then-recheck approach catches those.
#
# Additional safe patterns stripped (documentation, not config examples):
#   - `midbrain-memory-mcp`  (backtick-quoted package name in prose)
#   - "midbrain-memory-mcp"  (double-quoted, e.g. find -name)
#   - midbrain-memory-mcp)   (URL suffix in badge/link markup)
#   - midbrain-memory-mcp v  (startup log message format)
#   - cd midbrain-memory-mcp (directory name after git clone)
FOUND=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  stripped=$(printf '%s' "$line" | sed -E \
    -e 's/midbrain-memory-mcp[[:space:]]+install([^a-zA-Z0-9_-]|$)/REDACTED_INSTALL\1/g' \
    -e 's/`midbrain-memory-mcp`/REDACTED_PROSE/g' \
    -e 's/"midbrain-memory-mcp"/REDACTED_PROSE/g' \
    -e 's/midbrain-memory-mcp\)/REDACTED_URL)/g' \
    -e 's/midbrain-memory-mcp v[0-9]/REDACTED_LOG/g' \
    -e 's/(cd|clone) midbrain-memory-mcp/\1 REDACTED_DIR/g')
  if printf '%s' "$stripped" | grep -qE 'midbrain-memory-mcp([^@a-zA-Z0-9_/.-]|$)'; then
    FOUND="${FOUND}${line}
"
  fi
done <<< "$RAW"

if [ -n "$FOUND" ]; then
  echo "ERROR: unpinned 'midbrain-memory-mcp' references found."
  echo "Use 'midbrain-memory-mcp@latest' or '@X.Y.Z'."
  echo ""
  echo "$FOUND"
  exit 1
fi

echo "OK: no unpinned midbrain-memory-mcp references."

# ---------------------------------------------------------------------------
# PRD-011: reject the 60-char 'npx ... --package=... midbrain-memory-setup'
# form. That was the PRD-010 post-review fix for the bare-npx E404 breakage,
# but it is not the public install story. All user-facing docs must use
# 'npx midbrain-memory-mcp install' instead (which routes to the `install`
# subcommand on the main bin).
#
# The pattern requires 'npx' + '--package=midbrain-memory-mcp' + a space +
# 'midbrain-memory-setup'. This is deliberately strict: bare prose mentions
# like the legacy-bin note in AGENTS.md ('midbrain-memory-setup bin still
# works') do NOT match and remain allowed.
# ---------------------------------------------------------------------------

FOUND_60CHAR=$(grep -rn -E 'npx.*--package=midbrain-memory-mcp[^[:space:]]*[[:space:]]+midbrain-memory-setup' \
    --include="*.md" --include="*.json" --include="*.mjs" \
    --include="*.ts" --include="*.js" --include="*.sh" \
    --exclude-dir=node_modules --exclude-dir=tasks --exclude-dir=.git \
    --exclude-dir=tests \
    --exclude="package.json" --exclude="package-lock.json" \
    --exclude="CHANGELOG.md" --exclude="BACKLOG.md" \
    --exclude="team-rollout-*.md" --exclude="TEAM-ROLLOUT-*.md" \
    --exclude="check-pinned-spec.sh" \
    . || true)

if [ -n "$FOUND_60CHAR" ]; then
  echo "ERROR: legacy 60-char 'npx --package=... midbrain-memory-setup' form found."
  echo "Use 'npx midbrain-memory-mcp install' instead."
  echo ""
  echo "$FOUND_60CHAR"
  exit 1
fi

echo "OK: no legacy 60-char install-command references."
