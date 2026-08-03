/**
 * Unit tests for shared/state-dir.mjs
 *
 * MIDBRAIN_STATE_DIR relocates MidBrain's durable state under a single base
 * (in NanoClaw: ~/.claude/.midbrain, the durable .claude-shared mount) so the
 * hook shim, API key, keystore, host config, and offline cache survive a cold
 * --rm spawn. It is OPT-IN: unset means every path resolves exactly as before,
 * so host installs are byte-identical.
 */

import { describe, it, expect, afterEach } from "vitest";
import os from "os";
import path from "path";

import {
  stateBaseDir,
  globalConfigDir,
  shimBinDir,
  cacheDir,
  isStateDirOverridden,
} from "../shared/state-dir.mjs";

const HOME = os.homedir();

afterEach(() => {
  delete process.env.MIDBRAIN_STATE_DIR;
});

describe("state-dir defaults (MIDBRAIN_STATE_DIR unset)", () => {
  it("globalConfigDir is ~/.config/midbrain", () => {
    expect(globalConfigDir()).toBe(path.join(HOME, ".config", "midbrain"));
  });

  it("shimBinDir is ~/.midbrain/bin", () => {
    expect(shimBinDir()).toBe(path.join(HOME, ".midbrain", "bin"));
  });

  it("cacheDir is ~/.cache/midbrain", () => {
    expect(cacheDir()).toBe(path.join(HOME, ".cache", "midbrain"));
  });

  it("stateBaseDir is null and isStateDirOverridden is false", () => {
    expect(stateBaseDir()).toBeNull();
    expect(isStateDirOverridden()).toBe(false);
  });
});

describe("state-dir override (MIDBRAIN_STATE_DIR set)", () => {
  const BASE = "/home/node/.claude/.midbrain";

  it("routes config, shim bin, and cache under the base", () => {
    process.env.MIDBRAIN_STATE_DIR = BASE;
    expect(globalConfigDir()).toBe(BASE);
    // The shim keeps a bin/ subdir; combined with the .midbrain base this
    // preserves the .midbrain/bin/<client>-hook tail the ownership regex needs.
    expect(shimBinDir()).toBe(path.join(BASE, "bin"));
    expect(cacheDir()).toBe(path.join(BASE, "cache"));
    expect(stateBaseDir()).toBe(BASE);
    expect(isStateDirOverridden()).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    process.env.MIDBRAIN_STATE_DIR = `  ${BASE}  `;
    expect(globalConfigDir()).toBe(BASE);
  });

  it("an empty or whitespace-only value is treated as unset", () => {
    process.env.MIDBRAIN_STATE_DIR = "   ";
    expect(globalConfigDir()).toBe(path.join(HOME, ".config", "midbrain"));
    expect(isStateDirOverridden()).toBe(false);
  });

  it("the shim bin path still contains the .midbrain/bin tail for ownership matching", () => {
    process.env.MIDBRAIN_STATE_DIR = BASE;
    expect(shimBinDir().replace(/\\/g, "/")).toContain(".midbrain/bin");
  });
});
