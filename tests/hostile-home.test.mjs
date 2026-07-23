/**
 * B16/AC-12 hostile-home integration: homes containing apostrophes (and
 * spaces) must not break hook ownership. shellQuote emits the POSIX '\''
 * idiom; ownership tokenization must parse it back to the exact shim path,
 * or every explicit install stacks a duplicate hook group while freshness's
 * exact-equality leg keeps reporting fresh (round-3 blocker F2: claude 2→4,
 * codex 3→6, hermes 2→4 hooks on a second install under an O'Brien home).
 */

import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import YAML from "yaml";

import { makeTestEnv, diffSnapshots } from "./helpers/test-env.mjs";
import { runSelfRepair } from "../install.mjs";
import { Claude } from "../shared/clients/claude.mjs";
import { Codex } from "../shared/clients/codex.mjs";
import { Hermes } from "../shared/clients/hermes.mjs";
import { buildShimBody, stableShimPath } from "../shared/clients/shim.mjs";

const IS_WIN = process.platform === "win32";
const DURABLE = { context: { kind: "durable", path: "/durable/install" } };

const jsonHookCommands = (text) => Object.values(JSON.parse(text).hooks || {})
  .flat().flatMap((g) => g.hooks || []).map((h) => h.command);

const CLIENTS = [
  {
    id: "claude",
    make: () => new Claude(),
    file: (paths) => paths.claudeSettings,
    commands: jsonHookCommands,
  },
  {
    id: "codex",
    make: () => new Codex(),
    file: (paths) => paths.codexHooks,
    commands: jsonHookCommands,
  },
  {
    id: "hermes",
    make: () => new Hermes(),
    file: (paths) => paths.hermesConfig,
    commands: (text) => Object.values(YAML.parse(text).hooks || {})
      .flat().map((h) => h.command),
  },
];

describe.each(CLIENTS)("$id — hostile home ownership (B16)", ({ id, make, file, commands }) => {
  it.each([["o'brien"], ["O'Brien home"]])(
    "home %j: install idempotent, repair converges shim + exec, zero churn when canonical",
    async (homeName) => {
      const env = await makeTestEnv({ clients: [id], homeName });
      try {
        const client = make();
        const configFile = file(env.paths);

        await client.installGlobal();
        const first = commands(await fs.readFile(configFile, "utf8"));
        expect(first.length).toBeGreaterThan(0);
        expect(await client.isFresh()).toBe(true);

        // second explicit install must not stack duplicate hook groups
        await client.installGlobal();
        expect(commands(await fs.readFile(configFile, "utf8"))).toEqual(first);

        // stale shim body → repair restores the canonical body
        const shim = stableShimPath(id);
        await fs.writeFile(shim, "#!/bin/sh\n/old/stale hook\n", "utf8");
        expect(await client.isFresh()).toBe(false);
        await runSelfRepair(DURABLE);
        expect(await fs.readFile(shim, "utf8")).toBe(buildShimBody(id));
        expect(await client.isFresh()).toBe(true);

        // stripped exec bit → repair restores it
        if (!IS_WIN) {
          await fs.chmod(shim, 0o644);
          expect(await client.isFresh()).toBe(false);
          await runSelfRepair(DURABLE);
          expect(((await fs.stat(shim)).mode & 0o111) !== 0).toBe(true);
        }

        // converged: another repair is a zero-write, zero-mtime no-op
        const before = await env.snapshot();
        await runSelfRepair(DURABLE);
        expect(diffSnapshots(before, await env.snapshot())).toEqual([]);
        expect(commands(await fs.readFile(configFile, "utf8"))).toEqual(first);
      } finally {
        await env.restore();
      }
    },
  );
});
