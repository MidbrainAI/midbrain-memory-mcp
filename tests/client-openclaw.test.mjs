/**
 * Integration tests for shared/clients/openclaw.mjs against a throwaway home
 * (makeTestEnv). Every read and write lands inside the sandbox; the real-home
 * tripwire covers ~/.openclaw/openclaw.json, the workspace AGENTS.md, the
 * copied plugin under ~/.config/openclaw/midbrain-plugin, and the key file.
 * The `openclaw` CLI is always replaced through _setOpenclawCli, so no test
 * depends on (or runs) a real OpenClaw install.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import JSON5 from "json5";

import { makeTestEnv, assertSandboxed } from "./helpers/test-env.mjs";
import { BaseClient } from "../shared/clients/base.mjs";
import {
  OpenClaw, PLUGIN_ID, _setOpenclawCli,
  openclawConfigPath, openclawStateDir, openclawWorkspaceDir, openclawPluginDir,
} from "../shared/clients/openclaw.mjs";
import { writeGlobalRules, RULES_START } from "../shared/agent-rules.mjs";

const IS_WIN = process.platform === "win32";
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PLUGIN_FILES = ["index.js", "openclaw.plugin.json", "package.json", "midbrain-shared.mjs"];
const USER_SERVER = { command: "node", args: ["/opt/other/server.js"], env: { TOKEN: "user-owned" } };

let env;
let openclaw;
let noCli;

beforeEach(async () => {
  env = await makeTestEnv({ clients: ["openclaw"] });
  openclaw = new OpenClaw();
  noCli = vi.fn();
  _setOpenclawCli({ find: () => null, run: noCli });
});

afterEach(async () => {
  _setOpenclawCli();
  await env.restore();
});

const configFile = () => env.paths.openclawConfig;
const readConfig = async () => JSON5.parse(await fs.readFile(configFile(), "utf8"));
const writeConfigText = async (text) => {
  await fs.mkdir(path.dirname(configFile()), { recursive: true });
  await fs.writeFile(configFile(), text, "utf8");
};

describe("OpenClaw adapter identity, paths and detection", () => {
  it("extends BaseClient with a stable id and display name", () => {
    expect(openclaw).toBeInstanceOf(BaseClient);
    expect(openclaw.id).toBe("openclaw");
    expect(openclaw.displayName).toBe("OpenClaw");
  });

  it("detects ~/.openclaw and has no project config", async () => {
    expect(openclaw.isInstalled()).toBe(true);
    await fs.rm(path.join(env.home, ".openclaw"), { recursive: true });
    expect(openclaw.isInstalled()).toBe(false);
    expect(openclaw.projectConfigFiles("/repo")).toEqual([]);
    await expect(openclaw.installProject("/repo")).resolves.toEqual([]);
  });

  it("resolves the state dir and config from the OpenClaw env overrides", () => {
    expect(openclawStateDir()).toBe(path.join(env.home, ".openclaw"));
    expect(openclawConfigPath()).toBe(path.join(env.home, ".openclaw", "openclaw.json"));

    process.env.OPENCLAW_PROFILE = "work";
    expect(openclawStateDir()).toBe(path.join(env.home, ".openclaw-work"));
    process.env.OPENCLAW_PROFILE = "default";
    expect(openclawStateDir()).toBe(path.join(env.home, ".openclaw"));

    process.env.OPENCLAW_HOME = path.join(env.root, "oc-home");
    expect(openclawStateDir()).toBe(path.join(env.root, "oc-home", ".openclaw"));
    process.env.OPENCLAW_STATE_DIR = path.join(env.root, "state");
    expect(openclawStateDir()).toBe(path.join(env.root, "state"));
    process.env.OPENCLAW_CONFIG_PATH = path.join(env.root, "custom.json");
    expect(openclawConfigPath()).toBe(path.join(env.root, "custom.json"));
  });

  it("resolves the workspace from the env, the config (with ~), or the default", async () => {
    expect(await openclawWorkspaceDir()).toBe(path.join(env.home, ".openclaw", "workspace"));
    await writeConfigText('{ agents: { defaults: { workspace: "~/agent-ws" } } }\n');
    expect(await openclawWorkspaceDir()).toBe(path.join(env.home, "agent-ws"));
    process.env.OPENCLAW_WORKSPACE_DIR = path.join(env.root, "ws");
    expect(await openclawWorkspaceDir()).toBe(path.join(env.root, "ws"));
  });
});

describe("OpenClaw per-client key", () => {
  it("writes ~/.config/openclaw/.midbrain-key through the credential writer and resolves it", async () => {
    const keyPath = path.join(env.home, ".config", "openclaw", ".midbrain-key");
    await assertSandboxed(env, keyPath);

    const line = await openclaw.writeKey("openclaw-secret");

    expect(line).toBe("Key: ~/.config/openclaw/.midbrain-key (chmod 600)");
    expect(await fs.readFile(keyPath, "utf8")).toBe("openclaw-secret\n");
    if (!IS_WIN) expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
    await expect(openclaw.resolveClientKey()).resolves.toEqual({ key: "openclaw-secret", source: keyPath });
  });

  it("resolves null when no client key exists", async () => {
    await expect(openclaw.resolveClientKey()).resolves.toBeNull();
  });
});

describe("OpenClaw.installGlobal", () => {
  it("copies the plugin and writes the MCP entry, load path and enabled plugin entry", async () => {
    const lines = await openclaw.installGlobal();

    const pluginDir = openclawPluginDir();
    await assertSandboxed(env, pluginDir);
    for (const name of PLUGIN_FILES) {
      const source = name === "midbrain-shared.mjs"
        ? path.join(REPO_ROOT, "dist", name)
        : path.join(REPO_ROOT, "plugins", "openclaw", name);
      expect(await fs.readFile(path.join(pluginDir, name), "utf8")).toBe(await fs.readFile(source, "utf8"));
    }

    const config = await readConfig();
    expect(config.mcp.servers["midbrain-memory"]).toEqual({
      command: "npx",
      args: ["-y", "midbrain-memory-mcp@latest"],
      env: { MIDBRAIN_CLIENT: "openclaw" },
    });
    expect(config.plugins.load.paths).toEqual([pluginDir]);
    expect(config.plugins.entries[PLUGIN_ID]).toEqual({ enabled: true, hooks: { allowConversationAccess: true } });
    expect(lines).toEqual([
      "  + Capture plugin installed: ~/.config/openclaw/midbrain-plugin/",
      "  + MCP server added to openclaw.json",
      `  + Plugin "${PLUGIN_ID}" linked and enabled in openclaw.json`,
      "  -> Restart the OpenClaw gateway to load the capture plugin",
    ]);
    expect(noCli).not.toHaveBeenCalled();
  });

  it("creates openclaw.json when OpenClaw has not written one yet", async () => {
    await fs.rm(configFile());
    await openclaw.installGlobal();
    expect((await readConfig()).mcp.servers["midbrain-memory"].env.MIDBRAIN_CLIENT).toBe("openclaw");
  });

  it("--dev writes process.execPath and the checkout index.js", async () => {
    await openclaw.installGlobal({ isDev: true });
    expect((await readConfig()).mcp.servers["midbrain-memory"]).toEqual({
      command: process.execPath,
      args: [path.join(REPO_ROOT, "index.js")],
      env: { MIDBRAIN_CLIENT: "openclaw", MIDBRAIN_DEV: "1" },
    });
  });

  it("is idempotent: a second install reports unchanged and rewrites nothing", async () => {
    await openclaw.installGlobal();
    const before = await fs.stat(configFile());
    const indexBefore = await fs.stat(path.join(openclawPluginDir(), "index.js"));

    const lines = await openclaw.installGlobal();

    expect(lines).toEqual([
      "  = Capture plugin unchanged: ~/.config/openclaw/midbrain-plugin/",
      "  = MCP server unchanged in openclaw.json",
      "  = Plugin entry unchanged in openclaw.json",
    ]);
    expect((await fs.stat(configFile())).mtimeMs).toBe(before.mtimeMs);
    expect((await fs.stat(path.join(openclawPluginDir(), "index.js"))).mtimeMs).toBe(indexBefore.mtimeMs);
  });

  it("keeps comments in a JSONC config and backs it up before changing it", async () => {
    const original = [
      "// my OpenClaw config",
      "{",
      '  "gateway": { "port": 18789 }, // keep me',
      '  "mcp": { "servers": { "other": ' + JSON.stringify(USER_SERVER) + " } },",
      "}",
      "",
    ].join("\n");
    await writeConfigText(original);

    await openclaw.installGlobal();

    const text = await fs.readFile(configFile(), "utf8");
    expect(text).toContain("// my OpenClaw config");
    expect(text).toContain("// keep me");
    expect(await fs.readFile(configFile() + ".bak", "utf8")).toBe(original);
    const config = JSON5.parse(text);
    expect(config.gateway).toEqual({ port: 18789 });
    expect(config.mcp.servers.other).toEqual(USER_SERVER);
    expect(config.mcp.servers["midbrain-memory"].command).toBe("npx");
  });

  it("merges into user-owned load paths and plugin entry settings", async () => {
    await writeConfigText(JSON.stringify({
      plugins: {
        load: { paths: ["/opt/their-plugin"] },
        entries: { [PLUGIN_ID]: { enabled: false, hooks: { allowPromptInjection: false } }, other: { enabled: true } },
      },
    }, null, 2));

    await openclaw.installGlobal();

    const config = await readConfig();
    expect(config.plugins.load.paths).toEqual(["/opt/their-plugin", openclawPluginDir()]);
    expect(config.plugins.entries[PLUGIN_ID]).toEqual({
      enabled: true,
      hooks: { allowPromptInjection: false, allowConversationAccess: true },
    });
    expect(config.plugins.entries.other).toEqual({ enabled: true });
  });

  it("preserves custom env vars and a pinned MidBrain version", async () => {
    await writeConfigText(JSON.stringify({
      mcp: { servers: { "midbrain-memory": { command: "npx", args: ["-y", "midbrain-memory-mcp"], env: { MIDBRAIN_CLIENT: "openclaw", CUSTOM: "1" } } } },
    }));
    await openclaw.installGlobal();
    expect((await readConfig()).mcp.servers["midbrain-memory"].env).toEqual({ CUSTOM: "1", MIDBRAIN_CLIENT: "openclaw" });

    const pinned = { command: "npx", args: ["-y", "midbrain-memory-mcp@0.4.1"], env: { MIDBRAIN_CLIENT: "openclaw" } };
    await writeConfigText(JSON.stringify({ mcp: { servers: { "midbrain-memory": pinned } } }));
    const lines = await openclaw.installGlobal();
    expect((await readConfig()).mcp.servers["midbrain-memory"]).toEqual(pinned);
    expect(lines).toContain("  ~ MCP server: pinned version preserved in openclaw.json");
  });

  it("fails closed on shapes it does not understand, leaving the file untouched", async () => {
    const original = JSON.stringify({ plugins: { load: { paths: "/not/an/array" } } });
    await writeConfigText(original);
    await expect(openclaw.installGlobal()).rejects.toThrow(/plugins\.load\.paths/);
    expect(await fs.readFile(configFile(), "utf8")).toBe(original);
    // validated before anything was written: no half-applied plugin copy
    expect(existsSync(openclawPluginDir())).toBe(false);
  });

  it("fails closed when plugins.load itself is not an object", async () => {
    const original = JSON.stringify({ plugins: { load: "oops" } });
    await writeConfigText(original);
    await expect(openclaw.installGlobal()).rejects.toThrow(/Expected "plugins\.load" to be an object/);
    expect(await fs.readFile(configFile(), "utf8")).toBe(original);
  });

  it("treats an equal entry in a different key order as unchanged", async () => {
    await writeConfigText(JSON.stringify({
      plugins: {
        entries: { [PLUGIN_ID]: { hooks: { allowConversationAccess: true }, enabled: true } },
        load: { paths: [openclawPluginDir()] },
      },
      mcp: { servers: { "midbrain-memory": { env: { MIDBRAIN_CLIENT: "openclaw" }, args: ["-y", "midbrain-memory-mcp@latest"], command: "npx" } } },
    }));
    const before = await fs.stat(configFile());

    const lines = await openclaw.installGlobal();

    expect(lines).toContain("  = MCP server unchanged in openclaw.json");
    expect(lines).toContain("  = Plugin entry unchanged in openclaw.json");
    expect((await fs.stat(configFile())).mtimeMs).toBe(before.mtimeMs);
  });

  describe("JSON5-only syntax (unquoted keys)", () => {
    const JSON5_CONFIG = "// hand-written\n{\n  gateway: { port: 18789 },\n  mcp: { servers: { other: { command: 'node', args: ['/opt/other/server.js'] } } },\n}\n";

    it("uses `openclaw config patch --stdin` when the CLI is on PATH", async () => {
      await writeConfigText(JSON5_CONFIG);
      const run = vi.fn(() => ({ status: 0, stdout: "Applied", stderr: "" }));
      _setOpenclawCli({ find: () => "/usr/local/bin/openclaw", run });

      const lines = await openclaw.installGlobal();

      expect(run).toHaveBeenCalledTimes(1);
      const [cli, args, input] = run.mock.calls[0];
      expect(cli).toBe("/usr/local/bin/openclaw");
      expect(args).toEqual(["config", "patch", "--stdin"]);
      expect(JSON.parse(input)).toEqual({
        mcp: { servers: { "midbrain-memory": { command: "npx", args: ["-y", "midbrain-memory-mcp@latest"], env: { MIDBRAIN_CLIENT: "openclaw" } } } },
        plugins: {
          load: { paths: [openclawPluginDir()] },
          entries: { [PLUGIN_ID]: { enabled: true, hooks: { allowConversationAccess: true } } },
        },
      });
      // OpenClaw owns the write in this mode; the adapter leaves the file alone.
      expect(await fs.readFile(configFile(), "utf8")).toBe(JSON5_CONFIG);
      expect(lines.some((l) => l.includes("openclaw config patch"))).toBe(true);
    });

    it("rewrites instead of patching when a key has to go (a dev entry back to canonical)", async () => {
      await writeConfigText("{\n  mcp: { servers: { 'midbrain-memory': { command: 'node', args: ['/checkout/index.js'], env: { MIDBRAIN_CLIENT: 'openclaw', MIDBRAIN_DEV: '1' } } } },\n}\n");
      const run = vi.fn(() => ({ status: 0, stdout: "Applied", stderr: "" }));
      _setOpenclawCli({ find: () => "/usr/local/bin/openclaw", run });

      const lines = await openclaw.installGlobal();

      // a merge patch cannot remove MIDBRAIN_DEV, so the CLI is not used
      expect(run).not.toHaveBeenCalled();
      const config = JSON.parse(await fs.readFile(configFile(), "utf8"));
      expect(config.mcp.servers["midbrain-memory"]).toEqual({
        command: "npx", args: ["-y", "midbrain-memory-mcp@latest"], env: { MIDBRAIN_CLIENT: "openclaw" },
      });
      expect(lines.some((l) => l.includes("comments not preserved"))).toBe(true);
    });

    it("removes a plugin copy it just made when the CLI patch fails", async () => {
      await writeConfigText(JSON5_CONFIG);
      _setOpenclawCli({ find: () => "/usr/local/bin/openclaw", run: () => ({ status: 1, stdout: "", stderr: "nope" }) });
      await expect(openclaw.installGlobal()).rejects.toThrow("openclaw config patch failed: nope");
      expect(existsSync(openclawPluginDir())).toBe(false);
    });

    it("reports a failed CLI patch", async () => {
      await writeConfigText(JSON5_CONFIG);
      _setOpenclawCli({
        find: () => "/usr/local/bin/openclaw",
        run: () => ({ status: 1, stdout: "", stderr: "noise\nConfig validation failed" }),
      });
      await expect(openclaw.installGlobal()).rejects.toThrow("openclaw config patch failed: Config validation failed");
    });

    it("without the CLI, rewrites the merged config as JSON after a backup", async () => {
      await writeConfigText(JSON5_CONFIG);

      const lines = await openclaw.installGlobal();

      expect(noCli).not.toHaveBeenCalled();
      expect(await fs.readFile(configFile() + ".bak", "utf8")).toBe(JSON5_CONFIG);
      const config = JSON.parse(await fs.readFile(configFile(), "utf8"));
      expect(config.gateway).toEqual({ port: 18789 });
      expect(config.mcp.servers.other).toEqual({ command: "node", args: ["/opt/other/server.js"] });
      expect(config.mcp.servers["midbrain-memory"].env.MIDBRAIN_CLIENT).toBe("openclaw");
      expect(lines.some((l) => l.includes("comments not preserved"))).toBe(true);
    });

    it("rejects a config that is not valid JSON5", async () => {
      await writeConfigText("{ this is not json5");
      await expect(openclaw.installGlobal()).rejects.toThrow(/Failed to parse/);
    });
  });
});

describe("OpenClaw plugin freshness and repair", () => {
  it("is fresh when never installed, and after an install", async () => {
    expect(await openclaw.isFresh()).toBe(true);
    await openclaw.installGlobal();
    expect(await openclaw.isFresh()).toBe(true);
  });

  it("repairs a stale plugin file without touching openclaw.json", async () => {
    await openclaw.installGlobal();
    const configBefore = await fs.readFile(configFile(), "utf8");
    await fs.writeFile(path.join(openclawPluginDir(), "index.js"), "// stale\n", "utf8");
    expect(await openclaw.isFresh()).toBe(false);

    const lines = await openclaw.repairPlugins();

    expect(lines).toEqual(["  ~ OpenClaw capture plugin repaired (re-copied); restart the gateway to load it"]);
    expect(await openclaw.isFresh()).toBe(true);
    expect(await fs.readFile(configFile(), "utf8")).toBe(configBefore);
    expect(await openclaw.repairPlugins()).toEqual([]);
  });

  it("treats an old-version marker as stale", async () => {
    await openclaw.installGlobal();
    await fs.writeFile(path.join(openclawPluginDir(), ".midbrain-repo-root"), "midbrain-memory-mcp@0.0.1\n", "utf8");
    expect(await openclaw.isFresh()).toBe(false);
  });

  it("keeps a --dev install pinned: always fresh, never repaired", async () => {
    await openclaw.installGlobal({ isDev: true });
    await fs.writeFile(path.join(openclawPluginDir(), "index.js"), "// local edit\n", "utf8");
    expect(await openclaw.isFresh()).toBe(true);
    expect(await openclaw.repairPlugins()).toEqual([]);
    expect(await fs.readFile(path.join(openclawPluginDir(), "index.js"), "utf8")).toBe("// local edit\n");
  });
});

describe("OpenClaw global rules (workspace AGENTS.md)", () => {
  it("adds the managed block to the workspace AGENTS.md OpenClaw created", async () => {
    await fs.mkdir(path.dirname(env.paths.openclawAgents), { recursive: true });
    await fs.writeFile(env.paths.openclawAgents, "# AGENTS.md - Your Workspace\n", "utf8");

    const results = await writeGlobalRules({ clients: ["openclaw"], homeDir: env.home });

    expect(results).toEqual([expect.objectContaining({ path: env.paths.openclawAgents, action: "created" })]);
    const text = await fs.readFile(env.paths.openclawAgents, "utf8");
    expect(text.startsWith("# AGENTS.md - Your Workspace\n")).toBe(true);
    expect(text).toContain(RULES_START);
    expect(text).toContain("- OpenClaw: MidBrain tools are `midbrain-memory__*`");
  });

  it("does not create AGENTS.md before OpenClaw seeds its workspace", async () => {
    await expect(writeGlobalRules({ clients: ["openclaw"], homeDir: env.home })).resolves.toEqual([]);
    await expect(fs.access(env.paths.openclawAgents)).rejects.toThrow();
  });

  it("follows agents.defaults.workspace from openclaw.json", async () => {
    await writeConfigText('{ agents: { defaults: { workspace: "~/my-ws" } } }\n');
    const agents = path.join(env.home, "my-ws", "AGENTS.md");
    await fs.mkdir(path.dirname(agents), { recursive: true });
    await fs.writeFile(agents, "# rules\n", "utf8");

    const results = await writeGlobalRules({ clients: ["openclaw"], homeDir: env.home });

    expect(results.map((r) => r.path)).toEqual([agents]);
  });
});
