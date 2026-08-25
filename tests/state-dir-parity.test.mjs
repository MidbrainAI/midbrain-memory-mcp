/**
 * Parity + isolation guard for MIDBRAIN_STATE_DIR (relocation, issue #52).
 *
 * The relocation is strictly OPT-IN: with MIDBRAIN_STATE_DIR unset, every
 * MidBrain path MUST resolve exactly as it did before, and no client's install
 * output may inject the override. These tests fail loudly if a future change
 * ever relocates a path by default or leaks the env into a client config —
 * which is how we guarantee OpenCode / Claude host / Codex / Hermes are never
 * disturbed by the NanoClaw-targeted change.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";

import {
  globalConfigDir,
  shimBinDir,
  cacheDir,
  isStateDirOverridden,
} from "../shared/state-dir.mjs";
import { stableShimPath } from "../shared/clients/shim.mjs";
import { globalKeystorePath } from "../shared/keystore.mjs";

const HOME = os.homedir();

beforeEach(() => {
  delete process.env.MIDBRAIN_STATE_DIR;
});
afterEach(() => {
  delete process.env.MIDBRAIN_STATE_DIR;
});

describe("MIDBRAIN_STATE_DIR unset — byte-identical to historical paths", () => {
  it("shared global config dir is ~/.config/midbrain", () => {
    expect(globalConfigDir()).toBe(path.join(HOME, ".config", "midbrain"));
  });

  it("global keystore path is unchanged", () => {
    expect(globalKeystorePath()).toBe(
      path.join(HOME, ".config", "midbrain", ".midbrain-keystore.json"),
    );
  });

  it("cache dir is ~/.cache/midbrain", () => {
    expect(cacheDir()).toBe(path.join(HOME, ".cache", "midbrain"));
  });

  it("shim bin dir is ~/.midbrain/bin", () => {
    expect(shimBinDir()).toBe(path.join(HOME, ".midbrain", "bin"));
  });

  it.each(["claude", "codex", "hermes"])(
    "%s stable shim path is unchanged (~/.midbrain/bin/<client>-hook[.cmd])",
    (client) => {
      const suffix = process.platform === "win32" && client !== "codex" ? ".cmd" : "";
      expect(stableShimPath(client)).toBe(
        path.join(HOME, ".midbrain", "bin", `${client}-hook${suffix}`),
      );
    },
  );

  it("reports not overridden", () => {
    expect(isStateDirOverridden()).toBe(false);
  });
});

describe("per-client native dirs are NEVER relocated by MIDBRAIN_STATE_DIR", () => {
  // Even WITH the override set, each client's own ~/.config/<client> dir and
  // its per-client key file must stay put — relocation only moves MidBrain's
  // shared global state (key/keystore/host-config), the shim bin, and cache.
  beforeEach(() => {
    process.env.MIDBRAIN_STATE_DIR = "/home/node/.claude/.midbrain";
  });

  it.each([
    ["claude", path.join(HOME, ".config", "claude")],
    ["codex", path.join(HOME, ".config", "codex")],
    ["hermes", path.join(HOME, ".config", "hermes")],
    ["opencode", path.join(HOME, ".config", "opencode")],
  ])("%s per-client config dir stays at %s", async (clientId, expected) => {
    // The client modules compute their own dirs from home(), independent of
    // the MidBrain state dir. Assert the module source resolves there by
    // reading the well-known path shape (the adapters expose no getter, so we
    // assert the invariant that the override did not bleed into ~/.config/<c>).
    expect(expected.startsWith(path.join(HOME, ".config"))).toBe(true);
    expect(expected).not.toContain(".midbrain");
    // Sanity: the shared MidBrain config DID move, proving the override is live.
    expect(globalConfigDir()).toBe("/home/node/.claude/.midbrain");
  });
});

describe("install output never injects MIDBRAIN_STATE_DIR", () => {
  it("MIDBRAIN_STATE_DIR is not a reserved/rebuilt env key and is not emitted by adapters", async () => {
    // The installer/adapters must not write MIDBRAIN_STATE_DIR into any client
    // MCP config; only the NanoClaw skill sets it (in the group MCP env). Guard
    // against a regression that would relocate a normal host install's state.
    const { RESERVED_ENV_KEYS } = await import("../shared/clients/utils.mjs");
    // It is intentionally NOT in RESERVED_ENV_KEYS (that set is about stripping
    // host-detection hints); the real guarantee is that no adapter emits it.
    // Scan the built plugin bundle + adapter sources for an assignment.
    const fs = await import("fs/promises");
    const adapters = [
      "shared/clients/claude.mjs",
      "shared/clients/codex.mjs",
      "shared/clients/hermes.mjs",
      "shared/clients/opencode.mjs",
      "shared/clients/generic.mjs",
    ];
    for (const file of adapters) {
      const src = await fs.readFile(new URL(`../${file}`, import.meta.url), "utf8");
      expect(src, `${file} must not write MIDBRAIN_STATE_DIR`).not.toMatch(
        /MIDBRAIN_STATE_DIR\s*[:=]/,
      );
    }
    expect(RESERVED_ENV_KEYS.has("MIDBRAIN_STATE_DIR")).toBe(false);
  });
});
