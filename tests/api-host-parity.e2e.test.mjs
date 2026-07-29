/**
 * Two-process parity proof for MCP and the built OpenCode runtime bundle.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeTestEnv } from "./helpers/test-env.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGGER_SOURCE = `({
  info() {},
  debug() {},
  warn() {},
  error() {},
})`;

function mcpScript() {
  return `
    import { createApi } from "./mcp.mjs";
    const api = await createApi();
    await api.fetch(api.SEARCH_SEMANTIC, { query: "mcp-read" });
    await api.storeEpisodic("mcp-write", "user", ${LOGGER_SOURCE});
    process.stdout.write(JSON.stringify({
      host: api.effectiveApiBase,
      scope: api.apiBaseScope,
    }));
  `;
}

function pluginScript(projectDir) {
  return `
    import { MidbrainApi, getClient } from "./dist/midbrain-shared.mjs";
    const api = await MidbrainApi.create(getClient("opencode"), ${JSON.stringify(projectDir)});
    await api.fetch(api.SEARCH_SEMANTIC, { query: "plugin-read" });
    await api.storeEpisodic("plugin-write", "user", ${LOGGER_SOURCE});
    process.stdout.write(JSON.stringify({
      host: api.effectiveApiBase,
      scope: api.apiBaseScope,
    }));
  `;
}

function runChild(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`child exited ${code}\nstdout=${stdout}\nstderr=${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function startStub(requests) {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        host: request.headers.host,
        body,
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(request.method === "GET" ? "[]" : "{}");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

describe("API-host MCP/capture parity", () => {
  let env;
  let projectDir;
  let server;
  let requests;

  beforeEach(async () => {
    env = await makeTestEnv();
    projectDir = path.join(env.root, "project");
    await fs.mkdir(path.join(projectDir, ".midbrain"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, ".midbrain", ".midbrain-key"),
      "parity-test-key\n",
      { mode: 0o600 },
    );
    requests = [];
    server = await startStub(requests);
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await env.restore();
  });

  it("routes MCP and built-bundle capture reads/writes to the same host", async () => {
    const address = server.address();
    const apiBase = `http://127.0.0.1:${address.port}`;
    await fs.writeFile(
      path.join(projectDir, ".midbrain", "config.json"),
      JSON.stringify({ apiUrl: apiBase }),
      "utf8",
    );
    const childEnv = env.childEnv({
      MIDBRAIN_CLIENT: "opencode",
      MIDBRAIN_PROJECT_DIR: projectDir,
      MIDBRAIN_API_URL: undefined,
    });
    delete childEnv.MIDBRAIN_API_URL;

    const [mcp, plugin] = await Promise.all([
      runChild(mcpScript(), childEnv),
      runChild(pluginScript(projectDir), childEnv),
    ]);
    expect(JSON.parse(mcp.stdout)).toEqual({ host: apiBase, scope: "project" });
    expect(JSON.parse(plugin.stdout)).toEqual({ host: apiBase, scope: "project" });
    expect(requests).toHaveLength(4);
    expect(new Set(requests.map((request) => request.host)))
      .toEqual(new Set([`127.0.0.1:${address.port}`]));
    expect(requests.map((request) => request.method).sort())
      .toEqual(["GET", "GET", "POST", "POST"]);
    expect(requests.map((request) => request.path))
      .toEqual(expect.arrayContaining([
        "/api/v1/memories/search/semantic?query=mcp-read",
        "/api/v1/memories/search/semantic?query=plugin-read",
        "/api/v1/memories/episodic",
      ]));
  });

  it.each([
    ["unset", undefined],
    ["an unresolved TERMINAL_CWD placeholder", "${TERMINAL_CWD}"],
  ])(
    "keeps B13 parity when the server project directory is %s and the plugin has a real directory",
    async (_label, serverProjectDir) => {
      const address = server.address();
      const apiBase = `http://127.0.0.1:${address.port}`;
      const globalDir = path.join(env.home, ".config", "midbrain");
      await fs.rm(path.join(projectDir, ".midbrain", ".midbrain-key"));
      await fs.mkdir(globalDir, { recursive: true });
      await fs.writeFile(
        path.join(globalDir, ".midbrain-key"),
        "parity-global-key\n",
        { mode: 0o600 },
      );
      await fs.writeFile(
        path.join(globalDir, "config.json"),
        JSON.stringify({ apiUrl: apiBase }),
        "utf8",
      );
      await fs.writeFile(
        path.join(projectDir, ".midbrain", "config.json"),
        JSON.stringify({ apiUrl: "https://project-host-must-be-skipped.invalid" }),
        "utf8",
      );

      const baseEnv = env.childEnv({
        MIDBRAIN_CLIENT: "opencode",
        MIDBRAIN_API_URL: undefined,
      });
      delete baseEnv.MIDBRAIN_API_URL;
      const serverEnv = { ...baseEnv };
      if (serverProjectDir === undefined) {
        delete serverEnv.MIDBRAIN_PROJECT_DIR;
      } else {
        serverEnv.MIDBRAIN_PROJECT_DIR = serverProjectDir;
      }
      const pluginEnv = { ...baseEnv };
      delete pluginEnv.MIDBRAIN_PROJECT_DIR;

      const [mcp, plugin] = await Promise.all([
        runChild(mcpScript(), serverEnv),
        runChild(pluginScript(projectDir), pluginEnv),
      ]);
      expect(JSON.parse(mcp.stdout)).toEqual({ host: apiBase, scope: "global" });
      expect(JSON.parse(plugin.stdout)).toEqual({ host: apiBase, scope: "global" });
      expect(plugin.stderr).toContain("project apiUrl ignored");
      if (serverProjectDir) {
        expect(mcp.stderr).toContain("TERMINAL_CWD");
      }
      expect(requests).toHaveLength(4);
      expect(new Set(requests.map((request) => request.host)))
        .toEqual(new Set([`127.0.0.1:${address.port}`]));
      expect(requests.map((request) => request.method).sort())
        .toEqual(["GET", "GET", "POST", "POST"]);
    },
  );

  it("records host and scope in the OpenCode INIT log", async () => {
    const source = await fs.readFile(
      path.join(REPO_ROOT, "plugins", "opencode", "midbrain-memory.ts"),
      "utf8",
    );
    expect(source).toContain("host=${api.effectiveApiBase}");
    expect(source).toContain("scope=${api.apiBaseScope}");
  });
});
