/**
 * Static checks for hosted-plugins/: the Claude and ChatGPT bundles that point
 * hosted assistants at MidBrain's hosted MCP endpoint.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
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

  it("point Claude at the hosted MCP endpoint", () => {
    expect(json("claude/.mcp.json")).toEqual({ mcpServers: { midbrain: { type: "http", url: HOSTED_MCP_URL } } });
  });

  it("keep names and versions in step across manifests", () => {
    const claude = json("claude/.claude-plugin/plugin.json");
    const chatgpt = json("chatgpt/plugin.json");
    const codex = json("chatgpt/.codex-plugin/plugin.json");
    expect(new Set([claude.name, chatgpt.name, codex.name])).toEqual(new Set(["midbrain-memory"]));
    expect(new Set([claude.version, chatgpt.version, codex.version]).size).toBe(1);
    const skillVersion = read("claude/skills/memory-first/SKILL.md").match(/Bundle version: (\S+)\./)[1];
    expect(skillVersion).toBe(claude.version);
    expect(chatgpt.extensions["com.openai"].apps).toBe("./.app.json");
    expect(codex.apps).toBe("./.app.json");
    expect(codex.skills).toBe("./skills");
  });

  it("link ChatGPT to exactly one app", () => {
    const apps = Object.values(json("chatgpt/.app.json").apps);
    expect(apps).toHaveLength(1);
    expect(apps[0].id).toMatch(/^asdk_app_/);
  });
});
