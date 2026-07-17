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
  rm:         vi.fn().mockResolvedValue(undefined),
  access:     vi.fn().mockResolvedValue(undefined),
  existsSync: vi.fn(() => false),
  deviceCodeLogin: vi.fn(),
  readlineAnswers: [],
  readlineQuestions: [],
  createReadlineInterface: vi.fn(),
}));

mocks.createReadlineInterface.mockImplementation(() => ({
  question(question, cb) {
    mocks.readlineQuestions.push(question);
    cb(mocks.readlineAnswers.shift() ?? "");
  },
  close: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: { readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir,
             chmod: mocks.chmod, stat: mocks.stat, realpath: mocks.realpath, copyFile: mocks.copyFile,
             rm: mocks.rm, access: mocks.access },
  readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir, chmod: mocks.chmod,
  rm: mocks.rm, access: mocks.access,
}));
vi.mock("fs", async (importOriginal) => {
  const orig = await importOriginal();
  return { ...orig, existsSync: mocks.existsSync, realpathSync: orig.realpathSync };
});
vi.mock("readline", () => ({
  default: { createInterface: mocks.createReadlineInterface },
  createInterface: mocks.createReadlineInterface,
}));
vi.mock("../shared/device-auth.mjs", () => ({
  deviceCodeLogin: mocks.deviceCodeLogin,
}));

const fs = { readFile: mocks.readFile, writeFile: mocks.writeFile, mkdir: mocks.mkdir,
             chmod: mocks.chmod, stat: mocks.stat, realpath: mocks.realpath, copyFile: mocks.copyFile,
             rm: mocks.rm, access: mocks.access };
const existsSync = mocks.existsSync;
const resetMocks = makeResetMocks(mocks);
const existsFor = makeExistsFor(mocks);
const readFileReturns = makeReadFileReturns(mocks);

const {
  main, setupProject, projectSetup, runInstallerCli, printHelp, checkForUpdate,
  isNewerVersion, selfNpxCacheDir, clearStaleSelfNpxCache, maybeSelfUpdate,
  PKG_VERSION,
} = await import("../install.mjs");

// Versions relative to the running package version, for update-check tests.
function bumpVersion(v, delta) {
  const parts = String(v).split(".").map((n) => parseInt(n, 10) || 0);
  parts[2] += delta;
  return parts.join(".");
}
const NEWER_VERSION = bumpVersion(PKG_VERSION, 1);
const { buildRulesBlock } = await import("../shared/agent-rules.mjs");
const { REPO_ROOT } = await import("../shared/clients/utils.mjs");

describe("isNewerVersion", () => {
  it.each([
    ["0.4.6", "0.4.7", true],
    ["0.4.6", "0.5.0", true],
    ["0.4.6", "0.4.6", false],
    ["0.4.6", "0.4.5", false],
  ])("compares valid stable versions: %s -> %s", (current, latest, expected) => {
    expect(isNewerVersion(current, latest)).toBe(expected);
  });

  it.each([
    ["0.4.6junk", "0.4.7"],
    ["unknown", "0.4.7"],
    ["0.4", "0.4.7"],
    ["0.4.6-alpha", "0.4.7"],
    [" 0.4.6", "0.4.7"],
    [406, "0.4.7"],
    ["0.4.6", "0.4.7junk"],
    ["0.4.6", "0.4.7+build"],
    ["0.4.6", "0.4"],
    ["0.4.6", 407],
  ])("rejects a non-X.Y.Z comparator input: %s -> %s", (current, latest) => {
    expect(isNewerVersion(current, latest)).toBe(false);
  });
});

const HOME = os.homedir();

