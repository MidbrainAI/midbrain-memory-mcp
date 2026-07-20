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
