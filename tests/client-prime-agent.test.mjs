/**
 * Integration tests for shared/clients/prime-agent.mjs against a throwaway
 * home (makeTestEnv). Every read and write lands inside the sandbox; the
 * real-home tripwire covers ~/.prime/agent/settings.json and AGENTS.md, the
 * copied skill, the stable shim and the key file.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";

import { makeTestEnv } from "./helpers/test-env.mjs";
import { BaseClient } from "../shared/clients/base.mjs";
import {
  PrimeAgent, primeAgentDir, primeSessionsDir, primeSkillDir, captureEnabledAt,
} from "../shared/clients/prime-agent.mjs";
import { PLUGIN_MARKER_VALUE } from "../shared/clients/utils.mjs";
import { writeGlobalRules, writeProjectRules, RULES_START } from "../shared/agent-rules.mjs";

const IS_WIN = process.platform === "win32";
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SKILL_FILES = ["SKILL.md", "pyproject.toml", path.join("src", "midbrain_memory", "__init__.py")];
const USER_SERVER = { type: "stdio", command: "python3", args: ["/opt/other.py"], env: { TOKEN: { env: "OTHER_TOKEN" } } };

let env;
let prime;

beforeEach(async () => {
  env = await makeTestEnv({ clients: ["prime-agent"] });
  prime = new PrimeAgent();
});

afterEach(async () => {
  await env.restore();
});

const settingsFile = () => env.paths.primeSettings;
const readSettings = async () => JSON.parse(await fs.readFile(settingsFile(), "utf8"));
const writeSettings = async (data) => {
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), typeof data === "string" ? data : JSON.stringify(data, null, 2), "utf8");
};
const entryScript = (entry) => entry.args[1];

describe("Prime Agent adapter identity, paths and detection", () => {
  it("extends BaseClient with a stable id and display name", () => {
    expect(prime).toBeInstanceOf(BaseClient);
    expect(prime.id).toBe("prime-agent");
    expect(prime.displayName).toBe("Prime Agent");
    expect(prime.projectConfigFiles("/repo")).toEqual([".prime/agent/settings.json"]);
  });

  it("detects the agent dir, honoring PRIME_AGENT_CODING_AGENT_DIR", async () => {
    expect(prime.isInstalled()).toBe(true);
    await fs.rm(env.paths.primeAgentDir, { recursive: true });
    expect(prime.isInstalled()).toBe(false);

    process.env.PRIME_AGENT_CODING_AGENT_DIR = path.join(env.root, "agent");
    expect(primeAgentDir()).toBe(path.join(env.root, "agent"));
    expect(primeSkillDir()).toBe(path.join(env.root, "agent", "skills", "midbrain-memory"));
    process.env.PRIME_AGENT_CODING_AGENT_DIR = "~/custom-agent";
    expect(primeAgentDir()).toBe(path.join(env.home, "custom-agent"));
  });

  it("resolves the sessions dir from env, then the sessionDir setting, then the default", async () => {
    expect(await primeSessionsDir()).toBe(path.join(env.paths.primeAgentDir, "sessions"));
    await writeSettings({ sessionDir: "~/prime-sessions" });
    expect(await primeSessionsDir()).toBe(path.join(env.home, "prime-sessions"));
    await writeSettings({ sessionDir: "logs" });
    expect(await primeSessionsDir()).toBe(path.join(env.paths.primeAgentDir, "logs"));
    process.env.PRIME_AGENT_CODING_AGENT_SESSION_DIR = path.join(env.root, "legacy");
    expect(await primeSessionsDir()).toBe(path.join(env.root, "legacy"));
    process.env.PRIME_AGENT_SESSION_DIR = path.join(env.root, "sessions");
    expect(await primeSessionsDir()).toBe(path.join(env.root, "sessions"));
  });
});

describe.skipIf(IS_WIN)("installGlobal", () => {
  it("adds a /bin/sh MCP entry bound to the session directory, plus skill, shim and enable marker", async () => {
    const summary = await prime.installGlobal();

    const entry = (await readSettings()).mcpServers["midbrain-memory"];
    expect(entry).toEqual({
      type: "stdio",
      command: "/bin/sh",
      args: ["-c", 'MIDBRAIN_CLIENT=prime-agent MIDBRAIN_PROJECT_DIR="$PWD" exec npx -y midbrain-memory-mcp@latest'],
      startupTimeoutMs: 60000,
    });
    for (const name of SKILL_FILES) {
      const source = await fs.readFile(path.join(REPO_ROOT, "plugins", "prime-agent", "skill", name), "utf8");
      expect(await fs.readFile(path.join(env.paths.primeSkill, name), "utf8")).toBe(source);
    }
    expect((await fs.readFile(path.join(env.paths.primeSkill, ".midbrain-repo-root"), "utf8")).trim()).toBe(PLUGIN_MARKER_VALUE);
    const shim = await fs.readFile(env.paths.primeShim, "utf8");
    expect(shim).toContain("npx -y midbrain-memory-mcp@latest hook prime-agent \"$@\"");
    expect(await captureEnabledAt()).toBeTypeOf("number");
    expect(summary.join("\n")).toMatch(/entry added[\s\S]*capture skill installed[\s\S]*shim written[\s\S]*New Prime Agent sessions/);
  });

  it("keeps other servers, settings and the user's entry options; a rerun is a no-op", async () => {
    await writeSettings({
      defaultModel: "openai/gpt-5",
      mcpServers: {
        other: USER_SERVER,
        "midbrain-memory": { type: "stdio", command: "npx", args: ["old"], enabled: false, disabledTools: ["grep"] },
      },
    });
    await prime.installGlobal();
    const settings = await readSettings();
    expect(settings.defaultModel).toBe("openai/gpt-5");
    expect(settings.mcpServers.other).toEqual(USER_SERVER);
    expect(settings.mcpServers["midbrain-memory"]).toMatchObject({ command: "/bin/sh", enabled: false, disabledTools: ["grep"] });
    expect(existsSync(`${settingsFile()}.bak`)).toBe(true);

    const before = await env.snapshot();
    const summary = await prime.installGlobal();
    expect(await env.snapshot()).toEqual(before);
    expect(summary.join("\n")).toMatch(/entry unchanged[\s\S]*skill unchanged[\s\S]*shim unchanged/);
    expect(summary.join("\n")).not.toMatch(/New Prime Agent sessions/);
  });

  it("preserves a pinned entry", async () => {
    const pinned = { type: "stdio", command: "/bin/sh", args: ["-c", "exec npx -y midbrain-memory-mcp@0.4.9"] };
    await writeSettings({ mcpServers: { "midbrain-memory": pinned } });
    const summary = await prime.installGlobal();
    expect((await readSettings()).mcpServers["midbrain-memory"]).toEqual(pinned);
    expect(summary[0]).toMatch(/pinned version preserved/);
  });

  it("dev install runs the checkout's index.js with MIDBRAIN_DEV and a dev marker", async () => {
    await prime.installGlobal({ isDev: true });
    const script = entryScript((await readSettings()).mcpServers["midbrain-memory"]);
    expect(script).toContain("MIDBRAIN_DEV=1");
    expect(script).toContain(`'${path.join(REPO_ROOT, "index.js")}'`);
    expect(await fs.readFile(path.join(env.paths.primeSkill, ".midbrain-repo-root"), "utf8")).toMatch(/-dev\n$/);
  });

  it.each([
    ["not JSON", "{ nope"],
    ["not an object", "[1, 2]"],
    ["mcpServers not an object", JSON.stringify({ mcpServers: [] })],
  ])("fails closed when settings.json is %s, writing nothing", async (_label, text) => {
    await writeSettings(text);
    await expect(prime.installGlobal()).rejects.toThrow();
    expect(await fs.readFile(settingsFile(), "utf8")).toBe(text);
    expect(existsSync(env.paths.primeSkill)).toBe(false);
    expect(existsSync(env.paths.primeShim)).toBe(false);
  });

  it("never moves the enable marker forward on a reinstall", async () => {
    await prime.installGlobal();
    const first = await captureEnabledAt();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await prime.installGlobal();
    expect(await captureEnabledAt()).toBe(first);
  });
});

describe.skipIf(IS_WIN)("installProject", () => {
  it("writes the project settings with the project directory bound literally", async () => {
    const project = path.join(env.root, "it's a repo");
    await fs.mkdir(project, { recursive: true });
    const lines = await prime.installProject(project);
    const file = path.join(project, ".prime", "agent", "settings.json");
    const entry = JSON.parse(await fs.readFile(file, "utf8")).mcpServers["midbrain-memory"];
    expect(entryScript(entry)).toBe(`MIDBRAIN_CLIENT=prime-agent MIDBRAIN_PROJECT_DIR='${project.replace(/'/g, "'\\''")}' exec npx -y midbrain-memory-mcp@latest`);
    expect(lines[0]).toMatch(/entry added/);
    expect(existsSync(env.paths.primeSkill)).toBe(false);
  });
});

describe.skipIf(IS_WIN)("isFresh and repairPlugins", () => {
  it("is fresh before any install and right after one", async () => {
    expect(await prime.isFresh()).toBe(true);
    await prime.installGlobal();
    expect(await prime.isFresh()).toBe(true);
  });

  it("re-copies a stale skill file and shim without touching settings.json", async () => {
    await prime.installGlobal();
    const settings = await fs.readFile(settingsFile(), "utf8");
    await fs.writeFile(path.join(env.paths.primeSkill, "SKILL.md"), "stale\n", "utf8");
    await fs.rm(env.paths.primeShim);
    expect(await prime.isFresh()).toBe(false);

    expect(await prime.repairPlugins()).toEqual(["  ~ Prime Agent capture skill repaired; new sessions load it"]);
    expect(await prime.isFresh()).toBe(true);
    expect(await fs.readFile(settingsFile(), "utf8")).toBe(settings);
    expect(await prime.repairPlugins()).toEqual([]);
  });

  it("never repairs a dev-pinned skill, nor installs one that was never installed", async () => {
    expect(await prime.repairPlugins()).toEqual([]);
    expect(existsSync(env.paths.primeSkill)).toBe(false);

    await prime.installGlobal({ isDev: true });
    await fs.writeFile(path.join(env.paths.primeSkill, "SKILL.md"), "local edit\n", "utf8");
    expect(await prime.isFresh()).toBe(true);
    expect(await prime.repairPlugins()).toEqual([]);
    expect(await fs.readFile(path.join(env.paths.primeSkill, "SKILL.md"), "utf8")).toBe("local edit\n");
  });
});

describe("keys", () => {
  it("writes and resolves the per-client key", async () => {
    expect(await prime.resolveClientKey()).toBeNull();
    expect(await prime.writeKey("mb-test-key")).toBe("Key: ~/.config/prime-agent/.midbrain-key (chmod 600)");
    const keyPath = path.join(env.home, ".config", "prime-agent", ".midbrain-key");
    expect(await prime.resolveClientKey()).toEqual({ key: "mb-test-key", source: keyPath });
    if (!IS_WIN) expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
  });
});

describe("rules", () => {
  it("writes the Prime Agent block into the agent dir's AGENTS.md", async () => {
    const [result] = await writeGlobalRules({ clients: ["prime-agent"], homeDir: env.home });
    const agentsPath = path.join(env.paths.primeAgentDir, "AGENTS.md");
    expect(result).toEqual({ action: "created", path: agentsPath });
    const content = await fs.readFile(agentsPath, "utf8");
    expect(content.startsWith(RULES_START)).toBe(true);
    expect(content).toContain('await mcp.call_tool("midbrain-memory", "<tool>", {...})');
    expect(content).toContain("await midbrain_memory(query)");
  });

  it("uses the Prime Agent block in project AGENTS.md only when no other AGENTS.md client is present", async () => {
    const project = path.join(env.root, "proj");
    await fs.mkdir(project, { recursive: true });
    await writeProjectRules(project, { clients: ["prime-agent"] });
    expect(await fs.readFile(path.join(project, "AGENTS.md"), "utf8")).toContain("- Prime Agent:");

    const shared = path.join(env.root, "shared");
    await fs.mkdir(shared, { recursive: true });
    await writeProjectRules(shared, { clients: ["prime-agent", "codex"] });
    const content = await fs.readFile(path.join(shared, "AGENTS.md"), "utf8");
    expect(content).toContain("- Codex/OpenCode:");
    expect(content).not.toContain("- Prime Agent:");
  });
});
