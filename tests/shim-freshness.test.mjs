/**
 * AC-11 (PRD-034 rev 3, B14/B15): shim body + exec-mode freshness through the
 * real client adapters, in a sandbox home.
 *
 * Shim existence is not freshness: behind a fully canonical hook config, a
 * stale/foreign shim body or a stripped exec bit must make isFresh() false and
 * repairHooks() must converge the shim (body -> canonical, mode -> 0755)
 * without touching the client config file (content-compared, mtime stable).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import { makeTestEnv } from "./helpers/test-env.mjs";
import { Claude } from "../shared/clients/claude.mjs";
import { Codex } from "../shared/clients/codex.mjs";
import { Hermes } from "../shared/clients/hermes.mjs";
import {
  stableShimPath,
  buildShimBody,
  installShim,
  isDevShimContent,
} from "../shared/clients/shim.mjs";

const IS_WIN = process.platform === "win32";

const staleBody = (client) =>
  `#!/bin/sh\nset +e\n'/private/tmp/gone-checkout/node' '/private/tmp/gone-checkout/index.js' hook ${client} "$@"\nexit 0\n`;

const CLIENTS = [
  { id: "claude", make: () => new Claude(), configFile: (paths) => paths.claudeSettings },
  { id: "codex", make: () => new Codex(), configFile: (paths) => paths.codexHooks },
  { id: "hermes", make: () => new Hermes(), configFile: (paths) => paths.hermesConfig },
];

describe.each(CLIENTS)("$id — shim freshness (AC-11)", ({ id, make, configFile }) => {
  let env;
  let client;

  beforeEach(async () => {
    env = await makeTestEnv({ clients: [id] });
    client = make();
    await client.installGlobal();
  });

  afterEach(async () => {
    await env.restore();
  });

  it("baseline: canonical install is fresh", async () => {
    expect(await client.isFresh()).toBe(true);
  });

  it("B14: unmarked stale shim body behind canonical config is stale and repaired", async () => {
    const shim = stableShimPath(id);
    await fs.writeFile(shim, staleBody(id), "utf8");
    if (!IS_WIN) await fs.chmod(shim, 0o755);

    expect(await client.isFresh()).toBe(false);

    const configPath = configFile(env.paths);
    const configStatBefore = await fs.stat(configPath);
    await new Promise((r) => setTimeout(r, 10));
    await client.repairHooks();

    expect(await fs.readFile(shim, "utf8")).toBe(buildShimBody(id));
    expect(await client.isFresh()).toBe(true);
    // config content was already canonical: content-compared write, mtime stable
    expect((await fs.stat(configPath)).mtimeMs).toBe(configStatBefore.mtimeMs);
  });

  it.skipIf(IS_WIN)("B15: canonical shim without exec mode is stale; repair restores 0755 without rewrite", async () => {
    const shim = stableShimPath(id);
    await fs.chmod(shim, 0o644);
    const before = await fs.stat(shim);

    expect(await client.isFresh()).toBe(false);

    await new Promise((r) => setTimeout(r, 10));
    await client.repairHooks();

    const after = await fs.stat(shim);
    expect(after.mode & 0o777).toBe(0o755);
    expect(after.mtimeMs).toBe(before.mtimeMs); // chmod only, no rewrite
    expect(await client.isFresh()).toBe(true);
  });

  it.skipIf(IS_WIN)("B15-dev: exec-stripped dev shim keeps its bytes and regains exec", async () => {
    await installShim(id, { mode: "install", isDev: true });
    const shim = stableShimPath(id);
    const devBody = await fs.readFile(shim, "utf8");
    expect(isDevShimContent(devBody)).toBe(true);
    await fs.chmod(shim, 0o644);

    expect(await client.isFresh()).toBe(false);

    await client.repairHooks();

    expect(await fs.readFile(shim, "utf8")).toBe(devBody); // dev bytes preserved
    expect((await fs.stat(shim)).mode & 0o777).toBe(0o755);
    expect(await client.isFresh()).toBe(true);
  });
});
