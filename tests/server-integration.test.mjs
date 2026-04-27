/**
 * Integration tests for the MCP server (server.js).
 *
 * Self-contained: creates an in-process MCP server via createServer(),
 * connects a Client through InMemoryTransport (no child process, no stdio),
 * and mocks globalThis.fetch to simulate API responses.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parse as jsoncParse } from "jsonc-parser";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "fs";
import os from "os";
import path from "path";

import { createServer } from "../server.js";

const __filename = fileURLToPath(import.meta.url);
const SERVER_PATH = path.resolve(path.dirname(__filename), "..", "server.js");

// ---------------------------------------------------------------------------
// Mock API response data
// ---------------------------------------------------------------------------

const MOCK_DATA = {
  searchSemantic: [
    {
      id: 1,
      role: "user",
      text: "How do I set up the project?",
      memory_metadata: {},
      score: 0.95,
      occurred_at: "2025-06-01T10:30:00Z",
    },
    {
      id: 2,
      role: "external",
      text: "Project setup instructions from docs",
      memory_metadata: { source: "docs/setup.md", line_start: 1 },
      score: 0.88,
      occurred_at: "2025-05-15T08:00:00Z",
    },
    {
      id: 3,
      role: "assistant",
      text: "You can set up the project by running npm install",
      memory_metadata: {},
      score: 0.82,
      occurred_at: "2025-06-01T10:31:00Z",
    },
  ],
  searchLexical: [
    { source: "docs/setup.md", line_number: 12, text: "npm install midbrain-memory-mcp" },
    { source: "docs/setup.md", line_number: 45, text: "npm run setup" },
  ],
  episodicList: {
    items: [
      { role: "user", text: "What did we discuss?", occurred_at: "2025-06-01T14:00:00Z" },
      { role: "assistant", text: "We discussed the API design.", occurred_at: "2025-06-01T13:59:00Z" },
    ],
    total: 2,
    page: 1,
    limit: 1000,
  },
  filesList: [
    { source: "docs/setup.md", chunk_count: 5 },
    { source: "docs/api.md", chunk_count: 12 },
  ],
  readFile: {
    path: "docs/setup.md",
    start_line: 1,
    content: "1: # Setup Guide\n2: Install with npm.",
    chunks_used: 1,
  },
};

/** Build a fake Response object matching the fetch() API. */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Route fetch calls by URL path, return mock responses. */
function mockFetch(url, _opts) {
  const parsed = new URL(url);
  const p = parsed.pathname;

  if (p === "/api/v1/memories/search/semantic") {
    const query = parsed.searchParams.get("query");
    if (query === "__empty__") return Promise.resolve(jsonResponse([]));
    if (query === "__only_episodic__") {
      // Return only user/assistant (episodic) results — no external/semantic
      return Promise.resolve(jsonResponse([
        MOCK_DATA.searchSemantic[0], // user
        MOCK_DATA.searchSemantic[2], // assistant
      ]));
    }
    if (query === "__server_error__") {
      return Promise.resolve(jsonResponse({ detail: "Internal server error" }, 500));
    }
    return Promise.resolve(jsonResponse(MOCK_DATA.searchSemantic));
  }
  if (p === "/api/v1/memories/search/lexical") {
    const pattern = parsed.searchParams.get("pattern");
    if (pattern === "[invalid") {
      return Promise.resolve(jsonResponse({ detail: "Invalid regex pattern" }, 400));
    }
    if (pattern === "__empty__") return Promise.resolve(jsonResponse([]));
    if (pattern === "__server_error__") {
      return Promise.resolve(jsonResponse({ detail: "Internal server error" }, 500));
    }
    return Promise.resolve(jsonResponse(MOCK_DATA.searchLexical));
  }
  if (p === "/api/v1/memories/episodic") {
    const startDate = parsed.searchParams.get("start_date") || "";
    if (startDate.startsWith("1999")) {
      return Promise.resolve(jsonResponse({ items: [], total: 0, page: 1, limit: 1000 }));
    }
    if (startDate.startsWith("2020")) {
      // Return truncated result: total > items.length
      return Promise.resolve(jsonResponse({
        items: [
          { role: "user", text: "First message", occurred_at: "2020-01-01T10:00:00Z" },
        ],
        total: 50,
        page: 1,
        limit: 1000,
      }));
    }
    return Promise.resolve(jsonResponse(MOCK_DATA.episodicList));
  }
  if (p === "/api/v1/memories/semantic/files") {
    return Promise.resolve(jsonResponse(MOCK_DATA.filesList));
  }
  if (p.startsWith("/api/v1/memories/semantic/files/")) {
    const filePath = decodeURIComponent(p.replace("/api/v1/memories/semantic/files/", ""));
    if (filePath === "nonexistent.md") {
      return Promise.resolve(jsonResponse({ detail: "Not found" }, 404));
    }
    return Promise.resolve(jsonResponse(MOCK_DATA.readFile));
  }
  return Promise.resolve(jsonResponse({ detail: "Not found" }, 404));
}

// ---------------------------------------------------------------------------
// In-process MCP setup
// ---------------------------------------------------------------------------

let client;
let clientTransport;
let serverTransport;
let tmpKeyDir;
let fetchSpy;
const savedEnv = {};

