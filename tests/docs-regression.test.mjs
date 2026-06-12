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
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "check-pinned-spec.sh");

// Match the grep regex inside scripts/check-pinned-spec.sh exactly.
// Extended regex: npx.*--package=midbrain-memory-mcp[^space]*[space]+midbrain-memory-setup
const SIXTY_CHAR_FORM =
  /npx.*--package=midbrain-memory-mcp\S*\s+midbrain-memory-setup/;

function toolNamesFromMcp(source) {
  return [...source.matchAll(/server\.tool\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

function toolNamesFromReadme(readme) {
  const section = readme.split("### MCP Tools")[1].split("## Per-Project Memory")[0];
  return [...section.matchAll(/\| `([^`]+)` \|/g)].map((match) => match[1]);
}

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

  it("D-6: mixed line with allowed install form + bare unpinned reference is detected", () => {
    // A line containing the allowed "midbrain-memory-mcp install" form AND an
    // unsafe bare "midbrain-memory-mcp" reference. The guard must catch the
    // unsafe part — it must not forgive the whole line.
    const mixed =
      'Run `npx midbrain-memory-mcp install`; MCP config: `npx -y midbrain-memory-mcp`';

    // Strip the allowed install tokens (mirrors check-pinned-spec.sh logic).
    const stripped = mixed.replace(
      /midbrain-memory-mcp\s+install([^a-zA-Z0-9_-]|$)/g,
      "REDACTED_INSTALL$1",
    );
    // The residual must still match the bare-package regex.
    const bareRegex = /midbrain-memory-mcp([^@a-zA-Z0-9_/.-]|$)/;
    expect(stripped).toMatch(bareRegex);
  });

  it("D-7: README.md and AGENTS.md contain no deprecated codex_hooks docs", async () => {
    const readme = await fs.readFile(path.join(REPO_ROOT, "README.md"), "utf8");
    const agents = await fs.readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
    expect(readme).not.toContain("codex_hooks");
    expect(agents).not.toContain("codex_hooks");
  });

  it("D-8: npm package dry-run includes Codex runtime and excludes task/test files", () => {
    const cacheDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "midbrain-npm-cache-"));
    try {
      const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, npm_config_cache: cacheDir },
        timeout: 10000,
      });
      expect(result.status).toBe(0);
      const [{ files }] = JSON.parse(result.stdout);
      const names = files.map((file) => file.path);
      expect(names).toContain("plugins/codex/common.mjs");
      expect(names).toContain("plugins/codex/capture-user.mjs");
      expect(names).not.toContain("tests/codex-hooks.test.mjs");
      expect(names.some((name) => name.startsWith("tasks/"))).toBe(false);
      expect(names.some((name) => name.includes(".midbrain-key"))).toBe(false);
    } finally {
      fsSync.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("D-9: README MCP tool table matches the seven-tool server surface", async () => {
    const readme = await fs.readFile(path.join(REPO_ROOT, "README.md"), "utf8");
    const mcp = await fs.readFile(path.join(REPO_ROOT, "mcp.mjs"), "utf8");
    const readmeTools = toolNamesFromReadme(readme).sort();
    const serverTools = toolNamesFromMcp(mcp).sort();

    expect(serverTools).toHaveLength(7);
    expect(readmeTools).toEqual(serverTools);
    expect(readmeTools).not.toContain("procedural_knowledge");
  });

  it("D-10: memory rules do not instruct agents to call removed procedural_knowledge", async () => {
    const readme = await fs.readFile(path.join(REPO_ROOT, "README.md"), "utf8");
    const agents = await fs.readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf8");

    expect(readme).not.toContain("Use procedural_knowledge");
    expect(agents).not.toContain("Use procedural_knowledge");
  });

  it("D-11: README documents the procedural search endpoint, not the removed list endpoint", async () => {
    const readme = await fs.readFile(path.join(REPO_ROOT, "README.md"), "utf8");

    expect(readme).toContain("/api/v1/memories/search/procedural");
    expect(readme).not.toContain("/api/v1/memories/procedural");
  });
});
