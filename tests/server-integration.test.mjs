/**
 * Integration tests for the MCP server (server.js).
 *
 * Self-contained: creates an in-process MCP server via createServer(),
 * connects a Client through InMemoryTransport (no child process, no stdio),
 * and mocks globalThis.fetch to simulate API responses.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "fs";
import os from "os";
import path from "path";

import { createServer } from "../server.js";

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
    return Promise.resolve(jsonResponse(MOCK_DATA.searchSemantic));
  }
  if (p === "/api/v1/memories/search/lexical") {
    const pattern = parsed.searchParams.get("pattern");
    if (pattern === "[invalid") {
      return Promise.resolve(jsonResponse({ detail: "Invalid regex pattern" }, 400));
    }
    if (pattern === "__empty__") return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse(MOCK_DATA.searchLexical));
  }
  if (p === "/api/v1/memories/episodic") {
    const startDate = parsed.searchParams.get("start_date") || "";
    if (startDate.startsWith("1999")) {
      return Promise.resolve(jsonResponse({ items: [], total: 0, page: 1, limit: 1000 }));
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
