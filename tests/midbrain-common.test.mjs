/**
 * Unit tests for shared/midbrain-common.mjs
 *
 * Tests: loadApiKey priority chain, isNewerVersion, constants, storeEpisodic.
 * Uses temp directories to simulate key file layouts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  loadApiKey,
  isNewerVersion,
  storeEpisodic,
  API_BASE_URL,
  API_V1,
  SEARCH_SEMANTIC_ENDPOINT,
  SEARCH_LEXICAL_ENDPOINT,
  SEMANTIC_FILES_ENDPOINT,
  EPISODIC_ENDPOINT,
  KEY_FILENAME,
  DEFAULT_SEARCH_LIMIT,
  GLOBAL_KEY_PATH,
  buildMcpCommandSpec,
  toOpenCodeShape,
  toClaudeShape,
  normalizeMcpEntry,
  detectMcpSpecShape,
} from "../shared/midbrain-common.mjs";

// ---------------------------------------------------------------------------
// isNewerVersion
// ---------------------------------------------------------------------------

describe("isNewerVersion", () => {
  it("returns true when latest is newer (patch)", () => {
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(true);
  });

  it("returns true when latest is newer (minor)", () => {
    expect(isNewerVersion("0.1.0", "0.2.0")).toBe(true);
  });

  it("returns true when latest is newer (major)", () => {
    expect(isNewerVersion("0.1.0", "1.0.0")).toBe(true);
  });

  it("returns false when versions are equal", () => {
    expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
  });

  it("returns false when current is newer", () => {
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(false);
  });

  it("returns false for empty/null inputs", () => {
    expect(isNewerVersion("", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "")).toBe(false);
    expect(isNewerVersion(null, "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", null)).toBe(false);
    expect(isNewerVersion(undefined, undefined)).toBe(false);
  });

  it("handles two-segment versions gracefully", () => {
    expect(isNewerVersion("1.0", "1.1")).toBe(true);
    expect(isNewerVersion("1.1", "1.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("API_BASE_URL is https", () => {
    expect(API_BASE_URL).toMatch(/^https:\/\//);
  });

  it("API_V1 is based on API_BASE_URL", () => {
    expect(API_V1).toBe(`${API_BASE_URL}/api/v1`);
  });

  it("all read-path endpoints start with API_V1", () => {
    for (const ep of [SEARCH_SEMANTIC_ENDPOINT, SEARCH_LEXICAL_ENDPOINT, EPISODIC_ENDPOINT, SEMANTIC_FILES_ENDPOINT]) {
      expect(ep).toMatch(new RegExp(`^${API_V1.replace(/[/.]/g, "\\$&")}`));
    }
  });

  it("write-path endpoint starts with API_V1", () => {
    expect(EPISODIC_ENDPOINT).toMatch(new RegExp(`^${API_V1.replace(/[/.]/g, "\\$&")}`));
  });

  it("DEFAULT_SEARCH_LIMIT is 10", () => {
    expect(DEFAULT_SEARCH_LIMIT).toBe(10);
  });

  it("KEY_FILENAME is .midbrain-key", () => {
    expect(KEY_FILENAME).toBe(".midbrain-key");
  });
});

// ---------------------------------------------------------------------------
// loadApiKey -- file priority chain
// ---------------------------------------------------------------------------

describe("loadApiKey", () => {
  let tmpDir;
  const savedEnv = {};
  let globalKeyBackedUp = false;
  const globalKeyBak = GLOBAL_KEY_PATH + ".test-bak";

  /** Create a key file with content and chmod 600. */
  function writeKey(filePath, content = "test-key-abc") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content + "\n", "utf8");
    fs.chmodSync(filePath, 0o600);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-test-"));
    // Save and clear env vars that affect key resolution
    for (const k of ["MIDBRAIN_API_KEY", "MIDBRAIN_PROJECT_DIR", "MIDBRAIN_CONFIG_DIR"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    // Move global key aside so tests control all key resolution paths
    if (fs.existsSync(GLOBAL_KEY_PATH)) {
      fs.renameSync(GLOBAL_KEY_PATH, globalKeyBak);
      globalKeyBackedUp = true;
    }
  });

  afterEach(() => {
    // Restore env
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Restore global key
    if (globalKeyBackedUp) {
      fs.renameSync(globalKeyBak, GLOBAL_KEY_PATH);
      globalKeyBackedUp = false;
    }
  });

  it("step 1a: reads flat .midbrain-key in projectDir", () => {
    const projDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projDir);
    writeKey(path.join(projDir, KEY_FILENAME), "proj-flat-key");

    const { key, source } = loadApiKey(projDir, undefined);
    expect(key).toBe("proj-flat-key");
    expect(source).toContain("project-arg");
  });

  it("step 1b: reads .midbrain/.midbrain-key in projectDir", () => {
    const projDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projDir);
    writeKey(path.join(projDir, ".midbrain", KEY_FILENAME), "proj-sub-key");

    const { key, source } = loadApiKey(projDir, undefined);
    expect(key).toBe("proj-sub-key");
    expect(source).toContain(".midbrain");
  });

  it("step 1a takes priority over 1b", () => {
    const projDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projDir);
    writeKey(path.join(projDir, KEY_FILENAME), "flat-key");
    writeKey(path.join(projDir, ".midbrain", KEY_FILENAME), "sub-key");

    const { key } = loadApiKey(projDir, undefined);
    expect(key).toBe("flat-key");
  });

  it("step 2a: reads from MIDBRAIN_PROJECT_DIR env when no projectDir arg", () => {
    const envDir = path.join(tmpDir, "env-proj");
    fs.mkdirSync(envDir);
    writeKey(path.join(envDir, KEY_FILENAME), "env-proj-key");
    process.env.MIDBRAIN_PROJECT_DIR = envDir;

    const { key, source } = loadApiKey(undefined, undefined);
    expect(key).toBe("env-proj-key");
    expect(source).toContain("project-env");
  });

  it("step 3: reads from configDir argument", () => {
    const cfgDir = path.join(tmpDir, "config");
    fs.mkdirSync(cfgDir);
    writeKey(path.join(cfgDir, KEY_FILENAME), "config-key");

    const { key, source } = loadApiKey(undefined, cfgDir);
    expect(key).toBe("config-key");
    expect(source).toContain("config-arg");
  });

  it("step 5: reads from MIDBRAIN_API_KEY env var", () => {
    process.env.MIDBRAIN_API_KEY = "env-var-key";

    const { key, source } = loadApiKey(undefined, undefined);
    expect(key).toBe("env-var-key");
    expect(source).toBe("env");
  });

  it("project key takes priority over config key", () => {
    const projDir = path.join(tmpDir, "proj");
    const cfgDir = path.join(tmpDir, "config");
    fs.mkdirSync(projDir);
    fs.mkdirSync(cfgDir);
    writeKey(path.join(projDir, ".midbrain", KEY_FILENAME), "proj-key");
    writeKey(path.join(cfgDir, KEY_FILENAME), "cfg-key");

    const { key } = loadApiKey(projDir, cfgDir);
    expect(key).toBe("proj-key");
  });

  it("config key takes priority over env var", () => {
    const cfgDir = path.join(tmpDir, "config");
    fs.mkdirSync(cfgDir);
    writeKey(path.join(cfgDir, KEY_FILENAME), "cfg-key");
    process.env.MIDBRAIN_API_KEY = "env-key";

    const { key } = loadApiKey(undefined, cfgDir);
    expect(key).toBe("cfg-key");
  });

  it("throws on empty key file", () => {
    const projDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projDir);
    writeKey(path.join(projDir, KEY_FILENAME), "");

    expect(() => loadApiKey(projDir, undefined)).toThrow(/empty/i);
  });

  it("throws when no key found anywhere", () => {
    // No files, no env vars — should throw
    expect(() => loadApiKey(undefined, undefined)).toThrow(/API key not found/i);
  });

  it("trims whitespace from key files", () => {
    const projDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projDir);
    writeKey(path.join(projDir, KEY_FILENAME), "  spaced-key  \n");

    const { key } = loadApiKey(projDir, undefined);
    expect(key).toBe("spaced-key");
  });

  it("ignores whitespace-only projectDir arg", () => {
    const cfgDir = path.join(tmpDir, "config");
    fs.mkdirSync(cfgDir);
    writeKey(path.join(cfgDir, KEY_FILENAME), "cfg-key");

    // Whitespace projectDir should be treated as undefined
    const { key, source } = loadApiKey("  ", cfgDir);
    expect(key).toBe("cfg-key");
    expect(source).toContain("config-arg");
  });

  it("step 2b: reads .midbrain/.midbrain-key from MIDBRAIN_PROJECT_DIR env", () => {
    const envDir = path.join(tmpDir, "env-proj-sub");
    fs.mkdirSync(envDir);
    writeKey(path.join(envDir, ".midbrain", KEY_FILENAME), "env-proj-sub-key");
    process.env.MIDBRAIN_PROJECT_DIR = envDir;

    const { key, source } = loadApiKey(undefined, undefined);
    expect(key).toBe("env-proj-sub-key");
    expect(source).toContain("project-env");
    expect(source).toContain(".midbrain");
  });

  it("step 4: reads from MIDBRAIN_CONFIG_DIR env when no configDir arg", () => {
    const envCfg = path.join(tmpDir, "env-config");
    fs.mkdirSync(envCfg);
    writeKey(path.join(envCfg, KEY_FILENAME), "env-config-key");
    process.env.MIDBRAIN_CONFIG_DIR = envCfg;

    const { key, source } = loadApiKey(undefined, undefined);
    expect(key).toBe("env-config-key");
    expect(source).toContain("config-env");
  });

  it("step 6: falls through to global key when projectDir has no key", () => {
    // Create a projectDir with no key, and a global key
    const projDir = path.join(tmpDir, "proj-no-key");
    fs.mkdirSync(projDir);
    writeKey(GLOBAL_KEY_PATH, "global-fallback-key");

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { key, source } = loadApiKey(projDir, undefined);
    stderrSpy.mockRestore();

    expect(key).toBe("global-fallback-key");
    expect(source).toContain("global");
  });

  it("emits WARN to stderr when projectDir falls through to global key", () => {
    const projDir = path.join(tmpDir, "proj-no-key-warn");
    fs.mkdirSync(projDir);
    writeKey(GLOBAL_KEY_PATH, "global-key");

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadApiKey(projDir, undefined);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("WARN")
    );
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining(projDir)
    );
    stderrSpy.mockRestore();
  });

  it("throws on EACCES (permission denied) for key file", () => {
    const projDir = path.join(tmpDir, "proj-perm");
    fs.mkdirSync(projDir);
    const keyPath = path.join(projDir, KEY_FILENAME);
    // Write key then make it unreadable
    writeKey(keyPath, "secret-key");
    fs.chmodSync(keyPath, 0o000);

    try {
      expect(() => loadApiKey(projDir, undefined)).toThrow(/permission denied/i);
    } finally {
      // Restore permissions for cleanup
      fs.chmodSync(keyPath, 0o600);
    }
  });

  it("step 2a takes priority over step 2b for MIDBRAIN_PROJECT_DIR env", () => {
    const envDir = path.join(tmpDir, "env-proj-priority");
    fs.mkdirSync(envDir);
    writeKey(path.join(envDir, KEY_FILENAME), "flat-env-key");
    writeKey(path.join(envDir, ".midbrain", KEY_FILENAME), "sub-env-key");
    process.env.MIDBRAIN_PROJECT_DIR = envDir;

    const { key } = loadApiKey(undefined, undefined);
    expect(key).toBe("flat-env-key");
  });

  it("explicit configDir arg takes priority over MIDBRAIN_CONFIG_DIR env", () => {
    const cfgArg = path.join(tmpDir, "config-arg");
    const cfgEnv = path.join(tmpDir, "config-env");
    fs.mkdirSync(cfgArg);
    fs.mkdirSync(cfgEnv);
    writeKey(path.join(cfgArg, KEY_FILENAME), "arg-key");
    writeKey(path.join(cfgEnv, KEY_FILENAME), "env-key");
    process.env.MIDBRAIN_CONFIG_DIR = cfgEnv;

    const { key } = loadApiKey(undefined, cfgArg);
    expect(key).toBe("arg-key");
  });
});

