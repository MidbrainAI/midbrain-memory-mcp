/**
 * Doc-regression tests (PRD-011 §8 D-1..D-5).
 *
 * Guards against:
 *   - The legacy 60-char `npx -y --package=midbrain-memory-mcp@latest
 *     midbrain-memory-setup` install-command form reappearing in user-facing
 *     docs. It has been replaced by `npx midbrain-memory-mcp install`.
 *   - Bare prose mentions of `midbrain-memory-setup` (e.g. "the legacy
 *     midbrain-memory-setup bin still works") remain allowed — the grep
 *     pattern requires `npx` + `--package=...` + `midbrain-memory-setup` so
 *     those don't trigger.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "check-pinned-spec.sh");

// Match the grep regex inside scripts/check-pinned-spec.sh exactly.
// Extended regex: npx.*--package=midbrain-memory-mcp[^space]*[space]+midbrain-memory-setup
const SIXTY_CHAR_FORM =
  /npx.*--package=midbrain-memory-mcp\S*\s+midbrain-memory-setup/;

describe("docs regression (PRD-011 §8 D-1..D-5)", () => {
  it("D-1: README.md contains no 60-char install form", async () => {
    const readme = await fs.readFile(path.join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).not.toMatch(SIXTY_CHAR_FORM);
  });

  it("D-2: AGENTS.md contains no 60-char install form", async () => {
    const agents = await fs.readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
    expect(agents).not.toMatch(SIXTY_CHAR_FORM);
  });

  it("D-3: scripts/check-pinned-spec.sh exits 0 on the current tree", () => {
    const result = spawnSync("bash", [SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK: no unpinned midbrain-memory-mcp references.");
    expect(result.stdout).toContain("OK: no legacy 60-char install-command references.");
  });

  it("D-4: the 60-char regex detects a known offending string", () => {
    // A minimal known-offending string that should trip the new regex block.
    // Pure-regex assertion — avoids filesystem-mutation test flake.
    const offending =
      "npx -y --package=midbrain-memory-mcp@latest midbrain-memory-setup --project /abs/path";
    expect(offending).toMatch(SIXTY_CHAR_FORM);
  });

  it("D-5: legacy prose mention of `midbrain-memory-setup` in AGENTS.md is allowed", async () => {
    const agents = await fs.readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
    // AGENTS.md keeps one legacy-bin compatibility note; confirm it exists
    // but does NOT trip the 60-char regex.
    expect(agents).toContain("midbrain-memory-setup");
    expect(agents).not.toMatch(SIXTY_CHAR_FORM);
  });
});
