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
const NANOCLAW_SKILL = path.join(REPO_ROOT, "skills", "nanoclaw", "SKILL.md");

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
      expect(names).toContain("skills/nanoclaw/SKILL.md");
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

  it("D-12: docs describe PK trust metadata and payload limits", async () => {
    const readme = await fs.readFile(path.join(REPO_ROOT, "README.md"), "utf8");
    const agents = await fs.readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf8");

    for (const doc of [readme, agents]) {
      expect(doc).toContain("ctx-meta nonce");
      expect(doc).toContain("signature");
      expect(doc).toContain("160");
      expect(doc).toContain("2,000");
      expect(doc).toContain("6,000");
    }
  });

  it("D-13: installer/client config writers do not set the PK opt-in flag", async () => {
    const configSources = [
      "install.mjs",
      "shared/clients/claude.mjs",
      "shared/clients/codex.mjs",
      "shared/clients/opencode.mjs",
      "shared/clients/nanoclaw.mjs",
    ];

    for (const sourcePath of configSources) {
      const source = await fs.readFile(path.join(REPO_ROOT, sourcePath), "utf8");
      expect(source).not.toContain("MIDBRAIN_ENABLE_PK_INJECTION");
    }
  });

  it("D-14: current docs describe automatic PK injection as disabled by default", async () => {
    const docs = [
      await fs.readFile(path.join(REPO_ROOT, "README.md"), "utf8"),
      await fs.readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf8"),
      await fs.readFile(path.join(REPO_ROOT, "CLAUDE.md"), "utf8"),
      await fs.readFile(NANOCLAW_SKILL, "utf8"),
    ];

    for (const doc of docs) {
      expect(doc).toMatch(/Procedural knowledge is not injected automatically|Automatic procedural-knowledge injection is disabled by default/i);
      expect(doc).toContain("MIDBRAIN_ENABLE_PK_INJECTION=1");
      expect(doc).not.toMatch(/procedural knowledge \(PK\) is injected automatically/i);
      expect(doc).not.toMatch(/Procedural knowledge is injected automatically by MidBrain hooks/i);
    }
  });

  it("D-15: NanoClaw skill is present in the repo", () => {
    expect(fsSync.existsSync(NANOCLAW_SKILL)).toBe(true);
  });

  it("D-16: NanoClaw docs do not claim entrypoint bootstrapping as v1 design", async () => {
    const docs = await readNanoClawDocs();
    expect(docs).not.toMatch(/entrypoint/i);
    expect(docs).not.toMatch(/every container boot/i);
  });

  it("D-17: NanoClaw docs agree on direct mounted settings merge", async () => {
    const { readme, agents, skill } = await readNanoClawDocParts();
    for (const text of [readme, agents, skill]) {
      expect(text).toContain(".claude-shared/settings.json");
      expect(text).toMatch(/direct/i);
      expect(text).toMatch(/settings merge|merge.*settings/i);
    }
  });

  it("D-18: NanoClaw skill requires group choice when multiple groups exist", async () => {
    const skill = await fs.readFile(NANOCLAW_SKILL, "utf8");
    expect(skill).toMatch(/multiple agent groups/i);
    expect(skill).toMatch(/ask.*choose|choose.*group/i);
    expect(skill).not.toMatch(/jq -r '\.\[0\]\.id'/);
  });

  it("D-17: NanoClaw skill tells agents to redact inline hook API keys", async () => {
    const skill = await fs.readFile(NANOCLAW_SKILL, "utf8");
    expect(skill).toMatch(/inline/i);
    expect(skill).toMatch(/MIDBRAIN_API_KEY/);
    expect(skill).toMatch(/redact/i);
  });

  it("D-18: NanoClaw hooks use npx @latest rather than versioned package paths", async () => {
    const { readme, skill } = await readNanoClawDocParts();
    for (const text of [readme, skill]) {
      expect(text).toContain("midbrain-memory-mcp@latest hook claude user");
      expect(text).toContain("midbrain-memory-mcp@latest hook claude assistant");
      expect(text).not.toMatch(/MIDBRAIN_API_KEY=<redacted>.*capture-user\.mjs/);
      expect(text).not.toMatch(/MIDBRAIN_API_KEY=<redacted>.*capture-assistant\.mjs/);
    }
    expect(readme).not.toContain('"MIDBRAIN_API_KEY": "your-key"');
  });

  it("D-19: NanoClaw setup does not install MidBrain as a pinned image package", async () => {
    const skill = await fs.readFile(NANOCLAW_SKILL, "utf8");
    expect(skill).not.toContain("install_packages({ npm: [\"midbrain-memory-mcp@latest\"]");
    expect(skill).not.toMatch(/packages installed/i);
  });

  it("D-20: Codex docs describe the stable hook shim and trust caveat", async () => {
    const readme = await fs.readFile(path.join(REPO_ROOT, "README.md"), "utf8");
    const agents = await fs.readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf8");
    for (const text of [readme, agents]) {
      expect(text).toContain("~/.midbrain/bin/codex-hook");
      expect(text).toMatch(/\/hooks/);
    }
    expect(readme).toMatch(/trust.*shim|shim.*trust/i);
    expect(readme).not.toMatch(/hooks\.json[\s\S]{0,300}plugins\/codex\/capture-user\.mjs/);
  });

  it("D-21: awaited hook paths do not promise fire-and-forget timing", async () => {
    const readme = await fs.readFile(path.join(REPO_ROOT, "README.md"), "utf8");
    const claudeUserHook = await fs.readFile(
      path.join(REPO_ROOT, "plugins", "claude-code", "capture-user.mjs"),
      "utf8",
    );
    const claudeAssistantHook = await fs.readFile(
      path.join(REPO_ROOT, "plugins", "claude-code", "capture-assistant.mjs"),
      "utf8",
    );

    expect(readme).not.toMatch(/\*\*Capture\*\*[\s\S]{0,120}fire-and-forget, never blocks/i);
    expect(readme).not.toMatch(/capture must be fire-and-forget and must not\s+block/i);
    expect(claudeUserHook).not.toMatch(/capture never blocks the turn/i);
    expect(claudeAssistantHook).not.toMatch(/exits immediately if stop_hook_active/i);
  });
});

async function readNanoClawDocParts() {
  return {
    readme: await fs.readFile(path.join(REPO_ROOT, "README.md"), "utf8"),
    agents: await fs.readFile(path.join(REPO_ROOT, "AGENTS.md"), "utf8"),
    skill: await fs.readFile(NANOCLAW_SKILL, "utf8"),
  };
}

async function readNanoClawDocs() {
  const { readme, agents, skill } = await readNanoClawDocParts();
  return [readme, agents, skill].join("\n");
}