const PATHS = {
  globalKey:        path.join(HOME, ".config", "midbrain", ".midbrain-key"),
  opencodeKey:      path.join(HOME, ".config", "opencode", ".midbrain-key"),
  claudeKey:        path.join(HOME, ".config", "claude", ".midbrain-key"),
  codexKey:         path.join(HOME, ".config", "codex", ".midbrain-key"),
  nanoclawKey:      path.join(HOME, ".config", "nanoclaw", ".midbrain-key"),
  hermesKey:        path.join(HOME, ".config", "hermes", ".midbrain-key"),
  opencodeConfig:   path.join(HOME, ".config", "opencode", "opencode.json"),
  claudeJson:       path.join(HOME, ".claude.json"),
  codexConfig:      path.join(HOME, ".codex", "config.toml"),
  codexHooks:       path.join(HOME, ".codex", "hooks.json"),
  codexShim:        path.join(HOME, ".midbrain", "bin", "codex-hook"),
  nanoclawDocker:   path.join(HOME, "nanoclaw-v2", "container", "Dockerfile"),
  nanoclawSkills:   path.join(HOME, "nanoclaw-v2", ".claude", "skills"),
  nanoclawSkill:    path.join(HOME, "nanoclaw-v2", ".claude", "skills", "add-midbrain", "SKILL.md"),
  hermesConfig:     path.join(HOME, ".hermes", "config.yaml"),
};
const NANOCLAW_SKILL_SRC = path.join(REPO_ROOT, "skills", "nanoclaw", "SKILL.md");

const PROJECT_DIR = "/home/testuser/myproject";

function fileError(code, filePath) {
  const err = new Error(`${code}: test failure, open '${filePath}'`);
  err.code = code;
  return err;
}

function withStdinIsTTY(value) {
  const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  return () => {
    if (desc) Object.defineProperty(process.stdin, "isTTY", desc);
    else delete process.stdin.isTTY;
  };
}

// ===================================================================
// main() — per-client key writing
// ===================================================================

