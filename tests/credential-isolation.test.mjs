/**
 * Mock-independent credential isolation regression (PRD-035 S4).
 *
 * These tests exercise the real filesystem writers. Credential bytes are
 * never read or logged; assertions cover placement, permissions, and hash-only
 * equality across the real-home credential surfaces.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import { Codex } from "../shared/clients/codex.mjs";
import { Hermes } from "../shared/clients/hermes.mjs";
import { NanoClaw } from "../shared/clients/nanoclaw.mjs";
import { main } from "../install.mjs";
import { collectHashes, diffHashes, tripwireSurfaces } from "./helpers/global-tripwire.mjs";
import { assertSandboxed, makeTestEnv } from "./helpers/test-env.mjs";

const IS_WIN = process.platform === "win32";
const DUMMY_CREDENTIAL = "dummy-credential-for-isolation";
const REAL_CREDENTIAL_SURFACES = tripwireSurfaces()
  .filter((filePath) => filePath.endsWith(".midbrain-key"));

afterEach(() => {
  vi.restoreAllMocks();
});

async function expectIsolatedWrite({ clients = [], target, write }) {
  const before = collectHashes(REAL_CREDENTIAL_SURFACES);
  const env = await makeTestEnv({ clients });
  try {
    const filePath = target(env);
    await assertSandboxed(env, filePath);
    await write(env);
    const stat = await fs.stat(filePath);
    expect(stat.isFile()).toBe(true);
    // Windows does not enforce POSIX file modes; chmod(0o600) is a no-op there.
    if (!IS_WIN) expect(stat.mode & 0o777).toBe(0o600);
    expect(diffHashes(before, collectHashes(REAL_CREDENTIAL_SURFACES))).toEqual([]);
  } finally {
    await env.restore();
  }
}

describe("credential writers stay inside the test sandbox without filesystem interception", () => {
  it("isolates the Codex adapter writer", async () => {
    await expectIsolatedWrite({
      target: (env) => path.join(env.home, ".config", "codex", ".midbrain-key"),
      write: () => new Codex().writeKey(DUMMY_CREDENTIAL),
    });
  });

  it("isolates the Hermes adapter writer", async () => {
    await expectIsolatedWrite({
      target: (env) => path.join(env.home, ".config", "hermes", ".midbrain-key"),
      write: () => new Hermes().writeKey(DUMMY_CREDENTIAL),
    });
  });

  it("isolates the NanoClaw adapter writer", async () => {
    await expectIsolatedWrite({
      target: (env) => path.join(env.home, ".config", "nanoclaw", ".midbrain-key"),
      write: () => new NanoClaw().writeKey(DUMMY_CREDENTIAL),
    });
  });

  it("isolates the installer global writer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expectIsolatedWrite({
      clients: ["codex"],
      target: (env) => env.paths.globalKey,
      write: async () => {
        process.env.MIDBRAIN_API_KEY = DUMMY_CREDENTIAL;
        await main({ nonInteractive: true, skipRules: true, noLogin: true });
      },
    });
  });
});
