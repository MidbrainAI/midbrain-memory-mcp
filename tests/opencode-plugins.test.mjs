/**
 * AC-13/AC-14 (PRD-034 rev 3, B17/B18/B19): OpenCode plugin cleanup safety and
 * dev preservation, on the real filesystem in a sandbox home.
 *
 * ~/.config/opencode/plugins/ is a user directory; cleanup may delete only the
 * closed list of artifacts prior releases actually shipped (logger.mjs,
 * midbrain-api.mjs, clients/{base,utils,generic,opencode,claude,codex,
 * registry}.mjs) — never prefix or dirname guesses.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";

import { makeTestEnv } from "./helpers/test-env.mjs";
import { OpenCode } from "../shared/clients/opencode.mjs";

const LEGACY_CLIENTS_FILES = [
  "base.mjs", "utils.mjs", "generic.mjs", "opencode.mjs", "claude.mjs", "codex.mjs", "registry.mjs",
];

let env;
let opencode;
let pd;

beforeEach(async () => {
  env = await makeTestEnv({ clients: ["opencode"] });
  opencode = new OpenCode();
  pd = env.paths.opencodePlugins;
});

afterEach(async () => {
  await env.restore();
});

async function seedFile(rel, content = "user content\n") {
  const file = path.join(pd, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  return file;
}

const exists = async (file) => Boolean(await fs.stat(file).catch(() => null));

describe("opencode — closed-list plugin cleanup (AC-13)", () => {
  it("B17: user-owned files under plugins/ survive repair, including plugins/clients/", async () => {
    const userInClients = await seedFile("clients/user-owned.txt");
    const userPrefixed = await seedFile("midbrain-notes.md"); // user file, midbrain- prefix
    const userDotPrefixed = await seedFile(".midbrain-scratch"); // user file, .midbrain- prefix
    const userPlugin = await seedFile("my-plugin.ts");

    await opencode.repairPlugins();

    expect(await exists(userInClients)).toBe(true);
    expect(await exists(userPrefixed)).toBe(true);
    expect(await exists(userDotPrefixed)).toBe(true);
    expect(await exists(userPlugin)).toBe(true);
    expect(await exists(path.join(pd, "midbrain-memory.ts"))).toBe(true); // canonical installed
  });

  it("removes exactly the closed list of confirmed legacy artifacts", async () => {
    const legacyLogger = await seedFile("logger.mjs", "// legacy midbrain artifact\n");
    const legacyApi = await seedFile("midbrain-api.mjs", "// legacy midbrain artifact\n");
    for (const file of LEGACY_CLIENTS_FILES) {
      await seedFile(path.join("clients", file), "// legacy midbrain artifact\n");
    }

    await opencode.repairPlugins();

    expect(await exists(legacyLogger)).toBe(false);
    expect(await exists(legacyApi)).toBe(false);
    expect(await exists(path.join(pd, "clients"))).toBe(false); // emptied -> removed
  });

  it("keeps the legacy clients dir when user files remain inside it", async () => {
    for (const file of LEGACY_CLIENTS_FILES) {
      await seedFile(path.join("clients", file), "// legacy midbrain artifact\n");
    }
    const userInClients = await seedFile("clients/user-owned.txt");

    await opencode.repairPlugins();

    for (const file of LEGACY_CLIENTS_FILES) {
      expect(await exists(path.join(pd, "clients", file))).toBe(false);
    }
    expect(await exists(userInClients)).toBe(true);
    expect(await exists(path.join(pd, "clients"))).toBe(true);
  });

  it("installGlobal applies the same closed-list cleanup", async () => {
    const userPrefixed = await seedFile("midbrain-notes.md");
    const legacyLogger = await seedFile("logger.mjs", "// legacy midbrain artifact\n");

    await opencode.installGlobal();

    expect(await exists(userPrefixed)).toBe(true);
    expect(await exists(legacyLogger)).toBe(false);
  });
});

describe("opencode — dev preservation (AC-14)", () => {
  const pluginFile = () => path.join(pd, "midbrain-memory.ts");
  const bundleFile = () => path.join(pd, "midbrain-shared.mjs");
  const markerFile = () => path.join(pd, ".midbrain-repo-root");

  it("B18: dev install writes a dev-flagged marker; canonical repair leaves dev bytes byte-identical", async () => {
    await opencode.installGlobal({ isDev: true });
    // simulate developer-modified checkout bytes in the installed copies
    await fs.writeFile(pluginFile(), "// dev-modified plugin\n", "utf8");
    await fs.writeFile(bundleFile(), "// dev-modified bundle\n", "utf8");

    const marker = (await fs.readFile(markerFile(), "utf8")).trim();
    expect(marker.endsWith("-dev")).toBe(true);

    // a canonical instance never judges a dev install stale, and even a
    // direct repair call preserves the dev bytes
    expect(await opencode.isFresh()).toBe(true);
    const lines = await opencode.repairPlugins();
    expect(lines).toEqual([]);
    expect(await fs.readFile(pluginFile(), "utf8")).toBe("// dev-modified plugin\n");
    expect(await fs.readFile(bundleFile(), "utf8")).toBe("// dev-modified bundle\n");
    expect((await fs.readFile(markerFile(), "utf8")).trim()).toBe(marker);
  });

  it("B18: a dev-marked install from an older version stays pinned", async () => {
    await opencode.installGlobal({ isDev: true });
    await fs.writeFile(markerFile(), "midbrain-memory-mcp@0.0.1-dev\n", "utf8");
    await fs.writeFile(pluginFile(), "// old dev plugin\n", "utf8");

    expect(await opencode.isFresh()).toBe(true);
    await opencode.repairPlugins();
    expect(await fs.readFile(pluginFile(), "utf8")).toBe("// old dev plugin\n");
  });

  it("B18: a dev instance (MIDBRAIN_DEV env) never auto-propagates over a canonical install", async () => {
    await opencode.installGlobal(); // canonical install
    await fs.writeFile(bundleFile(), "// drifted installed state\n", "utf8");
    process.env.MIDBRAIN_DEV = "1"; // the running server was launched by a dev MCP entry

    expect(await opencode.isFresh()).toBe(true); // dev instance: nothing to converge
    const lines = await opencode.repairPlugins();
    expect(lines).toEqual([]);
    expect(await fs.readFile(bundleFile(), "utf8")).toBe("// drifted installed state\n");
  });

  it("B19: explicit non-dev install restores canonical bytes and removes the dev marker flag", async () => {
    await opencode.installGlobal({ isDev: true });
    await fs.writeFile(pluginFile(), "// dev-modified plugin\n", "utf8");
    await fs.writeFile(bundleFile(), "// dev-modified bundle\n", "utf8");

    await opencode.installGlobal(); // explicit canonical install

    const { REPO_ROOT } = await import("../shared/clients/utils.mjs");
    const canonicalPlugin = await fs.readFile(
      path.join(REPO_ROOT, "plugins", "opencode", "midbrain-memory.ts"), "utf8");
    expect(await fs.readFile(pluginFile(), "utf8")).toBe(canonicalPlugin);
    const marker = (await fs.readFile(markerFile(), "utf8")).trim();
    expect(marker.endsWith("-dev")).toBe(false);
  });
});