beforeAll(async () => {
  // Mock fetch before any tool calls
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(mockFetch);

  // Create a temp API key file
  tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-test-"));
  const keyPath = path.join(tmpKeyDir, ".midbrain-key");
  fs.writeFileSync(keyPath, "test-key-for-mcp-tests\n", "utf8");
  fs.chmodSync(keyPath, 0o600);

  // Set env vars for the in-process server
  for (const k of ["MIDBRAIN_CONFIG_DIR", "MIDBRAIN_PROJECT_DIR"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.MIDBRAIN_CONFIG_DIR = tmpKeyDir;
  process.env.MIDBRAIN_PROJECT_DIR = "";

  // Create linked in-memory transport pair
  [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = createServer();
  await server.connect(serverTransport);

  client = new Client({ name: "test-client", version: "0.0.1" });
  await client.connect(clientTransport);
}, 15_000);

afterAll(async () => {
  try { await clientTransport?.close(); } catch { /* ignore */ }
  try { await serverTransport?.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpKeyDir, { recursive: true, force: true }); } catch { /* ignore */ }
  fetchSpy?.mockRestore();

  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MCP server tool listing", () => {
  it("exposes exactly 6 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
  });

  it("exposes the expected tool names", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_episodic_memories_by_date",
      "grep",
      "list_files",
      "memory_search",
      "memory_setup_project",
      "read_file",
    ]);
  });
});

describe("memory_search tool", () => {
  it("has required schema fields", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "memory_search");
    expect(tool).toBeDefined();
    expect(tool.inputSchema.properties).toHaveProperty("query");
    expect(tool.inputSchema.properties).toHaveProperty("limit");
    expect(tool.inputSchema.properties).toHaveProperty("memory_type");
  });

  it("returns formatted results with role, timestamp, and relevance", async () => {
    const result = await client.callTool({ name: "memory_search", arguments: { query: "setup" } });
    const text = result.content[0].text;
    expect(text).toContain("[user |");
    expect(text).toContain("relevance=");
    expect(text).toContain("How do I set up the project?");
  });

  it("includes source:line for semantic memories with metadata", async () => {
    const result = await client.callTool({ name: "memory_search", arguments: { query: "setup" } });
    const text = result.content[0].text;
    expect(text).toContain("docs/setup.md:1");
  });

  it("filters to semantic-only when memory_type=semantic", async () => {
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "setup", memory_type: "semantic" },
    });
    const text = result.content[0].text;
    expect(text).toContain("external");
    expect(text).not.toContain("[user |");
    expect(text).not.toContain("[assistant |");
  });

  it("filters to episodic-only when memory_type=episodic", async () => {
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "setup", memory_type: "episodic" },
    });
    const text = result.content[0].text;
    expect(text).not.toContain("[external |");
    expect(text).toContain("[user |");
  });

  it("returns no-results message for empty API response", async () => {
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "__empty__" },
    });
    const text = result.content[0].text;
    expect(text).toBe("No memories found matching that query.");
  });

  it("returns no-results when all results filtered out by memory_type", async () => {
    // __only_episodic__ returns only user+assistant; filtering for semantic yields nothing
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "__only_episodic__", memory_type: "semantic" },
    });
    const text = result.content[0].text;
    expect(text).toBe("No memories found matching that query.");
  });

  it("returns error text on API 500 (never throws)", async () => {
    const result = await client.callTool({
      name: "memory_search",
      arguments: { query: "__server_error__" },
    });
    const text = result.content[0].text;
    expect(text).toContain("Memory search failed");
    expect(text).toContain("500");
  });
});

describe("grep tool", () => {
  it("has required schema fields", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "grep");
    expect(tool).toBeDefined();
    expect(tool.inputSchema.properties).toHaveProperty("pattern");
    expect(tool.inputSchema.properties).toHaveProperty("source");
    expect(tool.inputSchema.properties).toHaveProperty("limit");
  });

  it("returns ripgrep-style formatted results", async () => {
    const result = await client.callTool({ name: "grep", arguments: { pattern: "npm" } });
    const text = result.content[0].text;
    expect(text).toContain("docs/setup.md:12: npm install midbrain-memory-mcp");
    expect(text).toContain("docs/setup.md:45: npm run setup");
  });

  it("returns regex error for invalid pattern", async () => {
    const result = await client.callTool({ name: "grep", arguments: { pattern: "[invalid" } });
    const text = result.content[0].text;
    expect(text).toMatch(/regex error/i);
  });

  it("returns no-matches message for empty API response", async () => {
    const result = await client.callTool({ name: "grep", arguments: { pattern: "__empty__" } });
    const text = result.content[0].text;
    expect(text).toBe("No matches for pattern '__empty__'.");
  });

  it("returns error text on API 500 (never throws)", async () => {
    const result = await client.callTool({ name: "grep", arguments: { pattern: "__server_error__" } });
    const text = result.content[0].text;
    expect(text).toContain("Grep failed");
    expect(text).toContain("500");
  });
});

