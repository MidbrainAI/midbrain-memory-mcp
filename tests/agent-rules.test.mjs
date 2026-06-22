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
  },
  readFile:  mocks.readFile,
  writeFile: mocks.writeFile,
  mkdir:     mocks.mkdir,
  chmod:     mocks.chmod,
}));

const resetMocks     = makeResetMocks(mocks);
const readFileReturns = makeReadFileReturns(mocks);

const { buildRulesBlock, writeAgentRules, writeProjectRules } =
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

  it("T-10: contains all required rules", () => {
    const block = buildRulesBlock();
    expect(block).toContain("check_session_status");
    expect(block).toContain("memory_search");
    expect(block).toContain("grep");
    expect(block).toContain("list_files");
    expect(block).toContain("read_file");
    expect(block).toContain("get_episodic_memories_by_date");
    expect(block).toContain("NEVER create semantic memories");
    expect(block).toContain("NEVER create episodic memories");
    expect(block).toContain("Procedural knowledge is not injected automatically");
    expect(block).toContain("MIDBRAIN_ENABLE_PK_INJECTION=1");
    expect(block).toContain("memory_setup_project");
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

  it("T-13: idempotent — second call returns skipped; no write", async () => {
    readFileReturns({ [TARGET]: buildRulesBlock() });
    const r1 = await writeAgentRules(TARGET);
    expect(r1.action).toBe("skipped");
    readFileReturns({ [TARGET]: buildRulesBlock() });
    const r2 = await writeAgentRules(TARGET);
    expect(r2.action).toBe("skipped");
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("T-4: file has old block — replaces block; action: updated", async () => {
    const old =
      "# Header\n\n<!-- midbrain-memory-rules:start -->\n## Old Rules\n- old rule\n<!-- midbrain-memory-rules:end -->\n\n# Footer";
    readFileReturns({ [TARGET]: old });
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("updated");
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written).toContain("# Header");
    expect(written).toContain("# Footer");
    expect(written).not.toContain("old rule");
    expect(written).toContain("memory_search");
  });

  it("T-14: old block — content before block unchanged", async () => {
    const before = "# Header\nSome intro.\n\n";
    const old = `${before}<!-- midbrain-memory-rules:start -->\nold\n<!-- midbrain-memory-rules:end -->`;
    readFileReturns({ [TARGET]: old });
    await writeAgentRules(TARGET);
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written.startsWith(before)).toBe(true);
  });

  it("T-15: old block — content after block unchanged", async () => {
    const after = "\n\n# Footer section";
    const old = `<!-- midbrain-memory-rules:start -->\nold\n<!-- midbrain-memory-rules:end -->${after}`;
    readFileReturns({ [TARGET]: old });
    await writeAgentRules(TARGET);
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written.endsWith(after)).toBe(true);
  });

  it("T-5: malformed sentinel (start, no end) — appends block; action: created; orphaned start preserved", async () => {
    const orphaned = "# Existing\n<!-- midbrain-memory-rules:start -->\nOrphaned content\n";
    readFileReturns({ [TARGET]: orphaned });
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("created");
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written).toContain("Orphaned content");
    expect(written).toContain("<!-- midbrain-memory-rules:end -->");
  });

  it("T-5b: orphaned start before complete block — updates only complete block", async () => {
    const orphaned = "# Existing\n<!-- midbrain-memory-rules:start -->\nUser instructions\n\n";
    const oldBlock = "<!-- midbrain-memory-rules:start -->\nold rule\n<!-- midbrain-memory-rules:end -->";
    readFileReturns({ [TARGET]: orphaned + oldBlock });
    const result = await writeAgentRules(TARGET);
    expect(result.action).toBe("updated");
    const written = mocks.writeFile.mock.calls[0]?.[1];
    expect(written).toContain("User instructions");
    expect(written).not.toContain("old rule");
    expect(written.indexOf("User instructions")).toBeLessThan(
      written.lastIndexOf("<!-- midbrain-memory-rules:start -->")
    );
    expect(written).toContain("memory_search");
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
// writeProjectRules
// ===================================================================

describe("writeProjectRules", () => {
  beforeEach(() => resetMocks());

  it("T-12: writes AGENTS.md and CLAUDE.md under projectDir", async () => {
    const results = await writeProjectRules(PROJECT_DIR);
    expect(results).toHaveLength(2);
    const paths = results.map((r) => r.path);
    expect(paths).toContain(path.join(PROJECT_DIR, "AGENTS.md"));
    expect(paths).toContain(path.join(PROJECT_DIR, "CLAUDE.md"));
  });

  it("T-12b: both results have action and path fields", async () => {
    const results = await writeProjectRules(PROJECT_DIR);
    for (const r of results) {
      expect(r).toHaveProperty("action");
      expect(r).toHaveProperty("path");
    }
  });
});
