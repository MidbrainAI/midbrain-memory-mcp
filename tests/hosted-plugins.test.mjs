/**
 * Static checks for hosted-plugins/: the Claude and ChatGPT bundles that point
 * hosted assistants at MidBrain's hosted MCP endpoint.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hosted-plugins");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const HOSTED_MCP_URL = "https://memory.midbrain.ai/api/mcp";

describe("hosted plugins", () => {
  it("ship one memory-first skill in both bundles", () => {
    const claude = read("claude/skills/memory-first/SKILL.md");
    expect(read("chatgpt/skills/memory-first/SKILL.md")).toBe(claude);
    expect(claude).toMatch(/^---\nname: memory-first\ndescription: .+\n---\n/);
  });

  it("point both bundles at the hosted MCP endpoint", () => {
    expect(json("claude/.mcp.json")).toEqual({ mcpServers: { midbrain: { type: "http", url: HOSTED_MCP_URL } } });
    expect(json("chatgpt/.mcp.json")).toEqual({ mcpServers: { midbrain: { url: HOSTED_MCP_URL } } });
  });

  it("keep names and versions in step across manifests", () => {
    const claude = json("claude/.claude-plugin/plugin.json");
    const codex = json("chatgpt/.codex-plugin/plugin.json");
    expect(new Set([claude.name, codex.name])).toEqual(new Set(["midbrain-memory"]));
    expect(codex.version).toBe(claude.version);
    const skillVersion = read("claude/skills/memory-first/SKILL.md").match(/Bundle version: (\S+)\./)[1];
    expect(skillVersion).toBe(claude.version);
  });

  it("give ChatGPT every file and review field its manifest references", () => {
    const codex = json("chatgpt/.codex-plugin/plugin.json");
    expect(codex.skills).toBe("./skills");
    expect(codex.mcpServers).toBe("./.mcp.json");
    for (const rel of [codex.interface.composerIcon, codex.interface.logo]) expect(existsSync(path.join(ROOT, "chatgpt", rel))).toBe(true);
    for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
      expect(codex.interface[key]).toMatch(/^https:\/\//);
    }
    const cases = codex.extensions["com.openai"].review.test_cases;
    expect([cases.positive.length, cases.negative.length]).toEqual([5, 3]);
  });
});