describe("get_episodic_memories_by_date tool", () => {
  it("has required schema fields", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "get_episodic_memories_by_date");
    expect(tool).toBeDefined();
    expect(tool.inputSchema.properties).toHaveProperty("date");
    expect(tool.inputSchema.properties).toHaveProperty("offset_days");
  });

  it("returns error for invalid date", async () => {
    const result = await client.callTool({
      name: "get_episodic_memories_by_date",
      arguments: { date: "not-a-date" },
    });
    const text = result.content[0].text;
    expect(text).toContain("Invalid date format");
  });

  it("returns chronological conversation timeline", async () => {
    const result = await client.callTool({
      name: "get_episodic_memories_by_date",
      arguments: { date: "2025-06-01" },
    });
    const text = result.content[0].text;
    expect(text).toContain("[assistant]: We discussed the API design.");
    expect(text).toContain("[user]: What did we discuss?");
    // Chronological: assistant at 13:59 should come before user at 14:00
    const assistantIdx = text.indexOf("[assistant]");
    const userIdx = text.indexOf("[user]");
    expect(assistantIdx).toBeLessThan(userIdx);
  });

  it("returns no-results message for empty date range", async () => {
    const result = await client.callTool({
      name: "get_episodic_memories_by_date",
      arguments: { date: "1999-01-01" },
    });
    const text = result.content[0].text;
    expect(text).toContain("No episodic memories found");
  });

  it("shows truncation warning when total exceeds returned items", async () => {
    const result = await client.callTool({
      name: "get_episodic_memories_by_date",
      arguments: { date: "2020-01-01" },
    });
    const text = result.content[0].text;
    expect(text).toContain("showing 1 of 50 memories");
  });
});

describe("list_files tool", () => {
  it("has no required parameters", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "list_files");
    expect(tool).toBeDefined();
    const required = tool.inputSchema.required || [];
    expect(required).toHaveLength(0);
  });

  it("returns file list with chunk counts", async () => {
    const result = await client.callTool({ name: "list_files", arguments: {} });
    const text = result.content[0].text;
    expect(text).toContain("Files (2):");
    expect(text).toContain("docs/setup.md  (5 chunks)");
    expect(text).toContain("docs/api.md  (12 chunks)");
  });
});

describe("read_file tool", () => {
  it("has required file_path parameter", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "read_file");
    expect(tool).toBeDefined();
    expect(tool.inputSchema.properties).toHaveProperty("file_path");
    expect(tool.inputSchema.properties).toHaveProperty("start_line");
    expect(tool.inputSchema.properties).toHaveProperty("num_lines");
  });

  it("returns numbered file content", async () => {
    const result = await client.callTool({
      name: "read_file",
      arguments: { file_path: "docs/setup.md" },
    });
    const text = result.content[0].text;
    expect(text).toContain("docs/setup.md:1");
    expect(text).toContain("# Setup Guide");
  });

  it("returns not-found message for missing file", async () => {
    const result = await client.callTool({
      name: "read_file",
      arguments: { file_path: "nonexistent.md" },
    });
    const text = result.content[0].text;
    expect(text).toContain("No content found");
  });
});

describe("memory_setup_project tool", () => {
  it("has project_dir as required parameter", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "memory_setup_project");
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toContain("project_dir");
  });

  it("returns error for relative path", async () => {
    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: "relative/path" },
    });
    const text = result.content[0].text;
    expect(text).toContain("absolute path");
  });

  it("returns error for nonexistent directory", async () => {
    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: "/tmp/nonexistent-dir-" + Date.now() },
    });
    const text = result.content[0].text;
    expect(text).toContain("does not exist");
  });
});

