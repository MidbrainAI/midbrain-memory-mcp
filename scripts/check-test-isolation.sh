#!/usr/bin/env bash
# PRD-035: credential-writing tests must remain sandboxed even when filesystem
# module mocks do not attach in copied or symlinked dependency topologies.

set -euo pipefail

MODE="${1:-}"
if [[ -n "$MODE" && "$MODE" != "--static-only" ]]; then
  echo "Usage: bash scripts/check-test-isolation.sh [--static-only]" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

WRITER_PATTERN='(^|[^[:alnum:]_])(writeKey|writeSecure|setProjectKey)[[:space:]]*\(|(^|[^[:alnum:]_])main[[:space:]]*\([[:space:]]*\{?[[:space:]]*nonInteractive|(^|[^[:alnum:]_])runInstallerCli[[:space:]]*\('
violations=()
exception_count=0

while IFS= read -r -d '' test_file; do
  if ! grep -Eq "$WRITER_PATTERN" "$test_file"; then
    continue
  fi
  case "$test_file" in
    tests/client-base.test.mjs)
      # PRD-035 seeded exception: line 54 defines a stub adapter writeKey()
      # returning "written"; it never reaches a production credential writer.
      exception_count=$((exception_count + 1))
      continue
      ;;
  esac
  if ! grep -Fq 'makeTestEnv(' "$test_file"; then
    violations+=("$test_file")
  fi
done < <(git ls-files -c -o --exclude-standard -z -- tests)

if [[ "$exception_count" -ne 1 ]]; then
  echo "ERROR: expected exactly one PRD-035 static-guard exception; found $exception_count." >&2
  exit 1
fi

if [[ "${#violations[@]}" -gt 0 ]]; then
  echo "ERROR: credential-writing tests without makeTestEnv() isolation:" >&2
  printf '  - %s\n' "${violations[@]}" >&2
  exit 1
fi

echo "OK: test credential isolation static guard passed (1 seeded exception)."
if [[ "$MODE" == "--static-only" ]]; then
  exit 0
fi

if [[ "$(node -p 'process.platform')" == "win32" ]]; then
  echo "SKIP: copied-topology isolation check is POSIX-only."
  exit 0
fi

REAL_HOME="$(node -p 'require("os").homedir()')"
SURFACE_HOME="${MIDBRAIN_ISOLATION_HOME:-$REAL_HOME}"

if [[ -n "${MIDBRAIN_ISOLATION_HOME:-}" ]]; then
  node --input-type=module - "$SURFACE_HOME" "$REAL_HOME" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const [override, realHome] = process.argv.slice(2);
const canonical = (value) => fs.realpathSync.native(path.resolve(value));
if (canonical(override) === canonical(realHome)) {
  console.error("ERROR: MIDBRAIN_ISOLATION_HOME resolves to the real home; refusing negative self-test.");
  process.exit(1);
}
if (!fs.statSync(override).isDirectory()) {
  console.error("ERROR: MIDBRAIN_ISOLATION_HOME must name an existing directory.");
  process.exit(1);
}
NODE
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/midbrain-test-isolation.XXXXXX")"
COPY_ROOT="$TEMP_ROOT/repo"
BEFORE_HASHES="$TEMP_ROOT/before.json"
AFTER_HASHES="$TEMP_ROOT/after.json"
trap 'rm -rf "$TEMP_ROOT"' EXIT
mkdir -p "$COPY_ROOT"

while IFS= read -r -d '' source_file; do
  mkdir -p "$COPY_ROOT/$(dirname "$source_file")"
  cp -Pp "$source_file" "$COPY_ROOT/$source_file"
done < <(git ls-files -c -o --exclude-standard -z)

ln -s "$REPO_ROOT/node_modules" "$COPY_ROOT/node_modules"
cd "$COPY_ROOT"

snapshot_surfaces() {
  local output_file="$1"
  local surface_home="$2"
  node --input-type=module - "$output_file" "$surface_home" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

delete process.env.HERMES_HOME;
delete process.env.NANOCLAW_HOME;
const [outputFile, surfaceHome] = process.argv.slice(2);
const helperUrl = pathToFileURL(path.resolve("tests/helpers/global-tripwire.mjs"));
const { collectHashes, tripwireSurfaces } = await import(helperUrl.href);
fs.writeFileSync(
  outputFile,
  JSON.stringify(collectHashes(tripwireSurfaces(surfaceHome))),
  "utf8",
);
NODE
}

compare_surfaces() {
  local before_file="$1"
  local after_file="$2"
  node --input-type=module - "$before_file" "$after_file" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [beforeFile, afterFile] = process.argv.slice(2);
const helperUrl = pathToFileURL(path.resolve("tests/helpers/global-tripwire.mjs"));
const { diffHashes } = await import(helperUrl.href);
const before = JSON.parse(fs.readFileSync(beforeFile, "utf8"));
const after = JSON.parse(fs.readFileSync(afterFile, "utf8"));
const drifted = diffHashes(before, after);
if (drifted.length > 0) {
  console.error("ERROR: client configuration drift detected:");
  for (const filePath of drifted) console.error(`  - ${filePath}`);
  process.exit(1);
}
NODE
}

snapshot_surfaces "$BEFORE_HASHES" "$SURFACE_HOME"

if [[ -n "${MIDBRAIN_ISOLATION_HOME:-}" ]]; then
  sentinel="$SURFACE_HOME/.config/midbrain/.midbrain-key"
  mkdir -p "$(dirname "$sentinel")"
  printf '%s\n' 'dummy-isolation-sentinel' > "$sentinel"
  chmod 600 "$sentinel"
fi

set +e
./node_modules/.bin/vitest run \
  tests/client-codex.test.mjs \
  tests/client-hermes.test.mjs \
  tests/client-nanoclaw.test.mjs \
  tests/install.test.mjs \
  tests/credential-isolation.test.mjs
test_status=$?
set -e

snapshot_surfaces "$AFTER_HASHES" "$SURFACE_HOME"
drift_status=0
compare_surfaces "$BEFORE_HASHES" "$AFTER_HASHES" || drift_status=$?

if [[ "$test_status" -ne 0 ]]; then
  echo "ERROR: copied-topology credential suites failed." >&2
  exit "$test_status"
fi
if [[ "$drift_status" -ne 0 ]]; then
  exit "$drift_status"
fi

echo "OK: copied-topology credential suites passed with no client configuration drift."
