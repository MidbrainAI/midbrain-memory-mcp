/**
 * Unit tests for shared/agent-rules.mjs
 *
 * Tests buildRulesBlock(), writeAgentRules(), writeProjectRules().
 * All filesystem operations are mocked — no real files read or written.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";

import { makeResetMocks, makeReadFileReturns } from "./fs-mock.mjs";

const mocks = vi.hoisted(() => ({
  readFile:   vi.fn(),
  writeFile:  vi.fn().mockResolvedValue(undefined),
  mkdir:      vi.fn().mockResolvedValue(undefined),
  chmod:      vi.fn().mockResolvedValue(undefined),
  stat:       vi.fn(),
  realpath:   vi.fn(),
  copyFile:   vi.fn().mockResolvedValue(undefined),
  readdir:    vi.fn().mockResolvedValue([]),
  existsSync: vi.fn(() => false),
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile:  mocks.readFile,
    writeFile: mocks.writeFile,
    mkdir:     mocks.mkdir,
    chmod:     mocks.chmod,
    stat:      mocks.stat,
    realpath:  mocks.realpath,
    copyFile:  mocks.copyFile,
    readdir:   mocks.readdir,
  },
  readFile:  mocks.readFile,
  writeFile: mocks.writeFile,
  mkdir:     mocks.mkdir,
  chmod:     mocks.chmod,
  readdir:   mocks.readdir,
}));

const resetMocks     = makeResetMocks(mocks);
const readFileReturns = makeReadFileReturns(mocks);

const {
  LEGACY_RULES_BLOCKS,
  RECOGNIZED_MANAGED_BLOCK_HASHES,
  buildRulesBlock,
  writeAgentRules,
  writeGlobalRules,
  writeProjectRules,
} =
  await import("../shared/agent-rules.mjs");

const TARGET      = "/tmp/test-project/AGENTS.md";
const PROJECT_DIR = "/tmp/test-project";

// ===================================================================
// buildRulesBlock
// ===================================================================

describe("buildRulesBlock", () => {
  it("T-11: starts with RULES_START and ends with RULES_END", () => {
    const block = buildRulesBlock();
    expect(block.startsWith("<!-- midbrain-memory-rules:start -->")).toBe(true);
    expect(block.endsWith("<!-- midbrain-memory-rules:end -->")).toBe(true);
  });

  it("T-10: contains the shared proactive-memory contract", () => {
    const block = buildRulesBlock();
    expect(block).toContain("check_session_status");
    expect(block).toContain("memory_search");
    expect(block).toContain("grep");
    expect(block).toContain("list_files");
    expect(block).toContain("read_file");
    expect(block).toContain("get_episodic_memories_by_date");
    expect(block).toContain("Before substantive work");
    expect(block).toContain("Start with contextual");
    expect(block).toContain("Search one target per call");
    expect(block).toContain("copy it verbatim into the query");
    expect(block).toContain("Never use `check_session_status` as a default");
    expect(block).toContain("session/client continuity");
    expect(block).toContain("Use recovered context");
    expect(block).toContain("remote memory");
    expect(block).toContain("Start near 10 results");
    expect(block).toContain("supported maximum (currently 50)");
    expect(block).toContain("Ranked misses are not");
    expect(block).toContain("recall depth is uncapped");
    expect(block).toContain("Stop on direct recovery");
    expect(block).toContain("Current/latest claims require");
    expect(block).toContain("assistant restatements are insufficient");
    expect(block).toContain("underlying state-changing episode");
    expect(block).toContain("found");
    expect(block).toContain("maybe found");
    expect(block).toContain("not found after search");
    expect(block).toContain("Never infer");
    expect(block).toContain("Never query secrets");
    expect(block).toContain("create memories");
    expect(block).toContain("Procedural");
    expect(block).toContain("not injected automatically");
    expect(block).toContain("MIDBRAIN_ENABLE_PK_INJECTION=1");
    expect(block).toContain("memory_setup_project");
  });

  it("T-10b: adds only the requested client discovery adapter", () => {
    const claude = buildRulesBlock("claude");
    const hermes = buildRulesBlock("hermes");
    const agents = buildRulesBlock("agents");
    const nanoclaw = buildRulesBlock("nanoclaw");

    expect(claude).toContain('ToolSearch');
    expect(claude).toContain("needed function");
    expect(claude).toContain("not only the server name");
    expect(claude).toContain("externalized results");
    expect(claude).not.toContain("tool_describe");

    expect(hermes).toContain("tool_search");
    expect(hermes).toContain("tool_describe");
    expect(hermes).toContain("tool_call");
    expect(hermes).not.toContain("ToolSearch");

    expect(agents).toContain("Codex/OpenCode");
    expect(agents).toContain("If deferred");
    expect(agents).toContain("needed function");
    expect(agents).toContain("allowed pre-recall action");

    expect(nanoclaw).toContain("NanoClaw");
    expect(nanoclaw).toContain("ToolSearch");
    expect(nanoclaw).toContain("externalized results");
  });

  it("T-10c: keeps the shared contract byte-identical across clients", () => {
    const bodies = ["agents", "claude", "hermes", "nanoclaw"]
      .map((client) => buildRulesBlock(client))
      .map((block) => block.slice(block.indexOf("## MidBrain Memory")));
    expect(new Set(bodies).size).toBe(1);
  });
});

// ===================================================================
// writeAgentRules
// ===================================================================

describe("writeAgentRules", () => {
  beforeEach(() => resetMocks());

  it("T-1: file does not exist — creates file; action: created; contains RULES_START", async () => {
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("created");
    expect(result.path).toBe(TARGET);
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written).toContain("<!-- midbrain-memory-rules:start -->");
  });

  it("T-8: empty file — writes block only; action: created", async () => {
    readFileReturns({ [TARGET]: "" });
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("created");
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written).toBe(buildRulesBlock());
  });

  it("T-9: whitespace-only file — writes block; action: created", async () => {
    readFileReturns({ [TARGET]: "   \n  \n" });
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("created");
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written).toBe(buildRulesBlock());
  });

  it("T-2: file exists, no block — appends block; original content preserved; action: created", async () => {
    const original = "# My Project\nExisting content here.\n";
    readFileReturns({ [TARGET]: original });
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("created");
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written).toContain("# My Project");
    expect(written).toContain("Existing content here.");
    expect(written).toContain("<!-- midbrain-memory-rules:start -->");
    expect(written.indexOf("Existing content here.")).toBeLessThan(
      written.indexOf("<!-- midbrain-memory-rules:start -->")
    );
  });

  it("T-3: file has current block — no write; action: skipped", async () => {
    readFileReturns({ [TARGET]: buildRulesBlock() });
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("skipped");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("T-3b: client-specific block is idempotent", async () => {
    readFileReturns({ [TARGET]: buildRulesBlock("claude") });
    const result = await writeAgentRules(TARGET, { client: "claude" });
    expect(result.action).toBe("skipped");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("T-13: idempotent — second call returns skipped; no write", async () => {
    readFileReturns({ [TARGET]: buildRulesBlock() });
    const r1 = await writeAgentRules(TARGET);
    expect(r1.action).toBe("skipped");
    readFileReturns({ [TARGET]: buildRulesBlock() });
    const r2 = await writeAgentRules(TARGET);
    expect(r2.action).toBe("skipped");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("T-4: exact shipped legacy block — replaces block; action: updated", async () => {
    const old = `# Header\n\n${LEGACY_RULES_BLOCKS[0]}\n\n# Footer`;
    readFileReturns({ [TARGET]: old });
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("updated");
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written).toContain("# Header");
    expect(written).toContain("# Footer");
    expect(written).not.toContain("## MidBrain Memory Rules");
    expect(written).toContain("memory_search");
  });

  it("T-4b: recognizes byte-exact managed rollout blocks by hash", () => {
    expect([...RECOGNIZED_MANAGED_BLOCK_HASHES].sort()).toEqual([
      "a7bc02935caf2ba8ac3225d2255a2783e9e69e6e24cdd3a07622c5de99e7",
      "b291ef0e795a38f42061fde07152f907454f47e88ffd7b3d80b33d56fbf38c78",
      "b3daa1470cabc89f7401bde1efa29b942514f2df90c24d1fdc663df318dd14cb",
      "e4d35347297d3af14bdddb0f6952c6fe84bced7081b757ac06d654a5aa851976",
    ]);
  });

  it("T-14: known legacy block — content before block unchanged", async () => {
    const before = "# Header\nSome intro.\n\n";
    const old = `${before}${LEGACY_RULES_BLOCKS[0]}`;
    readFileReturns({ [TARGET]: old });
    await writeAgentRules(TARGET);
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written.startsWith(before)).toBe(true);
  });

  it("T-15: known legacy block — content after block unchanged", async () => {
    const after = "\n\n# Footer section";
    const old = `${LEGACY_RULES_BLOCKS[0]}${after}`;
    readFileReturns({ [TARGET]: old });
    await writeAgentRules(TARGET);
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written.endsWith(after)).toBe(true);
  });

  it("T-5: malformed sentinel — preserves file and reports manual review", async () => {
    const orphaned = "# Existing\n<!-- midbrain-memory-rules:start -->\nOrphaned content\n";
    readFileReturns({ [TARGET]: orphaned });
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("preserved");
    expect(result.reason).toBe("malformed-managed-block");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("T-5b: unknown/custom managed block — preserves every custom rule", async () => {
    const custom = [
      "# Existing",
      "<!-- midbrain-memory-rules:start -->",
      "## My hardened MidBrain policy",
      "- Search customer-specific archive `alpha` before saying not found.",
      "<!-- midbrain-memory-rules:end -->",
    ].join("\n");
    readFileReturns({ [TARGET]: custom });
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("preserved");
    expect(result.reason).toBe("custom-managed-block");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("T-5c: uncertain unsentinelled MidBrain prose is preserved when managed rules append", async () => {
    const custom = "## MidBrain custom hardening\n- Always search alpha.\n";
    readFileReturns({ [TARGET]: custom });
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("created");
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written).toContain(custom);
    expect(written).toContain(buildRulesBlock());
  });

  it("T-6: EACCES on read — returns action: error; does not throw; no write", async () => {
    const err = new Error("EACCES: permission denied");
    err.code = "EACCES";
    mocks.readFile.mockRejectedValue(err);
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("error");
    expect(result.path).toBe(TARGET);
    expect(result.error).toBe(err);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("T-7: EACCES on write — returns action: error; does not throw", async () => {
    readFileReturns({ [TARGET]: "" });
    const writeErr = new Error("EACCES: permission denied on write");
    writeErr.code = "EACCES";
    mocks.writeFile.mockRejectedValue(writeErr);
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("error");
    expect(result.path).toBe(TARGET);
    expect(result.error).toBe(writeErr);
  });
});

// ===================================================================
// writeGlobalRules
// ===================================================================

describe("writeGlobalRules", () => {
  beforeEach(() => resetMocks());

  it("T-19: targets each detected client's real global instruction surface", async () => {
    mocks.readdir.mockResolvedValue([
      { name: "main", isDirectory: () => true },
      { name: "worker", isDirectory: () => true },
      { name: "README.md", isDirectory: () => false },
    ]);

    const results = await writeGlobalRules({
      clients: ["codex", "opencode", "claude", "hermes", "nanoclaw"],
      homeDir: "/home/tester",
      hermesHome: "/profiles/hermes",
      nanoclawRoot: "/srv/nanoclaw",
    });

    expect(results.map((r) => r.path).sort()).toEqual([
      path.join("/home/tester", ".claude", "CLAUDE.md"),
      path.join("/home/tester", ".codex", "AGENTS.md"),
      path.join("/home/tester", ".config", "opencode", "AGENTS.md"),
      path.join("/profiles/hermes", "SOUL.md"),
      path.join("/srv/nanoclaw", "container", "CLAUDE.md"),
      path.join("/srv/nanoclaw", "groups", "main", "CLAUDE.local.md"),
      path.join("/srv/nanoclaw", "groups", "worker", "CLAUDE.local.md"),
    ].sort());
  });

  it("T-19b: NanoClaw global sync never writes composed CLAUDE.md files", async () => {
    mocks.readdir.mockResolvedValue([
      { name: "main", isDirectory: () => true },
    ]);
    await writeGlobalRules({
      clients: ["nanoclaw"],
      nanoclawRoot: "/srv/nanoclaw",
    });
    const paths = mocks.writeFile.mock.calls.map(([filePath]) => filePath);
    expect(paths).toContain(path.join("/srv/nanoclaw", "container", "CLAUDE.md"));
    expect(paths).toContain(path.join("/srv/nanoclaw", "groups", "main", "CLAUDE.local.md"));
    expect(paths).not.toContain(path.join("/srv/nanoclaw", "groups", "main", "CLAUDE.md"));
  });

  it("T-19c: missing NanoClaw groups directory still updates shared rules", async () => {
    const err = Object.assign(new Error("missing"), { code: "ENOENT" });
    mocks.readdir.mockRejectedValue(err);
    const results = await writeGlobalRules({
      clients: ["nanoclaw"],
      nanoclawRoot: "/srv/nanoclaw",
    });
    expect(results.map((r) => r.path)).toEqual([
      path.join("/srv/nanoclaw", "container", "CLAUDE.md"),
    ]);
  });
});

// ===================================================================
// writeProjectRules
// ===================================================================

describe("writeProjectRules", () => {
  beforeEach(() => resetMocks());

  it("T-12: writes portable AGENTS.md and Claude-specific CLAUDE.md", async () => {
    const results = await writeProjectRules(PROJECT_DIR);
    expect(results).toHaveLength(2);
    const paths = results.map((r) => r.path);
    expect(paths).toContain(path.join(PROJECT_DIR, "AGENTS.md"));
    expect(paths).toContain(path.join(PROJECT_DIR, "CLAUDE.md"));

    const agentsWrite = mocks.writeFile.mock.calls.find(
      ([filePath]) => filePath === path.join(PROJECT_DIR, "AGENTS.md")
    );
    const claudeWrite = mocks.writeFile.mock.calls.find(
      ([filePath]) => filePath === path.join(PROJECT_DIR, "CLAUDE.md")
    );
    expect(agentsWrite?.[1]).toContain("Codex/OpenCode");
    expect(claudeWrite?.[1]).toContain("ToolSearch");
  });

  it("T-12b: both results have action and path fields", async () => {
    const results = await writeProjectRules(PROJECT_DIR);
    for (const r of results) {
      expect(r).toHaveProperty("action");
      expect(r).toHaveProperty("path");
    }
  });

  it("T-12c: updates an existing highest-priority Hermes context file", async () => {
    const hermesPath = path.join(PROJECT_DIR, ".hermes.md");
    readFileReturns({ [hermesPath]: "# Hermes project rules\n" });
    const results = await writeProjectRules(PROJECT_DIR);
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.path)).toContain(hermesPath);
    const hermesWrite = mocks.writeFile.mock.calls.find(
      ([filePath]) => filePath === hermesPath
    );
    expect(hermesWrite?.[1]).toContain("tool_search");
    expect(hermesWrite?.[1]).toContain("tool_describe");
    expect(hermesWrite?.[1]).toContain("tool_call");
  });

  it("T-12d: uses HERMES.md when .hermes.md is absent", async () => {
    const hermesPath = path.join(PROJECT_DIR, "HERMES.md");
    readFileReturns({ [hermesPath]: "# Hermes project rules\n" });
    const results = await writeProjectRules(PROJECT_DIR, { clients: ["hermes"] });
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe(hermesPath);
    const hermesWrite = mocks.writeFile.mock.calls.find(
      ([filePath]) => filePath === hermesPath
    );
    expect(hermesWrite?.[1]).toContain("- Hermes:");
  });

  it.each([
    ["codex", "AGENTS.md", "Codex/OpenCode"],
    ["opencode", "AGENTS.md", "Codex/OpenCode"],
    ["claude", "CLAUDE.md", "ToolSearch"],
    ["nanoclaw", "CLAUDE.md", "ToolSearch"],
    ["hermes", "AGENTS.md", "Hermes"],
  ])("T-16: %s writes only its active instruction surface", async (client, filename, marker) => {
    const results = await writeProjectRules(PROJECT_DIR, { clients: [client] });
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe(path.join(PROJECT_DIR, filename));
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written).toContain(marker);
  });

  it("T-17: Hermes does not create a shadowing context file", async () => {
    const results = await writeProjectRules(PROJECT_DIR, { clients: ["hermes"] });
    expect(results.map((r) => path.basename(r.path))).toEqual(["AGENTS.md"]);
    expect(mocks.writeFile.mock.calls.some(([filePath]) =>
      [".hermes.md", "HERMES.md"].includes(path.basename(filePath))
    )).toBe(false);
  });

  it("T-18: mixed clients receive every required active surface once", async () => {
    const hermesPath = path.join(PROJECT_DIR, ".hermes.md");
    readFileReturns({ [hermesPath]: "# Existing Hermes instructions\n" });
    const results = await writeProjectRules(PROJECT_DIR, {
      clients: ["codex", "opencode", "claude", "nanoclaw", "hermes"],
    });
    expect(results.map((r) => r.path).sort()).toEqual([
      path.join(PROJECT_DIR, ".hermes.md"),
      path.join(PROJECT_DIR, "AGENTS.md"),
      path.join(PROJECT_DIR, "CLAUDE.md"),
    ].sort());
  });
});
