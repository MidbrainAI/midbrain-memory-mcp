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
  loadAccountKey,
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
  ACCOUNT_KEY_FILENAME,
  ACCOUNT_KEY_ENV_VAR,
  AGENTS_ENDPOINT,
  KEYS_ENDPOINT,
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
// Account key constants
// ---------------------------------------------------------------------------

describe("account key constants", () => {
  it("ACCOUNT_KEY_FILENAME is .midbrain-account-key", () => {
    expect(ACCOUNT_KEY_FILENAME).toBe(".midbrain-account-key");
  });

  it("ACCOUNT_KEY_ENV_VAR is MIDBRAIN_ACCOUNT_KEY", () => {
    expect(ACCOUNT_KEY_ENV_VAR).toBe("MIDBRAIN_ACCOUNT_KEY");
  });

  it("AGENTS_ENDPOINT starts with API_V1", () => {
    expect(AGENTS_ENDPOINT).toBe(`${API_V1}/account/agents`);
  });

  it("KEYS_ENDPOINT starts with API_V1", () => {
    expect(KEYS_ENDPOINT).toBe(`${API_V1}/account/keys`);
  });
});

// ---------------------------------------------------------------------------
// loadAccountKey
// ---------------------------------------------------------------------------

describe("loadAccountKey", () => {
  let tmpDir;
  const savedEnv = {};
  let globalAccountKeyBackedUp = false;
  const globalAccountKeyPath = path.join(os.homedir(), ".config", "midbrain", ACCOUNT_KEY_FILENAME);
  const globalAccountKeyBak = globalAccountKeyPath + ".test-bak";
  let globalKeyBackedUp = false;
  const globalKeyBak = GLOBAL_KEY_PATH + ".test-bak";

  function writeKey(filePath, content = "test-account-key") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content + "\n", "utf8");
    fs.chmodSync(filePath, 0o600);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-acct-test-"));
    for (const k of ["MIDBRAIN_ACCOUNT_KEY", "MIDBRAIN_API_KEY", "MIDBRAIN_PROJECT_DIR", "MIDBRAIN_CONFIG_DIR"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    if (fs.existsSync(globalAccountKeyPath)) {
      fs.renameSync(globalAccountKeyPath, globalAccountKeyBak);
      globalAccountKeyBackedUp = true;
    }
    if (fs.existsSync(GLOBAL_KEY_PATH)) {
      fs.renameSync(GLOBAL_KEY_PATH, globalKeyBak);
      globalKeyBackedUp = true;
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (globalAccountKeyBackedUp) {
      fs.renameSync(globalAccountKeyBak, globalAccountKeyPath);
      globalAccountKeyBackedUp = false;
    }
    if (globalKeyBackedUp) {
      fs.renameSync(globalKeyBak, GLOBAL_KEY_PATH);
      globalKeyBackedUp = false;
    }
  });

  it("step 1: reads from ~/.config/midbrain/.midbrain-account-key", () => {
    writeKey(globalAccountKeyPath, "global-account-key");

    const { key, source } = loadAccountKey(undefined, undefined);
    expect(key).toBe("global-account-key");
    expect(source).toContain("account-global");
  });

  it("step 2: reads from configDir/.midbrain-account-key", () => {
    const cfgDir = path.join(tmpDir, "config");
    fs.mkdirSync(cfgDir);
    writeKey(path.join(cfgDir, ACCOUNT_KEY_FILENAME), "config-account-key");

    const { key, source } = loadAccountKey(undefined, cfgDir);
    expect(key).toBe("config-account-key");
    expect(source).toContain("account-config");
  });

  it("step 3: reads from MIDBRAIN_ACCOUNT_KEY env var", () => {
    process.env.MIDBRAIN_ACCOUNT_KEY = "env-account-key";

    const { key, source } = loadAccountKey(undefined, undefined);
    expect(key).toBe("env-account-key");
    expect(source).toContain("env:");
  });

  it("step 4: falls back to loadApiKey (agent key fallback)", () => {
    const projDir = path.join(tmpDir, "proj");
    fs.mkdirSync(projDir);
    writeKey(path.join(projDir, ".midbrain", ".midbrain-key"), "agent-key-fallback");

    const { key, source } = loadAccountKey(projDir, undefined);
    expect(key).toBe("agent-key-fallback");
    expect(source).toContain("agent-fallback");
  });

  it("global account key takes priority over env var", () => {
    writeKey(globalAccountKeyPath, "global-account-key");
    process.env.MIDBRAIN_ACCOUNT_KEY = "env-account-key";

    const { key } = loadAccountKey(undefined, undefined);
    expect(key).toBe("global-account-key");
  });

  it("throws when no key found anywhere with absolute path in error", () => {
    expect(() => loadAccountKey(undefined, undefined)).toThrow(/account key/i);
    // Error must contain absolute path (no tildes)
    try {
      loadAccountKey(undefined, undefined);
    } catch (err) {
      expect(err.message).not.toContain("~");
      expect(err.message).toContain(os.homedir());
    }
  });
});
