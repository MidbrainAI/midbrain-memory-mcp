/**
 * Server-side API-host construction and static-endpoint migration tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import { createApi } from "../mcp.mjs";
import { makeTestEnv } from "./helpers/test-env.mjs";

describe("mcp createApi API-host binding", () => {
  let env;
  let projectDir;

  beforeEach(async () => {
    env = await makeTestEnv();
    projectDir = path.join(env.root, "project");
    await fs.mkdir(path.join(projectDir, ".midbrain"), { recursive: true });
    process.env.MIDBRAIN_CLIENT = "opencode";
  });

  afterEach(async () => {
    await env.restore();
  });

  it("passes the real project directory to key and host resolution", async () => {
    await fs.writeFile(
      path.join(projectDir, ".midbrain", ".midbrain-key"),
      "project-test-key\n",
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(projectDir, ".midbrain", "config.json"),
      JSON.stringify({ apiUrl: "http://127.0.0.1:43123/" }),
      "utf8",
    );
    process.env.MIDBRAIN_PROJECT_DIR = projectDir;

    const api = await createApi();
    expect(api.keyScope).toBe("project");
    expect(api.apiBaseScope).toBe("project");
    expect(api.effectiveApiBase).toBe("http://127.0.0.1:43123");
  });

  it("filters an unresolved TERMINAL_CWD placeholder", async () => {
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    await fs.mkdir(path.join(env.home, ".config", "midbrain"), { recursive: true });
    await fs.writeFile(
      path.join(env.home, ".config", "midbrain", ".midbrain-key"),
      "global-test-key\n",
      { mode: 0o600 },
    );
    await fs.writeFile(
      path.join(env.home, ".config", "midbrain", "config.json"),
      JSON.stringify({
        clients: { opencode: { apiUrl: "http://127.0.0.1:43124" } },
      }),
      "utf8",
    );
    process.env.MIDBRAIN_PROJECT_DIR = "${TERMINAL_CWD}";

    const api = await createApi();
    expect(api.keyScope).toBe("global");
    expect(api.apiBaseScope).toBe("client");
    expect(api.effectiveApiBase).toBe("http://127.0.0.1:43124");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("TERMINAL_CWD"));
    warning.mockRestore();
  });

  it("has no server call site using static endpoint getters", async () => {
    const source = await fs.readFile(
      new URL("../mcp.mjs", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /MidbrainApi\.(SEARCH_SEMANTIC|SEARCH_LEXICAL|EPISODIC|SEMANTIC_FILES|PROCEDURAL)/,
    );
  });
});