describe("main — per-client key writing", () => {
  let logSpy;
  const savedEnv = {};

  beforeEach(() => {
    resetMocks();
    mocks.deviceCodeLogin.mockReset();
    mocks.deviceCodeLogin.mockResolvedValue({
      apiKey: "device-api-key",
      agentId: "agent-123",
      agentName: "My Agent",
      keyAlias: "CLI key",
    });
    mocks.readlineAnswers = [];
    mocks.readlineQuestions = [];
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

  it("default interactive no-key install uses device login and writes global key only", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig);
      mocks.readlineAnswers = ["1"];

      await runInstallerCli(["--no-rules"]);

      expect(mocks.deviceCodeLogin).toHaveBeenCalledTimes(1);
      const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
      const clientWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
      expect(globalWrite?.[1]).toBe("device-api-key\n");
      // Single client + shared key => no per-client key file written.
      expect(clientWrite).toBeUndefined();
    } finally {
      restoreTTY();
    }
  });

  it("existing key install skips device login and writes global key only", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig);
      readFileReturns({ [PATHS.opencodeKey]: "existing-key\n" });

      await runInstallerCli(["--no-rules"]);

      expect(mocks.deviceCodeLogin).not.toHaveBeenCalled();
      const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
      const clientWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
      expect(globalWrite?.[1]).toBe("existing-key\n");
      // One detected client with one key => shared, global only.
      expect(clientWrite).toBeUndefined();
    } finally {
      restoreTTY();
    }
  });

  it("--login forces device login and writes global key only", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig);
      readFileReturns({ [PATHS.opencodeKey]: "existing-key\n" });

      await runInstallerCli(["--login", "--no-rules"]);

      expect(mocks.deviceCodeLogin).toHaveBeenCalledTimes(1);
      const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
      const clientWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
      expect(globalWrite?.[1]).toBe("device-api-key\n");
      expect(clientWrite).toBeUndefined();
    } finally {
      restoreTTY();
    }
  });

  it("--no-login suppresses device login and uses manual key entry (global only)", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig);
      mocks.readlineAnswers = ["manual-api-key"];

      await runInstallerCli(["--no-login", "--no-rules"]);

      expect(mocks.deviceCodeLogin).not.toHaveBeenCalled();
      expect(mocks.readlineQuestions.join("\n")).toContain("Enter MidBrain API key");
      const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
      const clientWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
      expect(globalWrite?.[1]).toBe("manual-api-key\n");
      // Manual entry for a single client => one key, shared, global only.
      expect(clientWrite).toBeUndefined();
    } finally {
      restoreTTY();
    }
  });

  it("--no-login wins when both --login and --no-login are present", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig);
      mocks.readlineAnswers = ["manual-api-key"];

      await runInstallerCli(["--login", "--no-login", "--no-rules"]);

      expect(mocks.deviceCodeLogin).not.toHaveBeenCalled();
      const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
      expect(globalWrite?.[1]).toBe("manual-api-key\n");
    } finally {
      restoreTTY();
    }
  });

  it("writes global key only for a single detected client (OpenCode)", async () => {
    // Single client + single key => shared; only the global key file is written.
    existsFor(PATHS.opencodeConfig);
    readFileReturns({ [PATHS.opencodeKey]: "my-oc-key\n" });

    await main();

    const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
    expect(globalWrite).toBeDefined();
    expect(globalWrite[1]).toBe("my-oc-key\n");

    const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
    expect(ocWrite).toBeUndefined();
  });

  it("writes global key only for a single detected client (Claude Code)", async () => {
    existsFor(PATHS.claudeJson);
    readFileReturns({ [PATHS.claudeKey]: "my-cc-key\n" });

    await main();

    const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
    expect(globalWrite).toBeDefined();
    expect(globalWrite[1]).toBe("my-cc-key\n");

    const ccWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeKey);
    expect(ccWrite).toBeUndefined();
  });

  it("writes global key only when two clients share the same existing key", async () => {
    existsFor(PATHS.opencodeConfig, PATHS.claudeJson);
    readFileReturns({
      [PATHS.opencodeKey]: "shared-key\n",
      [PATHS.claudeKey]: "shared-key\n",
    });

    await main();

    const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
    expect(globalWrite?.[1]).toBe("shared-key\n");

    // Identical keys => treated as shared, no per-client files written.
    const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
    const ccWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeKey);
    expect(ocWrite).toBeUndefined();
    expect(ccWrite).toBeUndefined();
  });

  it("preserves distinct per-client keys already present on disk without rewriting them", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig, PATHS.hermesConfig);
      readFileReturns({
        [PATHS.opencodeKey]: "oc-key\n",
        [PATHS.hermesKey]: "hermes-key\n",
      });

      await main();

      const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
      const hermesWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.hermesKey);
      expect(ocWrite).toBeUndefined();
      expect(hermesWrite).toBeUndefined();
    } finally {
      restoreTTY();
    }
  });

  it("asks to share the key and writes global only when the user answers yes", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig, PATHS.claudeJson);
      // [1] choose device login, then "" (default Yes) to the share prompt.
      mocks.readlineAnswers = ["1", ""];

      await runInstallerCli(["--no-rules"]);

      expect(mocks.readlineQuestions.join("\n")).toContain("Use the same key for all detected clients");
      const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
      expect(globalWrite?.[1]).toBe("device-api-key\n");

      const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
      const ccWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeKey);
      expect(ocWrite).toBeUndefined();
      expect(ccWrite).toBeUndefined();
    } finally {
      restoreTTY();
    }
  });

  it("prompts per client and writes per-client keys when the user declines sharing", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig, PATHS.claudeJson);
      // [1] device login, "n" to share prompt, then a key per detected client.
      mocks.readlineAnswers = ["1", "n", "oc-distinct", "cc-distinct"];

      await runInstallerCli(["--no-rules"]);

      const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
      expect(globalWrite).toBeDefined();

      const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
      const ccWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeKey);
      expect(ocWrite?.[1]).toBe("oc-distinct\n");
      expect(ccWrite?.[1]).toBe("cc-distinct\n");
    } finally {
      restoreTTY();
    }
  });

  it("paste path: asks to share and writes global only when the user answers yes", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig, PATHS.claudeJson);
      // [2] paste, the pasted key, then "" (default Yes) to the share prompt.
      mocks.readlineAnswers = ["2", "pasted-key", ""];

      await runInstallerCli(["--no-rules"]);

      expect(mocks.deviceCodeLogin).not.toHaveBeenCalled();
      expect(mocks.readlineQuestions.join("\n")).toContain("Use the same key for all detected clients");
      const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
      expect(globalWrite?.[1]).toBe("pasted-key\n");

      const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
      const ccWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeKey);
      expect(ocWrite).toBeUndefined();
      expect(ccWrite).toBeUndefined();
    } finally {
      restoreTTY();
    }
  });

  it("paste path: prompts per client when the user declines sharing", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig, PATHS.claudeJson);
      // [2] paste, initial key (discarded on decline), "n", then a key per client.
      mocks.readlineAnswers = ["2", "ignored-key", "n", "oc-distinct", "cc-distinct"];

      await runInstallerCli(["--no-rules"]);

      const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
      const ccWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeKey);
      expect(ocWrite?.[1]).toBe("oc-distinct\n");
      expect(ccWrite?.[1]).toBe("cc-distinct\n");
    } finally {
      restoreTTY();
    }
  });

  it("paste path: single client writes global only without a share prompt", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig);
      mocks.readlineAnswers = ["2", "solo-key"];

      await runInstallerCli(["--no-rules"]);

      expect(mocks.readlineQuestions.join("\n")).not.toContain("Use the same key for all detected clients");
      const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
      expect(globalWrite?.[1]).toBe("solo-key\n");
      const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
      expect(ocWrite).toBeUndefined();
    } finally {
      restoreTTY();
    }
  });

  it("device login failure falls back to single paste + share question", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig, PATHS.claudeJson);
      mocks.deviceCodeLogin.mockRejectedValueOnce(new Error("login boom"));
      // [1] login (fails), pasted fallback key, "" (default Yes) to share.
      mocks.readlineAnswers = ["1", "fallback-key", ""];

      await runInstallerCli(["--no-rules"]);

      const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
      expect(globalWrite?.[1]).toBe("fallback-key\n");
      const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
      const ccWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeKey);
      expect(ocWrite).toBeUndefined();
      expect(ccWrite).toBeUndefined();
    } finally {
      restoreTTY();
    }
  });

  it("--no-login with multiple clients uses single paste + share question", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig, PATHS.claudeJson);
      // No auth menu shown; single paste then "" (default Yes) to share.
      mocks.readlineAnswers = ["nologin-key", ""];

      await runInstallerCli(["--no-login", "--no-rules"]);

      expect(mocks.deviceCodeLogin).not.toHaveBeenCalled();
      expect(mocks.readlineQuestions.join("\n")).toContain("Use the same key for all detected clients");
      const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
      expect(globalWrite?.[1]).toBe("nologin-key\n");
      const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
      const ccWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeKey);
      expect(ocWrite).toBeUndefined();
      expect(ccWrite).toBeUndefined();
    } finally {
      restoreTTY();
    }
  });

  it("partial fill: prompts only for the client missing a key", async () => {
    const restoreTTY = withStdinIsTTY(true);
    try {
      existsFor(PATHS.opencodeConfig, PATHS.claudeJson);
      // OpenCode already has a key on disk; only Claude should be prompted.
      readFileReturns({ [PATHS.opencodeKey]: "oc-existing\n" });
      mocks.readlineAnswers = ["cc-new"];

      await runInstallerCli(["--no-rules"]);

      // No auth menu / share prompt in the partial-fill path.
      expect(mocks.readlineQuestions.join("\n")).not.toContain("How would you like to authenticate");
      expect(mocks.readlineQuestions.join("\n")).toContain("Enter MidBrain API key for Claude Code");
      // Distinct keys => preserve the existing client file and write only the new one.
      const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
      const ccWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeKey);
      expect(ocWrite).toBeUndefined();
      expect(ccWrite?.[1]).toBe("cc-new\n");
    } finally {
      restoreTTY();
    }
  });

  it("writes global key only for a single detected client (Codex)", async () => {
    existsFor(PATHS.codexConfig);
    readFileReturns({ [PATHS.codexKey]: "my-codex-key\n" });

    await main();

    const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
    expect(globalWrite?.[1]).toBe("my-codex-key\n");

    const codexWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexKey);
    expect(codexWrite).toBeUndefined();

    const configWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexConfig);
    expect(configWrite).toBeDefined();
  });

  it("--non-interactive fails cleanly when no detected client has a key", async () => {
    existsFor(PATHS.opencodeConfig);

    await expect(main({ nonInteractive: true })).rejects.toThrow(/No API key found/);

    const writes = fs.writeFile.mock.calls.map(([, value]) => String(value));
    expect(writes).not.toContain("undefined\n");
    expect(writes).not.toContain("\n");
  });

  it("no-TTY mode behaves like explicit --non-interactive", async () => {
    const originalIsTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    existsFor(PATHS.opencodeConfig);

    await expect(main()).rejects.toThrow(/No API key found/);

    const writes = fs.writeFile.mock.calls.map(([, value]) => String(value));
    expect(writes).not.toContain("undefined\n");
    if (originalIsTty === undefined) delete process.stdin.isTTY;
    else Object.defineProperty(process.stdin, "isTTY", { value: originalIsTty, configurable: true });
  });

  it("--non-interactive uses an existing client key without prompting (global only)", async () => {
    existsFor(PATHS.opencodeConfig);
    readFileReturns({ [PATHS.opencodeKey]: "existing-key\n" });

    await main({ nonInteractive: true });

    const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
    const clientWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
    expect(globalWrite?.[1]).toBe("existing-key\n");
    // Non-interactive never splits keys — global only.
    expect(clientWrite).toBeUndefined();
  });

  it("--non-interactive uses distinct existing client keys as global only", async () => {
    existsFor(PATHS.opencodeConfig, PATHS.claudeJson);
    readFileReturns({
      [PATHS.opencodeKey]: "oc-existing\n",
      [PATHS.claudeKey]: "cc-existing\n",
    });

    await main({ nonInteractive: true });

    const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
    expect(globalWrite?.[1]).toBe("oc-existing\n");

    const ocWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
    const ccWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.claudeKey);
    expect(ocWrite).toBeUndefined();
    expect(ccWrite).toBeUndefined();
  });

  it("--non-interactive uses MIDBRAIN_API_KEY through shared key resolution (global only)", async () => {
    process.env.MIDBRAIN_API_KEY = "env-fallback-key";
    existsFor(PATHS.opencodeConfig);

    await main({ nonInteractive: true });

    const globalWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.globalKey);
    const clientWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.opencodeKey);
    expect(globalWrite?.[1]).toBe("env-fallback-key\n");
    expect(clientWrite).toBeUndefined();
  });
});

