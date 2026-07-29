/**
 * Unit tests for the unified API-host resolver.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import { makeTestEnv } from "./helpers/test-env.mjs";
import {
  DEFAULT_API_BASE,
  resolveApiHost,
} from "../shared/api-host.mjs";

describe("resolveApiHost", () => {
  let env;
  let projectDir;
  let projectConfig;
  let globalConfig;
  let warn;

  beforeEach(async () => {
    env = await makeTestEnv();
    projectDir = path.join(env.root, "project");
    projectConfig = path.join(projectDir, ".midbrain", "config.json");
    globalConfig = path.join(env.home, ".config", "midbrain", "config.json");
    await fs.mkdir(path.dirname(projectConfig), { recursive: true });
    await fs.mkdir(path.dirname(globalConfig), { recursive: true });
    warn = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await env.restore();
  });

  async function writeJson(filePath, value) {
    await fs.writeFile(filePath, JSON.stringify(value), "utf8");
  }

  it("uses the production default when no override exists", async () => {
    await expect(resolveApiHost({
      clientId: "opencode",
      projectDir,
      keyScope: "project",
    })).resolves.toEqual({
      url: DEFAULT_API_BASE,
      source: "default",
      scope: "default",
    });
  });

  it("applies environment > project > client > global precedence", async () => {
    await writeJson(projectConfig, { apiUrl: "https://project.example/" });
    await writeJson(globalConfig, {
      apiUrl: "https://global.example/",
      clients: { opencode: { apiUrl: "https://client.example/" } },
    });

    process.env.MIDBRAIN_API_URL = "  https://env.example///  ";
    await expect(resolveApiHost({
      clientId: "opencode",
      projectDir,
      keyScope: "project",
    })).resolves.toMatchObject({
      url: "https://env.example",
      scope: "environment",
      source: "env:MIDBRAIN_API_URL",
    });

    delete process.env.MIDBRAIN_API_URL;
    await expect(resolveApiHost({
      clientId: "opencode",
      projectDir,
      keyScope: "project",
    })).resolves.toMatchObject({
      url: "https://project.example",
      scope: "project",
      source: projectConfig,
    });

    await fs.rm(projectConfig);
    await expect(resolveApiHost({
      clientId: "opencode",
      projectDir,
      keyScope: "project",
    })).resolves.toMatchObject({
      url: "https://client.example",
      scope: "client",
      source: globalConfig,
    });

    await writeJson(globalConfig, { apiUrl: "https://global.example/" });
    await expect(resolveApiHost({
      clientId: "opencode",
      projectDir,
      keyScope: "project",
    })).resolves.toMatchObject({
      url: "https://global.example",
      scope: "global",
      source: globalConfig,
    });
  });

  it("uses MIDBRAIN_PROJECT_DIR only when no explicit project is supplied", async () => {
    const envProject = path.join(env.root, "env-project");
    const envConfig = path.join(envProject, ".midbrain", "config.json");
    await fs.mkdir(path.dirname(envConfig), { recursive: true });
    await writeJson(envConfig, { apiUrl: "https://env-project.example" });
    process.env.MIDBRAIN_PROJECT_DIR = envProject;

    await expect(resolveApiHost({
      clientId: "opencode",
      keyScope: "project",
    })).resolves.toMatchObject({
      url: "https://env-project.example",
      source: envConfig,
      scope: "project",
    });
  });

  it("skips an unresolved TERMINAL_CWD placeholder", async () => {
    process.env.MIDBRAIN_PROJECT_DIR = "${TERMINAL_CWD}";
    await writeJson(globalConfig, { apiUrl: "https://global.example" });

    await expect(resolveApiHost({
      clientId: "hermes",
      keyScope: "global",
    })).resolves.toMatchObject({
      url: "https://global.example",
      scope: "global",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("TERMINAL_CWD"));
  });

  it("rejects invalid values and an /api/v1 suffix, then continues", async () => {
    process.env.MIDBRAIN_API_URL = "ftp://invalid.example";
    await writeJson(projectConfig, { apiUrl: "https://project.example/api/v1/" });
    await writeJson(globalConfig, {
      clients: { opencode: { apiUrl: "https://client.example/" } },
    });

    await expect(resolveApiHost({
      clientId: "opencode",
      projectDir,
      keyScope: "project",
    })).resolves.toMatchObject({
      url: "https://client.example",
      scope: "client",
    });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("env:MIDBRAIN_API_URL");
    expect(warn.mock.calls[1][0]).toContain(`${projectConfig} apiUrl`);
    expect(warn.mock.calls[1][0]).toContain("/api/v1");
  });

  it("warns once for a non-string field without exposing its contents", async () => {
    await writeJson(projectConfig, {
      apiUrl: { password: "do-not-print" },
    });
    await writeJson(globalConfig, { apiUrl: "https://global.example" });

    await expect(resolveApiHost({
      clientId: "opencode",
      projectDir,
      keyScope: "project",
    })).resolves.toMatchObject({ scope: "global" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(`${projectConfig} apiUrl`);
    expect(warn.mock.calls[0][0]).toContain("object");
    expect(warn.mock.calls[0][0]).not.toContain("do-not-print");
  });

  it("warns once for corrupt JSON and continues", async () => {
    await fs.writeFile(projectConfig, "{not json", "utf8");
    await writeJson(globalConfig, { apiUrl: "https://global.example" });

    await expect(resolveApiHost({
      clientId: "opencode",
      projectDir,
      keyScope: "project",
    })).resolves.toMatchObject({ scope: "global" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(projectConfig);
    expect(warn.mock.calls[0][0]).toContain("could not be read");
  });

  it("ignores a project host unless the credential is project-scoped", async () => {
    await writeJson(projectConfig, { apiUrl: "https://attacker.example" });
    await writeJson(globalConfig, { apiUrl: "https://global.example" });

    await expect(resolveApiHost({
      clientId: "opencode",
      projectDir,
      keyScope: "global",
    })).resolves.toMatchObject({
      url: "https://global.example",
      scope: "global",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(
      "project apiUrl ignored: credential resolves at global",
    );
    expect(warn.mock.calls[0][0]).not.toContain("attacker.example");
  });
});
