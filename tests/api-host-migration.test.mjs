/**
 * Cross-client migration coverage for reserved MIDBRAIN_API_URL entry env.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import { OpenCode } from "../shared/clients/opencode.mjs";
import { Claude } from "../shared/clients/claude.mjs";
import { Codex } from "../shared/clients/codex.mjs";
import { Hermes } from "../shared/clients/hermes.mjs";
import {
  RESERVED_ENV_KEYS,
  extractCustomEnv,
  migrateReservedHostEnv,
} from "../shared/clients/utils.mjs";
import { makeTestEnv } from "./helpers/test-env.mjs";

const HOST = "http://127.0.0.1:43123";
const OTHER_HOST = "http://127.0.0.1:43124";
const MCP_KEY = "midbrain-memory";

describe("MIDBRAIN_API_URL reservation and migration", () => {
  let env;
  let projectDir;

  beforeEach(async () => {
    env = await makeTestEnv({
      clients: ["opencode", "claude", "codex", "hermes"],
    });
    projectDir = path.join(env.root, "project");
    await fs.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await env.restore();
  });

  async function readJson(filePath) {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  }

  async function hostConfig(filePath) {
    return readJson(filePath);
  }

  it("reserves MIDBRAIN_API_URL while preserving unrelated custom env", () => {
    expect(RESERVED_ENV_KEYS.has("MIDBRAIN_API_URL")).toBe(true);
    expect(extractCustomEnv({
      env: {
        MIDBRAIN_API_URL: HOST,
        HTTP_PROXY: "http://proxy.example",
      },
    }, "env")).toEqual({ HTTP_PROXY: "http://proxy.example" });
  });

  it("uses the existing file value on conflict and reports both locations", async () => {
    const target = path.join(env.home, ".config", "midbrain", "config.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify({
      clients: { opencode: { apiUrl: OTHER_HOST } },
    }), "utf8");
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});

    const lines = await migrateReservedHostEnv(
      { MIDBRAIN_API_URL: HOST },
      { clientId: "opencode", source: "opencode.json" },
    );

    expect((await hostConfig(target)).clients.opencode.apiUrl).toBe(OTHER_HOST);
    expect(lines.join("\n")).toContain("file value wins");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("opencode.json"));
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(target));
    warning.mockRestore();
  });

  it.each([
    ["clients array", { clients: [] }],
    ["client entry array", { clients: { opencode: [] } }],
  ])("repairs a malformed %s without dropping the migrated host", async (_label, initial) => {
    const target = path.join(env.home, ".config", "midbrain", "config.json");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(initial), "utf8");

    const lines = await migrateReservedHostEnv(
      { MIDBRAIN_API_URL: HOST },
      { clientId: "opencode", source: "opencode.json" },
    );

    expect((await hostConfig(target)).clients.opencode.apiUrl).toBe(HOST);
    expect(lines.join("\n")).toContain("MIDBRAIN_API_URL migrated");
  });

  it("migrates both OpenCode rebuild sites scope-preservingly", async () => {
    await fs.writeFile(env.paths.opencodeConfig, JSON.stringify({
      mcp: {
        [MCP_KEY]: {
          type: "local",
          command: ["npx", "-y", "midbrain-memory-mcp@latest"],
          environment: { MIDBRAIN_API_URL: HOST, KEEP: "global" },
        },
      },
    }), "utf8");
    const globalLines = await new OpenCode().installGlobal();
    const globalEntry = (await readJson(env.paths.opencodeConfig)).mcp[MCP_KEY];
    const globalHost = await hostConfig(
      path.join(env.home, ".config", "midbrain", "config.json"),
    );
    expect(globalEntry.environment).toMatchObject({ KEEP: "global" });
    expect(globalEntry.environment).not.toHaveProperty("MIDBRAIN_API_URL");
    expect(globalHost.clients.opencode.apiUrl).toBe(HOST);
    expect(globalLines.join("\n")).toContain("MIDBRAIN_API_URL");

    const projectConfig = path.join(projectDir, "opencode.json");
    await fs.writeFile(projectConfig, JSON.stringify({
      mcp: {
        [MCP_KEY]: {
          command: ["npx", "-y", "midbrain-memory-mcp@latest"],
          environment: { MIDBRAIN_API_URL: OTHER_HOST },
        },
      },
    }), "utf8");
    await new OpenCode().installProject(projectDir);
    expect((await readJson(projectConfig)).mcp[MCP_KEY].environment)
      .not.toHaveProperty("MIDBRAIN_API_URL");
    expect((await hostConfig(
      path.join(projectDir, ".midbrain", "config.json"),
    )).apiUrl).toBe(OTHER_HOST);
  });

  it("migrates all three Claude rebuild sites", async () => {
    await fs.writeFile(env.paths.claudeJson, JSON.stringify({
      mcpServers: {
        [MCP_KEY]: {
          command: "npx",
          args: ["-y", "midbrain-memory-mcp@latest"],
          env: { MIDBRAIN_API_URL: HOST },
        },
      },
    }), "utf8");
    await new Claude().installGlobal();
    expect((await readJson(env.paths.claudeJson)).mcpServers[MCP_KEY].env)
      .not.toHaveProperty("MIDBRAIN_API_URL");
    expect((await hostConfig(
      path.join(env.home, ".config", "midbrain", "config.json"),
    )).clients.claude.apiUrl).toBe(HOST);

    const mcpJson = path.join(projectDir, ".mcp.json");
    await fs.writeFile(mcpJson, JSON.stringify({
      mcpServers: {
        [MCP_KEY]: {
          command: "npx",
          args: ["-y", "midbrain-memory-mcp@latest"],
          env: { MIDBRAIN_API_URL: OTHER_HOST },
        },
      },
    }), "utf8");
    await fs.writeFile(env.paths.claudeJson, JSON.stringify({
      projects: {
        [projectDir]: {
          mcpServers: {
            [MCP_KEY]: {
              command: "npx",
              args: ["-y", "midbrain-memory-mcp@latest"],
              env: { MIDBRAIN_API_URL: OTHER_HOST },
            },
          },
        },
      },
    }), "utf8");
    await new Claude().installProject(projectDir);
    expect((await readJson(mcpJson)).mcpServers[MCP_KEY].env)
      .not.toHaveProperty("MIDBRAIN_API_URL");
    expect((await readJson(env.paths.claudeJson))
      .projects[projectDir].mcpServers[MCP_KEY].env)
      .not.toHaveProperty("MIDBRAIN_API_URL");
    expect((await hostConfig(
      path.join(projectDir, ".midbrain", "config.json"),
    )).apiUrl).toBe(OTHER_HOST);
  });

  it("migrates Codex global and project installs through its shared site", async () => {
    await fs.writeFile(
      env.paths.codexConfig,
      `[mcp_servers.${MCP_KEY}]\ncommand = "npx"\n` +
      `args = ["-y", "midbrain-memory-mcp@latest"]\n` +
      `[mcp_servers.${MCP_KEY}.env]\nMIDBRAIN_API_URL = "${HOST}"\n`,
      "utf8",
    );
    await new Codex().installGlobal();
    expect(parseToml(await fs.readFile(env.paths.codexConfig, "utf8"))
      .mcp_servers[MCP_KEY].env).not.toHaveProperty("MIDBRAIN_API_URL");
    expect((await hostConfig(
      path.join(env.home, ".config", "midbrain", "config.json"),
    )).clients.codex.apiUrl).toBe(HOST);

    const projectConfig = path.join(projectDir, ".codex", "config.toml");
    await fs.mkdir(path.dirname(projectConfig), { recursive: true });
    await fs.writeFile(
      projectConfig,
      `[mcp_servers.${MCP_KEY}]\ncommand = "npx"\n` +
      `args = ["-y", "midbrain-memory-mcp@latest"]\n` +
      `[mcp_servers.${MCP_KEY}.env]\nMIDBRAIN_API_URL = "${OTHER_HOST}"\n`,
      "utf8",
    );
    await new Codex().installProject(projectDir);
    expect(parseToml(await fs.readFile(projectConfig, "utf8"))
      .mcp_servers[MCP_KEY].env).not.toHaveProperty("MIDBRAIN_API_URL");
    expect((await hostConfig(
      path.join(projectDir, ".midbrain", "config.json"),
    )).apiUrl).toBe(OTHER_HOST);
  });

  it("migrates Hermes global and project installs through its shared site", async () => {
    await fs.writeFile(
      env.paths.hermesConfig,
      `mcp_servers:\n  ${MCP_KEY}:\n    command: npx\n` +
      `    args: [-y, midbrain-memory-mcp@latest]\n` +
      `    env:\n      MIDBRAIN_API_URL: ${HOST}\n`,
      "utf8",
    );
    await new Hermes().installGlobal();
    expect(parseYaml(await fs.readFile(env.paths.hermesConfig, "utf8"))
      .mcp_servers[MCP_KEY].env).not.toHaveProperty("MIDBRAIN_API_URL");
    expect((await hostConfig(
      path.join(env.home, ".config", "midbrain", "config.json"),
    )).clients.hermes.apiUrl).toBe(HOST);

    await fs.writeFile(
      env.paths.hermesConfig,
      `mcp_servers:\n  ${MCP_KEY}:\n    command: npx\n` +
      `    args: [-y, midbrain-memory-mcp@latest]\n` +
      `    env:\n      MIDBRAIN_API_URL: ${OTHER_HOST}\n`,
      "utf8",
    );
    await new Hermes().installProject(projectDir);
    expect(parseYaml(await fs.readFile(env.paths.hermesConfig, "utf8"))
      .mcp_servers[MCP_KEY].env).not.toHaveProperty("MIDBRAIN_API_URL");
    expect((await hostConfig(
      path.join(projectDir, ".midbrain", "config.json"),
    )).apiUrl).toBe(OTHER_HOST);
  });

  it("keeps a pinned entry host env and emits the residual warning", async () => {
    await fs.writeFile(env.paths.opencodeConfig, JSON.stringify({
      mcp: {
        [MCP_KEY]: {
          command: ["npx", "-y", "midbrain-memory-mcp@1.2.3"],
          environment: { MIDBRAIN_API_URL: HOST },
        },
      },
    }), "utf8");

    const lines = await new OpenCode().installGlobal();
    expect((await readJson(env.paths.opencodeConfig))
      .mcp[MCP_KEY].environment.MIDBRAIN_API_URL).toBe(HOST);
    expect(lines.join("\n")).toContain(
      "pinned entry retains MIDBRAIN_API_URL",
    );
  });
});