// ===================================================================
// checkForUpdate() — startup freshness repair
// ===================================================================

describe("checkForUpdate — NanoClaw startup repair", () => {
  let logSpy;
  let errSpy;
  let fetchSpy;

  beforeEach(() => {
    resetMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it("repairs stale NanoClaw skill during startup without stdout", async () => {
    existsFor(PATHS.nanoclawDocker, PATHS.nanoclawSkills, PATHS.nanoclawSkill);
    readFileReturns({
      [NANOCLAW_SKILL_SRC]: "packaged skill\n",
      [PATHS.nanoclawSkill]: "stale skill\n",
    });

    await checkForUpdate();

    const copiedSkill = fs.copyFile.mock.calls.some(([, dst]) => dst === PATHS.nanoclawSkill);
    expect(copiedSkill).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("NanoClaw skill repaired");
  });

  it("repairs stale Codex direct hook commands during startup without stdout", async () => {
    existsFor(PATHS.codexConfig, PATHS.codexHooks);
    readFileReturns({
      [PATHS.codexHooks]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ command: "old capture-user.mjs" }] }],
          PostToolUse: [{ hooks: [{ command: "old capture-tool.mjs" }] }],
          Stop: [{ hooks: [{ command: "old capture-assistant.mjs" }] }],
        },
      }),
    });

    await checkForUpdate();

    const hooksWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexHooks);
    const shimWrite = fs.writeFile.mock.calls.find(([p]) => p === PATHS.codexShim);
    expect(hooksWrite).toBeDefined();
    expect(hooksWrite[1]).toContain(PATHS.codexShim);
    expect(shimWrite).toBeDefined();
    expect(fs.chmod).toHaveBeenCalledWith(PATHS.codexShim, 0o755);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("Codex hooks repaired");
  });

  it("does not rewrite already-stable Codex hooks during startup", async () => {
    existsFor(PATHS.codexConfig, PATHS.codexHooks, PATHS.codexShim);
    readFileReturns({
      [PATHS.codexHooks]: JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ command: `'${PATHS.codexShim}' user` }] }],
          PostToolUse: [{ hooks: [{ command: `'${PATHS.codexShim}' tool` }] }],
          Stop: [{ hooks: [{ command: `'${PATHS.codexShim}' assistant` }] }],
        },
      }),
    });

    await checkForUpdate();

    const hooksWrites = fs.writeFile.mock.calls.filter(([p]) => p === PATHS.codexHooks);
    expect(hooksWrites).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => c.join(" ")).join("\n")).not.toContain("Codex hooks repaired");
  });
});

