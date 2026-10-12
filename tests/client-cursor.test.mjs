/**
 * Integration tests for shared/clients/cursor.mjs against a throwaway home
 * (makeTestEnv). Every read and write lands inside the sandbox; the real-home
 * tripwire covers ~/.cursor/mcp.json, ~/.cursor/hooks.json, the cursor-hook
 * shim, and ~/.config/cursor/.midbrain-key.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";

import { makeTestEnv, assertSandboxed, diffSnapshots } from "./helpers/test-env.mjs";
import { BaseClient } from "../shared/clients/base.mjs";
import { Cursor } from "../shared/clients/cursor.mjs";
import { buildShimBody, stableShimPath } from "../shared/clients/shim.mjs";

const IS_WIN = process.platform === "win32";
const EVENTS = { beforeSubmitPrompt: "user", postToolUse: "tool", afterAgentResponse: "assistant" };
const USER_SERVER = { command: "node", args: ["/opt/other/server.js"], env: { TOKEN: "user-owned" } };

let env;
let cursor;

beforeEach(async () => {
  env = await makeTestEnv({ clients: ["cursor"] });
  cursor = new Cursor();
});

afterEach(async () => {
  await env.restore();
});

const shimCommand = (role) => `'${stableShimPath("cursor")}' ${role}`;
const readJsonFile = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJsonFile = async (file, data) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
};
const commands = (data, event) => (data.hooks[event] || []).map((h) => h.command);

describe("Cursor adapter identity and detection", () => {
  it("extends BaseClient with a stable id and display name", () => {
    expect(cursor).toBeInstanceOf(BaseClient);
    expect(cursor.id).toBe("cursor");
    expect(cursor.displayName).toBe("Cursor");
  });

  it("detects ~/.cursor and reports only the project MCP file", async () => {
    expect(cursor.isInstalled()).toBe(true);
    await fs.rm(path.join(env.home, ".cursor"), { recursive: true });
    expect(cursor.isInstalled()).toBe(false);
    expect(cursor.projectConfigFiles("/repo")).toEqual([".cursor/mcp.json"]);
  });
});

describe("Cursor per-client key", () => {
  it("writes ~/.config/cursor/.midbrain-key through the credential writer and resolves it", async () => {
    const keyPath = path.join(env.home, ".config", "cursor", ".midbrain-key");
    await assertSandboxed(env, keyPath);

    const line = await cursor.writeKey("cursor-secret");

    expect(line).toBe("Key: ~/.config/cursor/.midbrain-key (chmod 600)");
    expect(await fs.readFile(keyPath, "utf8")).toBe("cursor-secret\n");
    if (!IS_WIN) expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
    await expect(cursor.resolveClientKey()).resolves.toEqual({ key: "cursor-secret", source: keyPath });
  });

  it("resolves null when no client key exists", async () => {
    await expect(cursor.resolveClientKey()).resolves.toBeNull();
  });
});

describe("Cursor.installGlobal", () => {
  it("writes the npx @latest MCP entry, stable shim hooks, and the shim", async () => {
    const lines = await cursor.installGlobal();

    const mcp = await readJsonFile(env.paths.cursorMcp);
    expect(mcp.mcpServers["midbrain-memory"]).toEqual({
      command: "npx",
      args: ["-y", "midbrain-memory-mcp@latest"],
      env: { MIDBRAIN_CLIENT: "cursor" },
    });

    const hooks = await readJsonFile(env.paths.cursorHooks);
    expect(hooks.version).toBe(1);
    for (const [event, role] of Object.entries(EVENTS)) {
      expect(hooks.hooks[event]).toEqual([{ command: shimCommand(role), timeout: 10 }]);
    }
    expect(JSON.stringify(hooks)).not.toMatch(/MIDBRAIN_API_KEY|midbrain-key|node_modules|_npx/);

    expect(await fs.readFile(env.paths.cursorShim, "utf8")).toBe(buildShimBody("cursor"));
    if (!IS_WIN) expect((await fs.stat(env.paths.cursorShim)).mode & 0o111).not.toBe(0);
    expect(lines.join("\n")).toContain("~/.cursor/hooks.json");
    expect(lines.join("\n")).toMatch(/Restart Cursor/);
    expect(await cursor.isFresh()).toBe(true);
  });

  it("--dev writes process.execPath and the checkout index.js", async () => {
    await cursor.installGlobal({ isDev: true });

    const entry = (await readJsonFile(env.paths.cursorMcp)).mcpServers["midbrain-memory"];
    expect(entry.command).toBe(process.execPath);
    expect(path.isAbsolute(entry.args[0])).toBe(true);
    expect(entry.args[0]).toMatch(/index\.js$/);
    expect(entry.env.MIDBRAIN_DEV).toBe("1");
  });

  it("merges into user-owned mcp.json servers and hooks without disturbing them", async () => {
    await writeJsonFile(env.paths.cursorMcp, {
      mcpServers: { other: USER_SERVER },
      someSetting: true,
    });
    await writeJsonFile(env.paths.cursorHooks, {
      version: 1,
      hooks: {
        beforeSubmitPrompt: [{ command: "./hooks/audit.sh", timeout: 5 }],
        beforeShellExecution: [{ command: "./hooks/block-git.sh" }],
      },
    });

    await cursor.installGlobal();

    const mcp = await readJsonFile(env.paths.cursorMcp);
    expect(mcp.mcpServers.other).toEqual(USER_SERVER);
    expect(mcp.someSetting).toBe(true);
    const hooks = await readJsonFile(env.paths.cursorHooks);
    expect(hooks.hooks.beforeSubmitPrompt).toEqual([
      { command: "./hooks/audit.sh", timeout: 5 },
      { command: shimCommand("user"), timeout: 10 },
    ]);
    expect(hooks.hooks.beforeShellExecution).toEqual([{ command: "./hooks/block-git.sh" }]);
  });

  it("backs up existing mcp.json and hooks.json before changing them", async () => {
    const originalMcp = { mcpServers: { other: USER_SERVER } };
    const originalHooks = { version: 1, hooks: {} };
    await writeJsonFile(env.paths.cursorMcp, originalMcp);
    await writeJsonFile(env.paths.cursorHooks, originalHooks);

    await cursor.installGlobal();

    expect(await readJsonFile(`${env.paths.cursorMcp}.bak`)).toEqual(originalMcp);
    expect(await readJsonFile(`${env.paths.cursorHooks}.bak`)).toEqual(originalHooks);
  });

  it("is idempotent: a second install changes no file content or mtime", async () => {
    await writeJsonFile(env.paths.cursorMcp, { mcpServers: { other: USER_SERVER } });
    await cursor.installGlobal();
    const before = await env.snapshot();

    await cursor.installGlobal();

    expect(diffSnapshots(before, await env.snapshot())).toEqual([]);
  });

  it("reports each file as changed on first install and unchanged on a second install", async () => {
    const first = await cursor.installGlobal();
    expect(first).toEqual([
      "~/.cursor/mcp.json: midbrain-memory entry added",
      "~/.cursor/hooks.json: MidBrain hooks written",
      "~/.midbrain/bin/cursor-hook: stable Cursor hook shim written",
      "Restart Cursor (or reload the window) so it picks up the MCP server and hooks.",
    ]);

    const second = await cursor.installGlobal();
    expect(second).toEqual([
      "~/.cursor/mcp.json: midbrain-memory entry unchanged",
      "~/.cursor/hooks.json: MidBrain hooks unchanged",
      "~/.midbrain/bin/cursor-hook: stable Cursor hook shim unchanged",
    ]);
  });

  it("installProject reports an unchanged project mcp.json on a second run", async () => {
    const project = path.join(env.root, "project");
    const configFile = path.join(project, ".cursor", "mcp.json");
    expect(await cursor.installProject(project)).toEqual([`${configFile}: midbrain-memory entry added`]);
    expect(await cursor.installProject(project)).toEqual([`${configFile}: midbrain-memory entry unchanged`]);
  });

  it("preserves custom env vars and drops reserved ones from the MidBrain entry", async () => {
    await writeJsonFile(env.paths.cursorMcp, {
      mcpServers: {
        "midbrain-memory": {
          command: "npx",
          args: ["-y", "midbrain-memory-mcp"],
          env: { CUSTOM_VAR: "keep", MIDBRAIN_PROJECT_DIR: "/old" },
        },
      },
    });

    const lines = await cursor.installGlobal();

    const entry = (await readJsonFile(env.paths.cursorMcp)).mcpServers["midbrain-memory"];
    expect(entry.args).toEqual(["-y", "midbrain-memory-mcp@latest"]);
    expect(entry.env).toEqual({ CUSTOM_VAR: "keep", MIDBRAIN_CLIENT: "cursor" });
    expect(lines[0]).toContain("midbrain-memory updated");
  });

  it("preserves a pinned MidBrain version", async () => {
    const pinned = { command: "npx", args: ["-y", "midbrain-memory-mcp@1.2.3"] };
    await writeJsonFile(env.paths.cursorMcp, { mcpServers: { "midbrain-memory": pinned } });

    const lines = await cursor.installGlobal();

    expect((await readJsonFile(env.paths.cursorMcp)).mcpServers["midbrain-memory"]).toEqual(pinned);
    expect(lines.some((line) => line.includes("pinned version preserved"))).toBe(true);
  });

  it.each([
    ["unparseable mcp.json", "cursorMcp", "{ not json"],
    ["non-object mcpServers", "cursorMcp", JSON.stringify({ mcpServers: [] })],
    ["unparseable hooks.json", "cursorHooks", "{ not json"],
    ["non-array hook event", "cursorHooks", JSON.stringify({ hooks: { beforeSubmitPrompt: { command: "x" } } })],
  ])("fails closed on %s without writing either file", async (_label, key, content) => {
    await fs.mkdir(path.dirname(env.paths[key]), { recursive: true });
    await fs.writeFile(env.paths[key], content, "utf8");
    const before = await env.snapshot();

    await expect(cursor.installGlobal()).rejects.toThrow();

    expect(diffSnapshots(before, await env.snapshot())).toEqual([]);
  });
});

describe("Cursor hook ownership, freshness, and repair", () => {
  beforeEach(async () => {
    await cursor.installGlobal();
  });

  it("dedupes every owned form to one canonical entry and keeps user hooks in order", async () => {
    const wrapper = `'${path.join(env.home, ".midbrain", "bin", "cursor-hook-wrapper")}' user`;
    const nearName = "/usr/local/bin/midbrain-memory-mcp-wrapper hook cursor user";
    const data = await readJsonFile(env.paths.cursorHooks);
    data.hooks.beforeSubmitPrompt = [
      { command: wrapper },
      { command: "~/.midbrain/bin/cursor-hook user", timeout: 30 },
      { command: nearName },
      { command: "npx -y midbrain-memory-mcp@latest hook cursor user" },
      { command: "node /work/midbrain-memory-mcp/index.js hook cursor user" },
      { command: shimCommand("user"), timeout: 10 },
    ];
    await writeJsonFile(env.paths.cursorHooks, data);

    expect(await cursor.isFresh()).toBe(false);
    const lines = await cursor.repairHooks();

    expect(lines.join("\n")).toContain("Cursor hooks repaired");
    const after = await readJsonFile(env.paths.cursorHooks);
    expect(commands(after, "beforeSubmitPrompt")).toEqual([wrapper, nearName, shimCommand("user")]);
    expect(await cursor.isFresh()).toBe(true);
  });

  it("never claims another client's shim", async () => {
    const codexShim = `'${stableShimPath("codex")}' user`;
    const data = await readJsonFile(env.paths.cursorHooks);
    data.hooks.beforeSubmitPrompt.unshift({ command: codexShim });
    await writeJsonFile(env.paths.cursorHooks, data);

    await cursor.installGlobal();

    expect(commands(await readJsonFile(env.paths.cursorHooks), "beforeSubmitPrompt"))
      .toEqual([codexShim, shimCommand("user")]);
  });

  it("isFresh is true when no MidBrain hooks are installed", async () => {
    await writeJsonFile(env.paths.cursorHooks, { version: 1, hooks: { stop: [{ command: "./a.sh" }] } });
    expect(await cursor.isFresh()).toBe(true);
  });

  it("repair reinstalls a stale shim without touching hooks.json", async () => {
    await fs.writeFile(env.paths.cursorShim, "#!/bin/sh\n/old/stale hook\n", "utf8");
    const hooksStat = await fs.stat(env.paths.cursorHooks);
    expect(await cursor.isFresh()).toBe(false);

    await cursor.repairHooks();

    expect(await fs.readFile(env.paths.cursorShim, "utf8")).toBe(buildShimBody("cursor"));
    expect((await fs.stat(env.paths.cursorHooks)).mtimeMs).toBe(hooksStat.mtimeMs);
    expect(await cursor.isFresh()).toBe(true);
  });

  it("repair skips an unreadable hooks.json (fail open, no write)", async () => {
    await fs.writeFile(env.paths.cursorHooks, "{ broken", "utf8");
    const before = await env.snapshot();

    await expect(cursor.repairHooks()).resolves.toEqual([]);
    expect(diffSnapshots(before, await env.snapshot())).toEqual([]);
  });
});

describe("Cursor.installProject", () => {
  it("writes <project>/.cursor/mcp.json with MIDBRAIN_PROJECT_DIR and no project hooks", async () => {
    const project = path.join(env.root, "project");
    await writeJsonFile(path.join(project, ".cursor", "mcp.json"), { mcpServers: { other: USER_SERVER } });

    const lines = await cursor.installProject(project);

    const mcp = await readJsonFile(path.join(project, ".cursor", "mcp.json"));
    expect(mcp.mcpServers.other).toEqual(USER_SERVER);
    expect(mcp.mcpServers["midbrain-memory"].env).toEqual({
      MIDBRAIN_CLIENT: "cursor",
      MIDBRAIN_PROJECT_DIR: project,
    });
    await expect(fs.stat(path.join(project, ".cursor", "hooks.json"))).rejects.toThrow();
    expect(lines[0]).toContain("midbrain-memory entry added");
  });
});
