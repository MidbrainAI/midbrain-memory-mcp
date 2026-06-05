/**
 * Unit tests for install.mjs (orchestrator).
 *
 * Tests projectSetup(), runInstallerCli(), and printHelp().
 * Client adapter behaviour is tested separately in client-opencode.test.mjs,
 * client-claude.test.mjs, and client-registry.test.mjs.
 *
 * All filesystem operations are mocked — no real files read or written.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "path";
import os from "os";

import { enoent, makeResetMocks, makeExistsFor, makeReadFileReturns } from "./fs-mock.mjs";

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
  default: { readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir,
             chmod: mocks.chmod, stat: mocks.stat, realpath: mocks.realpath, copyFile: mocks.copyFile },
  readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir, chmod: mocks.chmod,
}));
vi.mock("fs", async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, existsSync: mocks.existsSync, realpathSync: orig.realpathSync };
});

const fs = { readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir,
             chmod: mocks.chmod, stat: mocks.stat, realpath: mocks.realpath, copyFile: mocks.copyFile };
const existsSync = mocks.existsSync;
const resetMocks = makeResetMocks(mocks);
const existsFor = makeExistsFor(mocks);
const readFileReturns = makeReadFileReturns(mocks);

const { main, projectSetup, runInstallerCli, printHelp } = await import("../install.mjs");

const HOME = os.homedir();

const PATHS = {
  globalKey:        path.join(HOME, ".config", "midbrain", ".midbrain-key"),
  opencodeKey:      path.join(HOME, ".config", "opencode", ".midbrain-key"),
  claudeKey:        path.join(HOME, ".config", "claude", ".midbrain-key"),
  codexKey:         path.join(HOME, ".config", "codex", ".midbrain-key"),
  opencodeConfig:   path.join(HOME, ".config", "opencode", "opencode.json"),
  claudeJson:       path.join(HOME, ".claude.json"),
  codexConfig:      path.join(HOME, ".codex", "config.toml"),
};

const PROJECT_DIR = "/home/testuser/myproject";

function fileError(code, filePath) {
  const err = new Error(`${code}: test failure, open '${filePath}'`);
  err.code = code;
  return err;
}

// ===================================================================
// main() — per-client key writing
// ===================================================================

describe("main — per-client key writing", () => {
  let logSpy;
  const savedEnv = {};

  beforeEach(() => {
    resetMocks();
    savedEnv.MIDBRAIN_API_KEY = process.env.MIDBRAIN_API_KEY;
    delete process.env.MIDBRAIN_API_KEY;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
    if (savedEnv.MIDBRAIN_API_KEY === undefined) delete process.env.MIDBRAIN_API_KEY;
    else process.env.MIDBRAIN_API_KEY = savedEnv.MIDBRAIN_API_KEY;
  });

  it("writes global key AND per-client key for OpenCode", async () => {
    // Simulate OpenCode detected (opencode.json present), existing key in place
    existsFor(PATHS.opencodeConfig);
    readFileReturns({ [PATHS.opencodeKey]: "my-oc-key\n" });

    await main();

    // Global key written
    const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
    expect(globalWrite).toBeDefined();
    expect(globalWrite[1]).toBe("my-oc-key\n");

    // OpenCode per-client key also written
    const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
    expect(ocWrite).toBeDefined();
    expect(ocWrite[1]).toBe("my-oc-key\n");
  });

  it("writes global key AND per-client key for Claude Code", async () => {
    existsFor(PATHS.claudeJson);
    readFileReturns({ [PATHS.claudeKey]: "my-cc-key\n" });

    await main();

    const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
    expect(globalWrite).toBeDefined();

    const ccWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeKey);
    expect(ccWrite).toBeDefined();
    expect(ccWrite[1]).toBe("my-cc-key\n");
  });

  it("writes both per-client keys when both clients detected", async () => {
    existsFor(PATHS.opencodeConfig, PATHS.claudeJson);
    // OpenCode key already present, Claude key also present
    readFileReturns({
      [PATHS.opencodeKey]: "oc-key\n",
      [PATHS.claudeKey]: "cc-key\n",
    });

    await main();

    const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
    const ccWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeKey);
    expect(ocWrite).toBeDefined();
    expect(ccWrite).toBeDefined();
  });

  it("writes global key AND per-client key for Codex", async () => {
    existsFor(PATHS.codexConfig);
    readFileReturns({ [PATHS.codexKey]: "my-codex-key\n" });

    await main();

    const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
    expect(globalWrite).toBeDefined();

    const codexWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexKey);
    expect(codexWrite).toBeDefined();
    expect(codexWrite[1]).toBe("my-codex-key\n");

    const configWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexConfig);
    expect(configWrite).toBeDefined();
  });
});

// ===================================================================
// projectSetup
// ===================================================================

describe("projectSetup", () => {
  const savedEnv = {};

  beforeEach(() => {
    resetMocks();
    for (const k of ["MIDBRAIN_API_KEY", "MIDBRAIN_PROJECT_DIR", "MIDBRAIN_CONFIG_DIR"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function setupProjectMocks(opts = {}) {
    const {
      projectDir = PROJECT_DIR,
      apiKey = "test-api-key-1234",
      existingProjectKey = false,
      opencodeDetected = true,
      claudeDetected = false,
    } = opts;

    fs.stat.mockImplementation(async (p) => {
      if (p === projectDir) return { isDirectory: () => true };
      throw enoent(p);
    });
    fs.realpath.mockImplementation(async (p) => p);

    const files = {};
    if (existingProjectKey) {
      files[path.join(projectDir, ".midbrain", ".midbrain-key")] = apiKey + "\n";
    }
    files[PATHS.globalKey] = apiKey + "\n";
    readFileReturns(files);

    const existsPaths = [];
    if (opencodeDetected) existsPaths.push(PATHS.opencodeConfig);
    if (claudeDetected) existsPaths.push(PATHS.claudeJson);
    existsFor(...existsPaths);
  }

  it("creates .midbrain/.midbrain-key with chmod 600", async () => {
    setupProjectMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    const keyPath = path.join(PROJECT_DIR, ".midbrain", ".midbrain-key");
    expect(fs.mkdir).toHaveBeenCalledWith(path.join(PROJECT_DIR, ".midbrain"), { recursive: true });
    const keyWrite = fs.writeFile.mock.calls.find(([p]) => p === keyPath);
    expect(keyWrite).toBeDefined();
    expect(keyWrite[1]).toBe("test-api-key-1234\n");
    expect(fs.chmod).toHaveBeenCalledWith(keyPath, 0o600);
  });

  it("exits without overwriting when an existing project key is empty", async () => {
    setupProjectMocks({ existingProjectKey: true });
    const keyPath = path.join(PROJECT_DIR, ".midbrain", ".midbrain-key");
    readFileReturns({
      [keyPath]: " \n",
      [PATHS.globalKey]: "test-api-key-1234\n",
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(projectSetup(PROJECT_DIR)).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(`Key file is empty: ${keyPath}`);
    const keyWrites = fs.writeFile.mock.calls.filter(([p]) => p === keyPath);
    expect(keyWrites).toHaveLength(0);

    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("exits without overwriting when an existing project key is unreadable", async () => {
    setupProjectMocks({ existingProjectKey: true });
    const keyPath = path.join(PROJECT_DIR, ".midbrain", ".midbrain-key");
    mocks.readFile.mockImplementation(async (filePath) => {
      if (filePath === keyPath) throw fileError("EACCES", filePath);
      if (filePath === PATHS.globalKey) return "test-api-key-1234\n";
      throw enoent(filePath);
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(projectSetup(PROJECT_DIR)).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(`Permission denied reading key file: ${keyPath}`);
    const keyWrites = fs.writeFile.mock.calls.filter(([p]) => p === keyPath);
    expect(keyWrites).toHaveLength(0);

    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("preserves existing project key file", async () => {
    setupProjectMocks({ existingProjectKey: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    logSpy.mockRestore();

    const keyPath = path.join(PROJECT_DIR, ".midbrain", ".midbrain-key");
    const keyWrites = fs.writeFile.mock.calls.filter(([p]) => p === keyPath);
    expect(keyWrites).toHaveLength(0);
  });

  it("outputs valid JSON result to stdout", async () => {
    setupProjectMocks();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);

    const stdout = logSpy.mock.calls[0][0];
    logSpy.mockRestore();
    const result = JSON.parse(stdout);
    expect(result.success).toBe(true);
    expect(result.project_dir).toBe(PROJECT_DIR);
    expect(result.key_created).toBeDefined();
    expect(result.restart_required).toBe(true);
  });

  it("exits with error for nonexistent directory", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    fs.stat.mockRejectedValue(enoent("/nonexistent"));
    await expect(projectSetup("/nonexistent")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("exits with error when no API key found", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    fs.realpath.mockResolvedValue(PROJECT_DIR);
    await expect(projectSetup(PROJECT_DIR)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it("warns when no clients detected", async () => {
    fs.stat.mockResolvedValue({ isDirectory: () => true });
    fs.realpath.mockResolvedValue(PROJECT_DIR);
    readFileReturns({ [PATHS.globalKey]: "test-key\n" });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await projectSetup(PROJECT_DIR);
    const result = JSON.parse(logSpy.mock.calls[0][0]);
    logSpy.mockRestore();

    expect(result.configs_written).toHaveLength(0);
  });
});

// ===================================================================
// printHelp
// ===================================================================

describe("printHelp", () => {
  it("includes --project, --dev, --help flags", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    printHelp();
    const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
    logSpy.mockRestore();
    expect(out).toContain("--project");
    expect(out).toContain("--dev");
    expect(out).toContain("--help");
    expect(out).toContain("midbrain-memory-mcp@latest");
  });
});

// ===================================================================
// runInstallerCli
// ===================================================================

describe("runInstallerCli", () => {
  let exitSpy;
  let errSpy;
  let logSpy;

  beforeEach(() => {
    resetMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`__EXIT__${code ?? 0}`);
    });
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("--help prints help and exits 0", async () => {
    await expect(runInstallerCli(["--help"])).rejects.toThrow("__EXIT__0");
    const out = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(out).toContain("--project");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("-h prints help and exits 0", async () => {
    await expect(runInstallerCli(["-h"])).rejects.toThrow("__EXIT__0");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("--project (no value) exits 1", async () => {
    await expect(runInstallerCli(["--project"])).rejects.toThrow("__EXIT__1");
    const err = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(err).toContain("requires a path argument");
  });

  it("--project with whitespace-only exits 1", async () => {
    await expect(runInstallerCli(["--project", "   "])).rejects.toThrow("__EXIT__1");
    const err = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(err).toContain("cannot be empty");
  });

  it("--project <path> reaches projectSetup", async () => {
    fs.stat.mockRejectedValue(enoent("/tmp/test-path"));
    await expect(runInstallerCli(["--project", "/tmp/test-path"])).rejects.toThrow(/__EXIT__1/);
    expect(fs.stat).toHaveBeenCalledWith(path.resolve("/tmp/test-path"));
  });

  it("no args routes to main() interactive flow", async () => {
    try { await runInstallerCli([]); } catch (err) {
      expect(String(err.message)).toMatch(/__EXIT__/);
    }
    expect(existsSync).toHaveBeenCalled();
  });

  it("runInstallerCli is an async function", () => {
    expect(runInstallerCli.constructor.name).toBe("AsyncFunction");
  });
});