// ===================================================================
// npx self-heal — selfNpxCacheDir / clearStaleSelfNpxCache
// ===================================================================

describe("selfNpxCacheDir", () => {
  it("returns the hash dir for a POSIX _npx install path", () => {
    const dir = "/home/u/.npm/_npx/abc123/node_modules/midbrain-memory-mcp";
    expect(selfNpxCacheDir(dir)).toBe("/home/u/.npm/_npx/abc123");
  });

  it("returns the hash dir for a Windows _npx install path", () => {
    const dir = "C:\\Users\\Radu\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\midbrain-memory-mcp";
    const result = selfNpxCacheDir(dir);
    expect(result).toContain("_npx");
    expect(result.split(/[\\/]+/).pop()).toBe("abc123");
  });

  it("returns null when not under _npx", () => {
    expect(selfNpxCacheDir("/usr/lib/node_modules/midbrain-memory-mcp")).toBeNull();
  });

  it("returns null for empty or non-string input", () => {
    expect(selfNpxCacheDir("")).toBeNull();
    expect(selfNpxCacheDir(undefined)).toBeNull();
  });

  it("returns null when _npx is the last segment (no hash dir)", () => {
    expect(selfNpxCacheDir("/home/u/.npm/_npx")).toBeNull();
  });
});

describe("clearStaleSelfNpxCache", () => {
  let errSpy;
  const NPX_DIR = "/home/u/.npm/_npx/abc123/node_modules/midbrain-memory-mcp";
  const HASH_DIR = "/home/u/.npm/_npx/abc123";

  beforeEach(() => {
    resetMocks();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errSpy.mockRestore());

  it("removes the self-verified hash dir and logs to stderr", async () => {
    readFileReturns({
      [path.join(HASH_DIR, "node_modules", "midbrain-memory-mcp", "package.json")]:
        JSON.stringify({ name: "midbrain-memory-mcp" }),
    });
    const removed = await clearStaleSelfNpxCache(NPX_DIR, NEWER_VERSION);
    expect(removed).toBe(true);
    const rmCall = fs.rm.mock.calls.find(([p]) => p === HASH_DIR);
    expect(rmCall).toBeDefined();
    expect(rmCall[1]).toMatchObject({ recursive: true, force: true });
    expect(errSpy.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("Cleared stale npx cache");
  });

  it("does not remove when the dir is not an _npx cache", async () => {
    const removed = await clearStaleSelfNpxCache("/usr/lib/node_modules/midbrain-memory-mcp", NEWER_VERSION);
    expect(removed).toBe(false);
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it("does not remove when self package is absent (self-verification fails)", async () => {
    const removed = await clearStaleSelfNpxCache(NPX_DIR, NEWER_VERSION);
    expect(removed).toBe(false);
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", "not-json"],
    ["mismatched", JSON.stringify({ name: "another-package" })],
  ])("does not remove when package metadata is %s", async (_label, metadata) => {
    readFileReturns({
      [path.join(HASH_DIR, "node_modules", "midbrain-memory-mcp", "package.json")]: metadata,
    });
    const removed = await clearStaleSelfNpxCache(NPX_DIR, NEWER_VERSION);
    expect(removed).toBe(false);
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it("never throws when fs.rm fails", async () => {
    readFileReturns({
      [path.join(HASH_DIR, "node_modules", "midbrain-memory-mcp", "package.json")]:
        JSON.stringify({ name: "midbrain-memory-mcp" }),
    });
    mocks.rm.mockRejectedValue(new Error("rm boom"));
    await expect(clearStaleSelfNpxCache(NPX_DIR, NEWER_VERSION)).resolves.toBe(false);
  });
});

// ===================================================================
// checkForUpdate / maybeSelfUpdate — version phase
// ===================================================================

describe("checkForUpdate — version phase", () => {
  let errSpy;
  let fetchSpy;
  const cachePath = path.join(os.tmpdir(), ".midbrain-update-check.json");

  beforeEach(() => {
    resetMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Throttle cache stale => fetch runs. readFile rejects by default (no cache file).
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ version: NEWER_VERSION }),
    });
  });
  afterEach(() => {
    errSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it("advises npm update -g for a stale global (non-npx) install", async () => {
    // __dirname of install.mjs is the repo root — not an _npx path.
    await checkForUpdate();
    const err = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(err).toContain("Update available");
    expect(err).toContain("npm update -g midbrain-memory-mcp");
    // Global path must not touch the npx cache.
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it("does not advise when already at latest", async () => {
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ version: PKG_VERSION }) });
    await checkForUpdate();
    const err = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(err).not.toContain("Update available");
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it("skips fetch when the throttle cache is fresh", async () => {
    readFileReturns({ [cachePath]: JSON.stringify({ lastCheck: Date.now(), latestVersion: NEWER_VERSION }) });
    await checkForUpdate();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it("re-checks when the throttle cache is stale", async () => {
    readFileReturns({ [cachePath]: JSON.stringify({ lastCheck: 0, latestVersion: PKG_VERSION }) });
    await checkForUpdate();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("never throws when fetch rejects", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    await expect(checkForUpdate()).resolves.toBeUndefined();
  });
});

describe("maybeSelfUpdate", () => {
  let errSpy;
  let fetchSpy;
  const cachePath = path.join(os.tmpdir(), ".midbrain-update-check.json");

  beforeEach(() => {
    resetMocks();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ version: NEWER_VERSION }),
    });
  });
  afterEach(() => {
    errSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it("does not write stdout and never throws on fetch failure", async () => {
    fetchSpy.mockRejectedValue(new Error("boom"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(maybeSelfUpdate()).resolves.toBeUndefined();
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it.each([
    ["network rejection", () => Promise.reject(new Error("network down"))],
    ["abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    }],
    ["non-OK response", () => Promise.resolve({ ok: false })],
    ["invalid JSON", () => Promise.resolve({
      ok: true,
      json: async () => { throw new SyntaxError("invalid JSON"); },
    })],
    ["unusable version", () => Promise.resolve({
      ok: true,
      json: async () => ({ version: "0.4.7junk" }),
    })],
  ])("throttles an immediate retry after %s", async (_label, attempt) => {
    fetchSpy.mockImplementation(attempt);

    await expect(maybeSelfUpdate()).resolves.toBeUndefined();

    const cacheWrite = mocks.writeFile.mock.calls.find(([filePath]) => filePath === cachePath);
    expect(cacheWrite).toBeDefined();
    const cacheRecord = JSON.parse(cacheWrite[1]);
    expect(cacheRecord.lastCheck).toEqual(expect.any(Number));
    expect(cacheRecord).not.toHaveProperty("latestVersion");

    readFileReturns({ [cachePath]: cacheWrite[1] });
    await expect(maybeSelfUpdate()).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps failure-throttle cache write errors non-fatal", async () => {
    fetchSpy.mockRejectedValue(new Error("network down"));
    mocks.writeFile.mockRejectedValue(new Error("read-only temp dir"));

    await expect(maybeSelfUpdate()).resolves.toBeUndefined();
    expect(mocks.writeFile).toHaveBeenCalledWith(
      cachePath,
      expect.any(String),
      "utf8",
    );
  });

  it("does not touch the npx cache when running from a non-npx install", async () => {
    // install.mjs __dirname is the repo root — clearStaleSelfNpxCache bails on it.
    await maybeSelfUpdate();
    expect(fs.rm).not.toHaveBeenCalled();
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

  it("resolves an existing target project key without requiring a global key", async () => {
    setupProjectMocks({ existingProjectKey: true });
    const keyPath = path.join(PROJECT_DIR, ".midbrain", ".midbrain-key");
    readFileReturns({ [keyPath]: "project-only-key\n" });

    const result = await setupProject(PROJECT_DIR, { skipRules: true });

    expect(result.keyCreated).toBe(false);
    expect(result.lines.join("\n")).toContain(`Key resolved from: ${keyPath}`);
    expect(result.lines.join("\n")).toContain("Existing project key preserved.");
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

// ===================================================================
// setupProject — rules integration (T-20 through T-24)
// ===================================================================

describe("setupProject — rules integration", () => {
  const savedEnv = {};

  function setupRulesMocks(opts = {}) {
    const {
      projectDir = PROJECT_DIR,
      apiKey = "test-api-key-1234",
      extraFiles = {},
    } = opts;

    fs.stat.mockImplementation(async (p) => {
      if (p === projectDir) return { isDirectory: () => true };
      throw enoent(p);
    });
    fs.realpath.mockImplementation(async (p) => p);
    readFileReturns({ [PATHS.globalKey]: apiKey + "\n", ...extraFiles });
    existsFor(PATHS.opencodeConfig);
  }

  beforeEach(() => {
    resetMocks();
    for (const k of ["MIDBRAIN_API_KEY", "MIDBRAIN_PROJECT_DIR", "MIDBRAIN_CONFIG_DIR"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it("T-20: fresh dir — rulesWritten includes AGENTS.md and CLAUDE.md", async () => {
    setupRulesMocks();
    const result = await setupProject(PROJECT_DIR, { apiKey: "test-key" });
    expect(result.rulesWritten).toContain(path.join(PROJECT_DIR, "AGENTS.md"));
    expect(result.rulesWritten).toContain(path.join(PROJECT_DIR, "CLAUDE.md"));
  });

  it("T-20b: fresh dir — lines[] mentions AGENTS.md and CLAUDE.md written", async () => {
    setupRulesMocks();
    const result = await setupProject(PROJECT_DIR, { apiKey: "test-key" });
    const joined = result.lines.join("\n");
    expect(joined).toContain("AGENTS.md");
    expect(joined).toContain("CLAUDE.md");
  });

  it("T-21: second call — rulesWritten is empty; files unchanged", async () => {
    setupRulesMocks();
    const r1 = await setupProject(PROJECT_DIR, { apiKey: "test-key" });
    expect(r1.rulesWritten).toHaveLength(2);

    // Second call: instruction files now contain the current block
    const block = buildRulesBlock();
    setupRulesMocks({
      extraFiles: {
        [path.join(PROJECT_DIR, "AGENTS.md")]: block,
        [path.join(PROJECT_DIR, "CLAUDE.md")]: block,
      },
    });
    const r2 = await setupProject(PROJECT_DIR, { apiKey: "test-key" });
    expect(r2.rulesWritten).toHaveLength(0);
  });

  it("T-22: skipRules: true — no AGENTS.md or CLAUDE.md written; rulesWritten: []", async () => {
    setupRulesMocks();
    const result = await setupProject(PROJECT_DIR, { apiKey: "test-key", skipRules: true });
    const writes = fs.writeFile.mock.calls.map(([p]) => p);
    expect(writes).not.toContain(path.join(PROJECT_DIR, "AGENTS.md"));
    expect(writes).not.toContain(path.join(PROJECT_DIR, "CLAUDE.md"));
    expect(result.rulesWritten).toEqual([]);
  });

  it("T-23: --no-rules CLI — JSON rules_written is []", async () => {
    setupRulesMocks();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    await runInstallerCli(["--project", PROJECT_DIR, "--no-rules"]);
    const stdout = console.log.mock.calls[0]?.[0];
    const parsed = JSON.parse(stdout);
    expect(parsed.rules_written).toEqual([]);
    exitSpy.mockRestore();
  });

  it("T-24: existing custom AGENTS.md — custom content preserved after setupProject", async () => {
    const custom = "# My Agents Rules\nDo something custom.\n";
    setupRulesMocks({
      extraFiles: { [path.join(PROJECT_DIR, "AGENTS.md")]: custom },
    });
    await setupProject(PROJECT_DIR, { apiKey: "test-key" });
    const agentsWrite = fs.writeFile.mock.calls.find(
      ([p]) => p === path.join(PROJECT_DIR, "AGENTS.md")
    );
    expect(agentsWrite).toBeDefined();
    expect(agentsWrite[1]).toContain("# My Agents Rules");
    expect(agentsWrite[1]).toContain("Do something custom.");
    expect(agentsWrite[1]).toContain("<!-- midbrain-memory-rules:start -->");
  });
});