describe("memory_setup_project — config file integration", () => {
  let tmpProjectDir;
  let savedConfigDir;
  let savedHome;
  let fakeHome;

  beforeEach(() => {
    tmpProjectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-project-test-")));
    savedConfigDir = process.env.MIDBRAIN_CONFIG_DIR;

    // Isolate HOME so tests never touch the real ~/.claude.json or ~/.config/opencode.
    // server.js reads os.homedir() inside setupProject, which on POSIX honors $HOME.
    savedHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-home-"));
    process.env.HOME = fakeHome;

    // Seed fake HOME so existsSync-based client detection in server.js succeeds
    // for both OpenCode and Claude Code by default. Individual tests can override.
    fs.mkdirSync(path.join(fakeHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".claude.json"), JSON.stringify({ projects: {} }, null, 2), "utf8");
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.MIDBRAIN_CONFIG_DIR;
    else process.env.MIDBRAIN_CONFIG_DIR = savedConfigDir;

    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;

    try { fs.rmSync(tmpProjectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates .midbrain/.midbrain-key with chmod 600", async () => {
    process.env.MIDBRAIN_CONFIG_DIR = tmpKeyDir;
    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "proj-test-key" },
    });
    const text = result.content[0].text;
    expect(text).toContain("Key file created");

    const keyPath = path.join(tmpProjectDir, ".midbrain", ".midbrain-key");
    expect(fs.existsSync(keyPath)).toBe(true);
    const content = fs.readFileSync(keyPath, "utf8").trim();
    expect(content).toBe("proj-test-key");
    const stat = fs.statSync(keyPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("preserves existing key file", async () => {
    process.env.MIDBRAIN_CONFIG_DIR = tmpKeyDir;
    // Pre-create key
    const keyDir = path.join(tmpProjectDir, ".midbrain");
    fs.mkdirSync(keyDir, { recursive: true });
    fs.writeFileSync(path.join(keyDir, ".midbrain-key"), "existing-key\n", "utf8");

    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "new-key" },
    });
    const text = result.content[0].text;
    expect(text).toContain("preserved");
    const content = fs.readFileSync(path.join(keyDir, ".midbrain-key"), "utf8").trim();
    expect(content).toBe("existing-key");
  });

  it("writes opencode.json when MIDBRAIN_CONFIG_DIR contains 'opencode'", async () => {
    const ocConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
    fs.writeFileSync(path.join(ocConfigDir, ".midbrain-key"), "oc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ocConfigDir;

    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "oc-test-key" },
    });
    const text = result.content[0].text;
    expect(text).toMatch(/(Config written|midbrain-memory entry)/);

    const configPath = path.join(tmpProjectDir, "opencode.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.mcp).toBeDefined();
    expect(config.mcp["midbrain-memory"]).toBeDefined();
    expect(config.mcp["midbrain-memory"].type).toBe("local");
    expect(config.mcp["midbrain-memory"].environment.MIDBRAIN_PROJECT_DIR).toBe(tmpProjectDir);
    expect(config.mcp["midbrain-memory"].enabled).toBe(true);

    fs.rmSync(ocConfigDir, { recursive: true, force: true });
  });

  it("writes .mcp.json when MIDBRAIN_CONFIG_DIR contains 'claude'", async () => {
    const ccConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cfg-"));
    fs.writeFileSync(path.join(ccConfigDir, ".midbrain-key"), "cc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ccConfigDir;

    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "cc-test-key" },
    });
    const text = result.content[0].text;
    expect(text).toMatch(/(Config written|midbrain-memory entry)/);

    const configPath = path.join(tmpProjectDir, ".mcp.json");
    expect(fs.existsSync(configPath)).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.mcpServers).toBeDefined();
    expect(config.mcpServers["midbrain-memory"]).toBeDefined();
    expect(config.mcpServers["midbrain-memory"].env.MIDBRAIN_PROJECT_DIR).toBe(tmpProjectDir);

    fs.rmSync(ccConfigDir, { recursive: true, force: true });
  });

  it("merges into existing opencode.json without clobbering", async () => {
    const ocConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
    fs.writeFileSync(path.join(ocConfigDir, ".midbrain-key"), "oc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ocConfigDir;

    // Pre-create opencode.json with existing config
    const existingConfig = {
      $schema: "https://opencode.ai/config.json",
      provider: { aws: {} },
      model: "my-model",
      mcp: { "other-server": { type: "local", enabled: true } },
    };
    fs.writeFileSync(
      path.join(tmpProjectDir, "opencode.json"),
      JSON.stringify(existingConfig, null, 2),
      "utf8"
    );

    await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "oc-test-key" },
    });

    const config = JSON.parse(fs.readFileSync(path.join(tmpProjectDir, "opencode.json"), "utf8"));
    expect(config.provider).toEqual({ aws: {} });
    expect(config.model).toBe("my-model");
    expect(config.mcp["other-server"]).toEqual({ type: "local", enabled: true });
    expect(config.mcp["midbrain-memory"]).toBeDefined();

    fs.rmSync(ocConfigDir, { recursive: true, force: true });
  });

  it("merges into existing .mcp.json without clobbering", async () => {
    const ccConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cfg-"));
    fs.writeFileSync(path.join(ccConfigDir, ".midbrain-key"), "cc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ccConfigDir;

    // Pre-create .mcp.json
    const existingConfig = {
      mcpServers: { "other-server": { command: "other", args: ["-v"] } },
    };
    fs.writeFileSync(
      path.join(tmpProjectDir, ".mcp.json"),
      JSON.stringify(existingConfig, null, 2),
      "utf8"
    );

    await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "cc-test-key" },
    });

    const config = JSON.parse(fs.readFileSync(path.join(tmpProjectDir, ".mcp.json"), "utf8"));
    expect(config.mcpServers["other-server"]).toEqual({ command: "other", args: ["-v"] });
    expect(config.mcpServers["midbrain-memory"]).toBeDefined();

    fs.rmSync(ccConfigDir, { recursive: true, force: true });
  });

  it("removes invalid mcpServers from opencode.json", async () => {
    const ocConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
    fs.writeFileSync(path.join(ocConfigDir, ".midbrain-key"), "oc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ocConfigDir;

    fs.writeFileSync(
      path.join(tmpProjectDir, "opencode.json"),
      JSON.stringify({ mcpServers: { old: {} }, model: "keep-me" }),
      "utf8"
    );

    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "oc-test-key" },
    });
    const text = result.content[0].text;
    expect(text).toContain("mcpServers");

    const config = JSON.parse(fs.readFileSync(path.join(tmpProjectDir, "opencode.json"), "utf8"));
    expect(config.mcpServers).toBeUndefined();
    expect(config.model).toBe("keep-me");
    expect(config.mcp["midbrain-memory"]).toBeDefined();

    fs.rmSync(ocConfigDir, { recursive: true, force: true });
  });

  it("uses npx -y midbrain-memory-mcp@latest in command (PRD-010)", async () => {
    const ocConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
    fs.writeFileSync(path.join(ocConfigDir, ".midbrain-key"), "oc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ocConfigDir;

    await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "oc-test-key" },
    });

    const config = JSON.parse(fs.readFileSync(path.join(tmpProjectDir, "opencode.json"), "utf8"));
    const cmd = config.mcp["midbrain-memory"].command;
    expect(cmd).toEqual(["npx", "-y", "midbrain-memory-mcp@latest"]);

    fs.rmSync(ocConfigDir, { recursive: true, force: true });
  });

  it("includes restart reminder in output", async () => {
    process.env.MIDBRAIN_CONFIG_DIR = tmpKeyDir;
    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "test-key" },
    });
    const text = result.content[0].text;
    expect(text).toContain("restart");
  });

  it("writes configs based on client existence checks, not just config dir string", async () => {
    // Config dir doesn't contain "opencode" or "claude" — but existence checks find both
    process.env.MIDBRAIN_CONFIG_DIR = tmpKeyDir;
    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "test-key" },
    });
    const text = result.content[0].text;
    // With bidirectional detection, configs are written if clients exist on disk
    // (regardless of MIDBRAIN_CONFIG_DIR string matching)
    expect(text).toMatch(/(Config written|midbrain-memory entry)/);
  });

  it("never throws — returns error as text", async () => {
    // Even for a valid-looking but permission-denied scenario, should not throw
    process.env.MIDBRAIN_CONFIG_DIR = tmpKeyDir;
    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "test-key" },
    });
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
  });

  it("adds $schema when creating new opencode.json", async () => {
    const ocConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
    fs.writeFileSync(path.join(ocConfigDir, ".midbrain-key"), "oc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ocConfigDir;

    await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "oc-test-key" },
    });

    const config = JSON.parse(fs.readFileSync(path.join(tmpProjectDir, "opencode.json"), "utf8"));
    expect(config.$schema).toBe("https://opencode.ai/config.json");

    fs.rmSync(ocConfigDir, { recursive: true, force: true });
  });

  it("falls back to server key when api_key not provided", async () => {
    process.env.MIDBRAIN_CONFIG_DIR = tmpKeyDir;
    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir },
    });
    const text = result.content[0].text;
    expect(text).toContain("Key file created");

    const keyContent = fs.readFileSync(
      path.join(tmpProjectDir, ".midbrain", ".midbrain-key"),
      "utf8"
    ).trim();
    expect(keyContent).toBe("test-key-for-mcp-tests");
  });

  it("uses existing opencode.jsonc instead of creating opencode.json", async () => {
    const ocConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
    fs.writeFileSync(path.join(ocConfigDir, ".midbrain-key"), "oc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ocConfigDir;

    // Create opencode.jsonc with comments
    const jsoncContent = '{\n  // My project settings\n  "$schema": "https://opencode.ai/config.json",\n  "model": "my-model"\n}\n';
    fs.writeFileSync(path.join(tmpProjectDir, "opencode.jsonc"), jsoncContent, "utf8");

    await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "oc-test-key" },
    });

    // Should NOT create opencode.json
    expect(fs.existsSync(path.join(tmpProjectDir, "opencode.json"))).toBe(false);
    // Should write to opencode.jsonc
    expect(fs.existsSync(path.join(tmpProjectDir, "opencode.jsonc"))).toBe(true);

    const raw = fs.readFileSync(path.join(tmpProjectDir, "opencode.jsonc"), "utf8");
    // Comments preserved
    expect(raw).toContain("// My project settings");
    // MCP config added
    const parsed = jsoncParse(raw);
    expect(parsed.mcp["midbrain-memory"]).toBeDefined();
    expect(parsed.mcp["midbrain-memory"].type).toBe("local");
    // Existing keys preserved
    expect(parsed.model).toBe("my-model");

    fs.rmSync(ocConfigDir, { recursive: true, force: true });
  });

  it("preserves comments when merging into existing opencode.jsonc", async () => {
    const ocConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
    fs.writeFileSync(path.join(ocConfigDir, ".midbrain-key"), "oc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ocConfigDir;

    const jsoncContent = [
      "{",
      "  // Provider configuration",
      '  "$schema": "https://opencode.ai/config.json",',
      '  "provider": {',
      '    // AWS Bedrock setup',
      '    "amazon-bedrock": { "options": { "region": "eu-central-1" } }',
      "  },",
      '  "mcp": {',
      "    // Other MCP servers",
      '    "other-server": { "type": "local", "enabled": true }',
      "  }",
      "}",
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(tmpProjectDir, "opencode.jsonc"), jsoncContent, "utf8");

    await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "oc-test-key" },
    });

    const raw = fs.readFileSync(path.join(tmpProjectDir, "opencode.jsonc"), "utf8");
    expect(raw).toContain("// Provider configuration");
    expect(raw).toContain("// AWS Bedrock setup");
    expect(raw).toContain("// Other MCP servers");
    expect(raw).toContain("midbrain-memory");
    expect(raw).toContain("other-server");

    fs.rmSync(ocConfigDir, { recursive: true, force: true });
  });

  it("prefers opencode.jsonc over opencode.json when both exist", async () => {
    const ocConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
    fs.writeFileSync(path.join(ocConfigDir, ".midbrain-key"), "oc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ocConfigDir;

    // Create both files
    fs.writeFileSync(
      path.join(tmpProjectDir, "opencode.json"),
      '{"from": "json"}',
      "utf8"
    );
    fs.writeFileSync(
      path.join(tmpProjectDir, "opencode.jsonc"),
      '{\n  // JSONC version\n  "from": "jsonc"\n}',
      "utf8"
    );

    await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "oc-test-key" },
    });

    // opencode.jsonc should be updated (has midbrain-memory)
    const jsoncRaw = fs.readFileSync(path.join(tmpProjectDir, "opencode.jsonc"), "utf8");
    expect(jsoncRaw).toContain("midbrain-memory");
    expect(jsoncRaw).toContain("// JSONC version");

    // opencode.json should be untouched
    const jsonRaw = fs.readFileSync(path.join(tmpProjectDir, "opencode.json"), "utf8");
    expect(jsonRaw).not.toContain("midbrain-memory");

    fs.rmSync(ocConfigDir, { recursive: true, force: true });
  });

  it("writes BOTH OpenCode and Claude Code configs when called from OpenCode (bidirectional)", async () => {
    // Simulate calling from OpenCode (config dir contains "opencode")
    const ocConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
    fs.writeFileSync(path.join(ocConfigDir, ".midbrain-key"), "oc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ocConfigDir + "/opencode"; // contains "opencode"
    fs.mkdirSync(ocConfigDir + "/opencode", { recursive: true });
    fs.writeFileSync(path.join(ocConfigDir, "opencode", ".midbrain-key"), "oc-key\n", "utf8");

    // fakeHome already has a seeded ~/.claude.json from beforeEach — hasClaude is true deterministically.
    const claudeJsonPath = path.join(fakeHome, ".claude.json");

    try {
      const result = await client.callTool({
        name: "memory_setup_project",
        arguments: { project_dir: tmpProjectDir, api_key: "bidir-test-key" },
      });
      expect(result.content[0].text).toMatch(/(Config written|midbrain-memory entry)/);

      // OpenCode config should be written
      const ocConfigPath = path.join(tmpProjectDir, "opencode.json");
      expect(fs.existsSync(ocConfigPath)).toBe(true);
      const ocConfig = JSON.parse(fs.readFileSync(ocConfigPath, "utf8"));
      expect(ocConfig.mcp?.["midbrain-memory"]).toBeDefined();

      // Claude Code .mcp.json should also be written (bidirectional)
      const ccConfigPath = path.join(tmpProjectDir, ".mcp.json");
      expect(fs.existsSync(ccConfigPath)).toBe(true);
      const ccConfig = JSON.parse(fs.readFileSync(ccConfigPath, "utf8"));
      expect(ccConfig.mcpServers?.["midbrain-memory"]).toBeDefined();
      expect(ccConfig.mcpServers["midbrain-memory"].env.MIDBRAIN_PROJECT_DIR).toBe(tmpProjectDir);

      // Fake ~/.claude.json should be patched with project-local entry
      const updated = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
      const entry = updated.projects?.[tmpProjectDir]?.mcpServers?.["midbrain-memory"];
      expect(entry).toBeDefined();
      expect(entry.env.MIDBRAIN_PROJECT_DIR).toBe(tmpProjectDir);
    } finally {
      fs.rmSync(ocConfigDir, { recursive: true, force: true });
    }
  });

  it("writes BOTH OpenCode and Claude Code configs when called from Claude Code (reverse bidirectional)", async () => {
    // Simulate calling from Claude Code (config dir contains "claude")
    const ccConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cfg-"));
    fs.writeFileSync(path.join(ccConfigDir, ".midbrain-key"), "cc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ccConfigDir;

    // fakeHome seeded by beforeEach: both ~/.config/opencode and ~/.claude.json exist.
    const claudeJsonPath = path.join(fakeHome, ".claude.json");

    try {
      const result = await client.callTool({
        name: "memory_setup_project",
        arguments: { project_dir: tmpProjectDir, api_key: "reverse-bidir-key" },
      });
      expect(result.content[0].text).toMatch(/(Config written|midbrain-memory entry)/);

      // Claude .mcp.json must be written
      expect(fs.existsSync(path.join(tmpProjectDir, ".mcp.json"))).toBe(true);

      // OpenCode config must also be written (detected via fakeHome/.config/opencode existence)
      expect(fs.existsSync(path.join(tmpProjectDir, "opencode.json"))).toBe(true);

      // ~/.claude.json must be patched
      const updated = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
      expect(updated.projects?.[tmpProjectDir]?.mcpServers?.["midbrain-memory"]).toBeDefined();
    } finally {
      fs.rmSync(ccConfigDir, { recursive: true, force: true });
    }
  });

  it("warns when neither client is detected", async () => {
    // Unseed fakeHome so neither OpenCode nor Claude Code is detected
    fs.rmSync(path.join(fakeHome, ".config"), { recursive: true, force: true });
    fs.rmSync(path.join(fakeHome, ".claude.json"), { force: true });

    // Use a config dir that doesn't contain "opencode" or "claude" substrings
    process.env.MIDBRAIN_CONFIG_DIR = tmpKeyDir;

    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "no-client-key" },
    });
    const text = result.content[0].text;
    expect(text).toContain("could not detect any installed clients");
    // No project configs should have been written
    expect(fs.existsSync(path.join(tmpProjectDir, "opencode.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpProjectDir, ".mcp.json"))).toBe(false);
  });

  it("patches ~/.claude.json project-local scope for Claude Code projects", async () => {
    const ccConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cfg-"));
    fs.writeFileSync(path.join(ccConfigDir, ".midbrain-key"), "cc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ccConfigDir;

    // fakeHome already seeded with ~/.claude.json from beforeEach
    try {
      const result = await client.callTool({
        name: "memory_setup_project",
        arguments: { project_dir: tmpProjectDir, api_key: "cc-test-key" },
      });
      const text = result.content[0].text;

      // Should write .mcp.json
      expect(text).toMatch(/(Config written|midbrain-memory entry)/);
      expect(fs.existsSync(path.join(tmpProjectDir, ".mcp.json"))).toBe(true);

      // Should patch ~/.claude.json successfully (fakeHome has a writable one)
      expect(text).toMatch(/(Config patched|project-local)/);
    } finally {
      fs.rmSync(ccConfigDir, { recursive: true, force: true });
    }
  });

  it("patches ~/.claude.json with correct project-local MCP entry", async () => {
    const ccConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cfg-"));
    fs.writeFileSync(path.join(ccConfigDir, ".midbrain-key"), "cc-key\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ccConfigDir;

    const claudeJsonPath = path.join(fakeHome, ".claude.json");

    try {
      await client.callTool({
        name: "memory_setup_project",
        arguments: { project_dir: tmpProjectDir, api_key: "cc-test-key" },
      });

      const updated = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
      const entry = updated.projects?.[tmpProjectDir]?.mcpServers?.["midbrain-memory"];
      expect(entry).toBeDefined();
      expect(entry.type).toBe("stdio");
      expect(entry.env.MIDBRAIN_PROJECT_DIR).toBe(tmpProjectDir);
      expect(entry.env.MIDBRAIN_CONFIG_DIR).toContain("claude");
      expect(entry.command).toBe("npx");
      expect(entry.args).toEqual(["-y", "midbrain-memory-mcp@latest"]);
    } finally {
      fs.rmSync(ccConfigDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// PRD-010: memory_setup_project migration of stale configs
// ---------------------------------------------------------------------------

describe("memory_setup_project — stale config migration (PRD-010)", () => {
  let tmpProjectDir;
  let savedConfigDir;
  let savedHome;
  let fakeHome;

  beforeEach(() => {
    tmpProjectDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-migrate-")));
    savedConfigDir = process.env.MIDBRAIN_CONFIG_DIR;
    savedHome = process.env.HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-fake-home-migrate-"));
    process.env.HOME = fakeHome;
    fs.mkdirSync(path.join(fakeHome, ".config", "opencode"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".claude.json"), JSON.stringify({ projects: {} }, null, 2), "utf8");
  });

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.MIDBRAIN_CONFIG_DIR;
    else process.env.MIDBRAIN_CONFIG_DIR = savedConfigDir;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    try { fs.rmSync(tmpProjectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("G-2: migrates stale absolute-path entry in opencode.json; preserves siblings + env vars", async () => {
    const ocConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
    fs.writeFileSync(path.join(ocConfigDir, ".midbrain-key"), "k\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ocConfigDir;

    // Pre-create opencode.json with a stale absolute-path midbrain entry + sibling
    const stale = {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        "midbrain-memory": {
          type: "local",
          command: [
            "/usr/local/Cellar/node@20/20.19.2/bin/node",
            "/usr/local/lib/node_modules/midbrain-memory-mcp/server.js",
          ],
          environment: {
            MIDBRAIN_CONFIG_DIR: "/old/config/opencode",
            CUSTOM_VAR: "custom-value",
          },
          enabled: true,
        },
        "notion": {
          type: "local",
          command: ["docker", "run", "--rm", "-i", "mcp/notion"],
          enabled: true,
        },
      },
    };
    fs.writeFileSync(
      path.join(tmpProjectDir, "opencode.json"),
      JSON.stringify(stale, null, 2),
      "utf8",
    );

    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "new-key" },
    });
    const text = result.content[0].text;

    const updated = JSON.parse(fs.readFileSync(path.join(tmpProjectDir, "opencode.json"), "utf8"));
    // Migrated to @latest
    expect(updated.mcp["midbrain-memory"].command).toEqual(["npx", "-y", "midbrain-memory-mcp@latest"]);
    // Custom env var preserved
    expect(updated.mcp["midbrain-memory"].environment.CUSTOM_VAR).toBe("custom-value");
    // MIDBRAIN_CONFIG_DIR updated to new client-based value
    expect(updated.mcp["midbrain-memory"].environment.MIDBRAIN_CONFIG_DIR).toContain("opencode");
    // MIDBRAIN_PROJECT_DIR set
    expect(updated.mcp["midbrain-memory"].environment.MIDBRAIN_PROJECT_DIR).toBe(tmpProjectDir);
    // Sibling preserved byte-for-byte
    expect(updated.mcp.notion).toEqual(stale.mcp.notion);
    // Summary mentions migration
    expect(text.toLowerCase()).toMatch(/migrat/);

    fs.rmSync(ocConfigDir, { recursive: true, force: true });
  });

  it("G-3: migrates unpinned npx entry in opencode.json", async () => {
    const ocConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
    fs.writeFileSync(path.join(ocConfigDir, ".midbrain-key"), "k\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ocConfigDir;

    fs.writeFileSync(
      path.join(tmpProjectDir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          "midbrain-memory": {
            type: "local",
            command: ["npx", "-y", "midbrain-memory-mcp"],
            environment: {},
            enabled: true,
          },
        },
      }, null, 2),
      "utf8",
    );

    await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "new-key" },
    });

    const updated = JSON.parse(fs.readFileSync(path.join(tmpProjectDir, "opencode.json"), "utf8"));
    expect(updated.mcp["midbrain-memory"].command).toEqual(["npx", "-y", "midbrain-memory-mcp@latest"]);

    fs.rmSync(ocConfigDir, { recursive: true, force: true });
  });

  it("G-4: tool response summary includes per-file migration outcome", async () => {
    const ocConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
    fs.writeFileSync(path.join(ocConfigDir, ".midbrain-key"), "k\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ocConfigDir;

    fs.writeFileSync(
      path.join(tmpProjectDir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          "midbrain-memory": {
            type: "local",
            command: ["midbrain-memory-mcp"],
            environment: {},
            enabled: true,
          },
        },
      }, null, 2),
      "utf8",
    );

    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "new-key" },
    });
    const text = result.content[0].text;
    expect(text).toMatch(/global-installed-bin|migrated|migration/i);

    fs.rmSync(ocConfigDir, { recursive: true, force: true });
  });

  it("pinned @X.Y.Z entries are preserved, not migrated", async () => {
    const ocConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-cfg-"));
    fs.writeFileSync(path.join(ocConfigDir, ".midbrain-key"), "k\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ocConfigDir;

    fs.writeFileSync(
      path.join(tmpProjectDir, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          "midbrain-memory": {
            type: "local",
            command: ["npx", "-y", "midbrain-memory-mcp@0.3.1"],
            environment: {},
            enabled: true,
          },
        },
      }, null, 2),
      "utf8",
    );

    const result = await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "new-key" },
    });
    const text = result.content[0].text;

    const updated = JSON.parse(fs.readFileSync(path.join(tmpProjectDir, "opencode.json"), "utf8"));
    expect(updated.mcp["midbrain-memory"].command).toEqual(["npx", "-y", "midbrain-memory-mcp@0.3.1"]);
    expect(text.toLowerCase()).toMatch(/pinned/);

    fs.rmSync(ocConfigDir, { recursive: true, force: true });
  });

  it("G-4b: migrates stale entry in ~/.claude.json project-local scope", async () => {
    const ccConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cfg-"));
    fs.writeFileSync(path.join(ccConfigDir, ".midbrain-key"), "k\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ccConfigDir;

    const claudeJsonPath = path.join(fakeHome, ".claude.json");
    // Seed stale absolute-path entry in project-local + a sibling project
    fs.writeFileSync(
      claudeJsonPath,
      JSON.stringify({
        projects: {
          [tmpProjectDir]: {
            mcpServers: {
              "midbrain-memory": {
                type: "stdio",
                command: "/usr/local/bin/node",
                args: ["/Users/me/midbrain-memory-mcp/server.js"],
                env: { MIDBRAIN_CONFIG_DIR: "/old", KEEP: "me" },
              },
            },
          },
          "/some/other/proj": {
            mcpServers: { "midbrain-memory": { type: "stdio", command: "noop" } },
          },
        },
      }, null, 2),
      "utf8",
    );

    await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "k" },
    });

    const updated = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    const entry = updated.projects[tmpProjectDir].mcpServers["midbrain-memory"];
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "midbrain-memory-mcp@latest"]);
    // Custom env preserved
    expect(entry.env.KEEP).toBe("me");
    // Other project untouched
    expect(updated.projects["/some/other/proj"].mcpServers["midbrain-memory"])
      .toEqual({ type: "stdio", command: "noop" });

    fs.rmSync(ccConfigDir, { recursive: true, force: true });
  });

  it("G-4c: migrates stale entry in <project>/.mcp.json", async () => {
    const ccConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cfg-"));
    fs.writeFileSync(path.join(ccConfigDir, ".midbrain-key"), "k\n", "utf8");
    process.env.MIDBRAIN_CONFIG_DIR = ccConfigDir;

    fs.writeFileSync(
      path.join(tmpProjectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "midbrain-memory": {
            command: "/usr/local/bin/node",
            args: ["/Users/me/midbrain-memory-mcp/server.js"],
            env: { MIDBRAIN_CONFIG_DIR: "/old", CUSTOM: "v" },
          },
          "sibling": { command: "other", args: [] },
        },
      }, null, 2),
      "utf8",
    );

    await client.callTool({
      name: "memory_setup_project",
      arguments: { project_dir: tmpProjectDir, api_key: "k" },
    });

    const updated = JSON.parse(fs.readFileSync(path.join(tmpProjectDir, ".mcp.json"), "utf8"));
    expect(updated.mcpServers["midbrain-memory"].command).toBe("npx");
    expect(updated.mcpServers["midbrain-memory"].args).toEqual(["-y", "midbrain-memory-mcp@latest"]);
    expect(updated.mcpServers["midbrain-memory"].env.CUSTOM).toBe("v");
    expect(updated.mcpServers.sibling).toEqual({ command: "other", args: [] });

    fs.rmSync(ccConfigDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// PRD-010: --version flag + startup version log (G-5..G-8)
// ---------------------------------------------------------------------------

describe("server.js CLI — --version flag (PRD-010)", () => {
  /** Spawn `node server.js <args>` and return {status, stdout, stderr}. */
  function spawnServer(args, extraEnv = {}) {
    return spawnSync(process.execPath, [SERVER_PATH, ...args], {
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
      timeout: 5000,
    });
  }

  it("G-6: --version prints version to stdout and exits 0", () => {
    const result = spawnServer(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    // No MCP startup line in stderr — short-circuited before transport
    expect(result.stderr).not.toMatch(/MCP server running/);
  });

  it("G-7: -v prints version to stdout and exits 0", () => {
    const result = spawnServer(["-v"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("B-14: --version with trailing args still short-circuits", () => {
    const result = spawnServer(["--version", "foo", "bar"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("does not emit the PRD-005 update notice (no network call)", () => {
    // Short-circuit happens before checkForUpdate(). Stderr stays quiet
    // regardless of whether npm registry is reachable.
    const result = spawnServer(["--version"]);
    expect(result.stderr).not.toMatch(/Update available/);
  });
});

describe("server.js startup — version log line (PRD-010 G-5)", () => {
  it("G-8: importing server.js via createServer() does NOT trigger process.exit", () => {
    // If --version short-circuit were at module-level instead of inside isMain,
    // this test file itself wouldn't have run. We've already imported
    // createServer at the top without process exiting; calling it again is
    // a further sanity check.
    const s = createServer();
    expect(s).toBeDefined();
  });
});