// ---------------------------------------------------------------------------
// storeEpisodic
// ---------------------------------------------------------------------------

describe("storeEpisodic", () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ status: 200 });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("POSTs to the episodic endpoint with correct body", async () => {
    const log = vi.fn();
    storeEpisodic("test-key", "hello world", "user", log);

    // storeEpisodic is fire-and-forget; wait for the fetch to be called
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe(EPISODIC_ENDPOINT);
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(opts.body)).toEqual({ text: "hello world", role: "user" });
  });

  it("calls debug log function on success", async () => {
    const log = vi.fn();
    storeEpisodic("test-key", "msg", "assistant", log);

    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("STORED")));
  });

  it("calls debug log function on fetch error", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("network down"));
    const log = vi.fn();
    storeEpisodic("test-key", "msg", "user", log);

    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("STORE ERROR")));
  });
});

// ---------------------------------------------------------------------------
// buildMcpCommandSpec (PRD-010 AC-1 / U-1..U-3)
// ---------------------------------------------------------------------------

describe("buildMcpCommandSpec", () => {
  it("U-1: returns canonical spec with configDir only", () => {
    const spec = buildMcpCommandSpec({ configDir: "/x" });
    expect(spec).toEqual({
      command: "npx",
      args: ["-y", "midbrain-memory-mcp@latest"],
      env: { MIDBRAIN_CONFIG_DIR: "/x" },
    });
  });

  it("U-2: adds MIDBRAIN_PROJECT_DIR when projectDir provided", () => {
    const spec = buildMcpCommandSpec({ configDir: "/x", projectDir: "/p" });
    expect(spec.env).toEqual({
      MIDBRAIN_CONFIG_DIR: "/x",
      MIDBRAIN_PROJECT_DIR: "/p",
    });
  });

  it("U-3: returns spec with empty env when no args", () => {
    const spec = buildMcpCommandSpec();
    expect(spec.command).toBe("npx");
    expect(spec.args).toEqual(["-y", "midbrain-memory-mcp@latest"]);
    expect(spec.env).toEqual({});
    // Serializes as {} not null
    expect(JSON.stringify(spec.env)).toBe("{}");
  });

  it("U-3b: does not throw when called with undefined", () => {
    expect(() => buildMcpCommandSpec(undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// toOpenCodeShape / toClaudeShape (U-4, U-5)
// ---------------------------------------------------------------------------

describe("toOpenCodeShape", () => {
  it("U-4: wraps spec in OpenCode's array-command shape", () => {
    const spec = buildMcpCommandSpec({ configDir: "/x" });
    expect(toOpenCodeShape(spec)).toEqual({
      type: "local",
      command: ["npx", "-y", "midbrain-memory-mcp@latest"],
      environment: { MIDBRAIN_CONFIG_DIR: "/x" },
      enabled: true,
    });
  });

  it("returns fresh environment object (not aliased)", () => {
    const spec = buildMcpCommandSpec({ configDir: "/x" });
    const out = toOpenCodeShape(spec);
    out.environment.EXTRA = "added";
    expect(spec.env.EXTRA).toBeUndefined();
  });
});

describe("toClaudeShape", () => {
  it("U-5: wraps spec in Claude's split command/args shape", () => {
    const spec = buildMcpCommandSpec({ configDir: "/x", projectDir: "/p" });
    expect(toClaudeShape(spec)).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "midbrain-memory-mcp@latest"],
      env: { MIDBRAIN_CONFIG_DIR: "/x", MIDBRAIN_PROJECT_DIR: "/p" },
    });
  });

  it("returns fresh env object (not aliased)", () => {
    const spec = buildMcpCommandSpec({ configDir: "/x" });
    const out = toClaudeShape(spec);
    out.env.EXTRA = "added";
    expect(spec.env.EXTRA).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeMcpEntry (U-6a, U-6b)
// ---------------------------------------------------------------------------

describe("normalizeMcpEntry", () => {
  it("U-6a: OpenCode array command -> {command, args}", () => {
    const entry = { command: ["npx", "-y", "midbrain-memory-mcp@latest"] };
    expect(normalizeMcpEntry(entry, "opencode")).toEqual({
      command: "npx",
      args: ["-y", "midbrain-memory-mcp@latest"],
    });
  });

  it("U-6b: Claude split shape -> {command, args}", () => {
    const entry = { command: "npx", args: ["-y", "midbrain-memory-mcp@latest"] };
    expect(normalizeMcpEntry(entry, "claude")).toEqual({
      command: "npx",
      args: ["-y", "midbrain-memory-mcp@latest"],
    });
  });

  it("OpenCode non-array command returns empty", () => {
    expect(normalizeMcpEntry({ command: "npx" }, "opencode")).toEqual({
      command: "",
      args: [],
    });
  });

  it("Claude missing args returns []", () => {
    expect(normalizeMcpEntry({ command: "npx" }, "claude")).toEqual({
      command: "npx",
      args: [],
    });
  });
});

// ---------------------------------------------------------------------------
// detectMcpSpecShape (U-7..U-13)
// ---------------------------------------------------------------------------

describe("detectMcpSpecShape", () => {
  it("U-7: absolute path to global-install server.js -> stale/absolute-path-server-js", () => {
    const result = detectMcpSpecShape({
      command: "/usr/local/Cellar/node/bin/node",
      args: ["/usr/local/lib/node_modules/midbrain-memory-mcp/server.js"],
    });
    expect(result).toEqual({ stale: true, reason: "absolute-path-server-js" });
  });

  it("U-8: absolute path to git-clone server.js -> stale/absolute-path-server-js", () => {
    const result = detectMcpSpecShape({
      command: "/usr/local/Cellar/node/bin/node",
      args: ["/Users/me/midbrain-memory-mcp/server.js"],
    });
    expect(result).toEqual({ stale: true, reason: "absolute-path-server-js" });
  });

  it("U-9: unpinned npx spec -> stale/unpinned-npx", () => {
    const result = detectMcpSpecShape({
      command: "npx",
      args: ["-y", "midbrain-memory-mcp"],
    });
    expect(result).toEqual({ stale: true, reason: "unpinned-npx" });
  });

  it("U-10: global-installed bin -> stale/global-installed-bin", () => {
    const result = detectMcpSpecShape({ command: "midbrain-memory-mcp", args: [] });
    expect(result).toEqual({ stale: true, reason: "global-installed-bin" });
  });

  it("U-11: @latest pinned npx -> not stale/at-latest", () => {
    const result = detectMcpSpecShape({
      command: "npx",
      args: ["-y", "midbrain-memory-mcp@latest"],
    });
    expect(result).toEqual({ stale: false, reason: "at-latest" });
  });

  it("U-12: explicit version pinned -> not stale/pinned", () => {
    const result = detectMcpSpecShape({
      command: "npx",
      args: ["-y", "midbrain-memory-mcp@0.3.1"],
    });
    expect(result).toEqual({ stale: false, reason: "pinned" });
  });

  it("U-13: unknown shape -> not stale/unknown", () => {
    const result = detectMcpSpecShape({
      command: "something-else",
      args: ["weird"],
    });
    expect(result).toEqual({ stale: false, reason: "unknown" });
  });

  it("handles empty args gracefully", () => {
    const result = detectMcpSpecShape({ command: "", args: [] });
    expect(result.stale).toBe(false);
  });
});
