/**
 * AC-12 (PRD-034 rev 3, B16): exact hook ownership.
 *
 * Repair may claim only positively owned MidBrain hooks: the exact stable-shim
 * command (token equality — near-names like `claude-hook-wrapper` are user
 * hooks), positively identified legacy commands (`plugins/<dir>/capture-*.mjs`
 * or the package name), and npx invocation forms. A user's own script that
 * merely shares a filename with our legacy scripts must survive repair in all
 * three shim clients, preserving ordering.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import YAML from "yaml";

import { makeTestEnv } from "./helpers/test-env.mjs";
import { Claude } from "../shared/clients/claude.mjs";
import { Codex } from "../shared/clients/codex.mjs";
import { Hermes } from "../shared/clients/hermes.mjs";
import { stableShimPath } from "../shared/clients/shim.mjs";

const shimCommand = (client, role) => `'${stableShimPath(client)}' ${role}`;
const wrapperCommand = (env, client, role) =>
  `'${path.join(env.home, ".midbrain", "bin", `${client}-hook-wrapper`)}' ${role}`;

// ---------------------------------------------------------------------------
// Claude + Codex share the { hooks: { Event: [ { hooks: [...] } ] } } shape
// ---------------------------------------------------------------------------

const JSON_CLIENTS = [
  {
    id: "claude",
    make: () => new Claude(),
    settingsFile: (paths) => paths.claudeSettings,
    userEvent: "UserPromptSubmit",
    legacyDir: "plugins/claude-code",
  },
  {
    id: "codex",
    make: () => new Codex(),
    settingsFile: (paths) => paths.codexHooks,
    userEvent: "UserPromptSubmit",
    legacyDir: "plugins/codex",
  },
];

describe.each(JSON_CLIENTS)("$id — exact hook ownership (AC-12)", ({ id, make, settingsFile, userEvent, legacyDir }) => {
  let env;
  let client;
  let file;

  beforeEach(async () => {
    env = await makeTestEnv({ clients: [id] });
    client = make();
    await client.installGlobal();
    file = settingsFile(env.paths);
  });

  afterEach(async () => {
    await env.restore();
  });

  async function readData() {
    return JSON.parse(await fs.readFile(file, "utf8"));
  }
  async function writeData(data) {
    await fs.writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  }
  function eventCommands(data, event) {
    return (data.hooks[event] || []).flatMap((g) => (g.hooks || []).map((h) => h.command));
  }

  it("B16: a near-name wrapper hook is user-owned — survives repair, first in order, not double-counted", async () => {
    const wrapper = wrapperCommand(env, id, "user");
    const data = await readData();
    data.hooks[userEvent].unshift({ hooks: [{ type: "command", command: wrapper }] });
    await writeData(data);

    // the wrapper is not ours: config stays fresh (exactly one midbrain hook)
    expect(await client.isFresh()).toBe(true);

    await client.repairHooks();

    const after = await readData();
    const commands = eventCommands(after, userEvent);
    expect(commands).toContain(wrapper);
    expect(after.hooks[userEvent][0].hooks[0].command).toBe(wrapper); // ordering kept
    expect(commands.filter((c) => c === shimCommand(id, "user"))).toHaveLength(1);
  });

  it("B16: a user's own capture-user.mjs outside midbrain paths is never claimed", async () => {
    const own = `node ${path.join(env.home, "scripts", "capture-user.mjs")}`;
    const data = await readData();
    data.hooks[userEvent].unshift({ hooks: [{ type: "command", command: own }] });
    await writeData(data);

    expect(await client.isFresh()).toBe(true); // not legacy, not ours

    await client.repairHooks();

    const after = await readData();
    expect(eventCommands(after, userEvent)).toContain(own);
  });

  it("B16: a user's hook under a myplugins/<dir> path is never claimed (no substring prefixes)", async () => {
    const own = `node /home/alice/my${legacyDir}/capture-user.mjs`;
    const data = await readData();
    data.hooks[userEvent].unshift({ hooks: [{ type: "command", command: own }] });
    await writeData(data);

    expect(await client.isFresh()).toBe(true); // not ours: config stays fresh

    await client.repairHooks();

    const after = await readData();
    const commands = eventCommands(after, userEvent);
    expect(commands).toContain(own);
    expect(after.hooks[userEvent][0].hooks[0].command).toBe(own); // ordering kept
    expect(commands.filter((c) => c === shimCommand(id, "user"))).toHaveLength(1);
  });

  it("B16: a near-name package binary (midbrain-memory-mcp-wrapper) is never claimed", async () => {
    const own = `/usr/local/bin/midbrain-memory-mcp-wrapper hook ${id} user`;
    const data = await readData();
    data.hooks[userEvent].unshift({ hooks: [{ type: "command", command: own }] });
    await writeData(data);

    expect(await client.isFresh()).toBe(true);

    await client.repairHooks();

    const after = await readData();
    const commands = eventCommands(after, userEvent);
    expect(commands).toContain(own);
    expect(after.hooks[userEvent][0].hooks[0].command).toBe(own); // ordering kept
    expect(commands.filter((c) => c === shimCommand(id, "user"))).toHaveLength(1);
  });

  it("a genuine package-checkout index.js form is still claimed (exact path segment)", async () => {
    const data = await readData();
    data.hooks[userEvent].unshift({
      hooks: [{ type: "command", command: `node /work/midbrain-memory-mcp/index.js hook ${id} user` }],
    });
    await writeData(data);

    await client.repairHooks();

    const after = await readData();
    const commands = eventCommands(after, userEvent);
    expect(commands.join("\n")).not.toContain("index.js");
    expect(commands.filter((c) => c === shimCommand(id, "user"))).toHaveLength(1);
  });

  it("real legacy forms (checkout + npx cache) are still claimed and migrated", async () => {
    const data = await readData();
    data.hooks[userEvent] = [
      { hooks: [{ type: "command", command: `node /old-checkout/${legacyDir}/capture-user.mjs`, timeout: 10 }] },
      { hooks: [{ type: "command", command: `node /Users/u/.npm/_npx/0fd4a1b2/node_modules/midbrain-memory-mcp/${legacyDir}/capture-user.mjs`, timeout: 10 }] },
    ];
    await writeData(data);

    expect(await client.isFresh()).toBe(false);

    await client.repairHooks();

    const after = await readData();
    const commands = eventCommands(after, userEvent);
    expect(commands.join("\n")).not.toContain("capture-user.mjs");
    expect(commands.filter((c) => c === shimCommand(id, "user"))).toHaveLength(1);
  });

  it("npx invocation form is recognized as midbrain and deduped to the shim command", async () => {
    const data = await readData();
    data.hooks[userEvent].unshift({
      hooks: [{ type: "command", command: `npx -y midbrain-memory-mcp@latest hook ${id} user` }],
    });
    await writeData(data);

    await client.repairHooks();

    const after = await readData();
    const commands = eventCommands(after, userEvent);
    expect(commands.join("\n")).not.toContain("npx -y midbrain-memory-mcp@latest hook");
    expect(commands.filter((c) => c === shimCommand(id, "user"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Hermes uses hooks.<event>: [ { command, timeout } ] in YAML
// ---------------------------------------------------------------------------

describe("hermes — exact hook ownership (AC-12)", () => {
  let env;
  let hermes;
  let file;

  beforeEach(async () => {
    env = await makeTestEnv({ clients: ["hermes"] });
    hermes = new Hermes();
    await hermes.installGlobal();
    file = env.paths.hermesConfig;
  });

  afterEach(async () => {
    await env.restore();
  });

  async function readConfig() {
    return YAML.parse(await fs.readFile(file, "utf8"));
  }
  async function writeConfig(cfg) {
    await fs.writeFile(file, YAML.stringify(cfg), "utf8");
  }

  it("B16: a near-name wrapper hook is user-owned — survives repair, first in order", async () => {
    const wrapper = wrapperCommand(env, "hermes", "user");
    const cfg = await readConfig();
    cfg.hooks.pre_llm_call.unshift({ command: wrapper, timeout: 5 });
    await writeConfig(cfg);

    expect(await hermes.isFresh()).toBe(true);

    await hermes.repairHooks();

    const after = await readConfig();
    const commands = after.hooks.pre_llm_call.map((h) => h.command);
    expect(commands[0]).toBe(wrapper);
    expect(commands.filter((c) => c === shimCommand("hermes", "user"))).toHaveLength(1);
  });

  it("B16: a user's own capture-user.mjs outside midbrain paths is never claimed", async () => {
    const own = `node ${path.join(env.home, "scripts", "capture-user.mjs")}`;
    const cfg = await readConfig();
    cfg.hooks.pre_llm_call.unshift({ command: own, timeout: 5 });
    await writeConfig(cfg);

    expect(await hermes.isFresh()).toBe(true);

    await hermes.repairHooks();

    const after = await readConfig();
    expect(after.hooks.pre_llm_call.map((h) => h.command)).toContain(own);
  });

  it("B16: a user's hook under a myplugins/hermes path is never claimed (no substring prefixes)", async () => {
    const own = "node /home/alice/myplugins/hermes/capture-user.mjs";
    const cfg = await readConfig();
    cfg.hooks.pre_llm_call.unshift({ command: own, timeout: 5 });
    await writeConfig(cfg);

    expect(await hermes.isFresh()).toBe(true);

    await hermes.repairHooks();

    const after = await readConfig();
    const commands = after.hooks.pre_llm_call.map((h) => h.command);
    expect(commands[0]).toBe(own); // survives, ordering kept
    expect(commands.filter((c) => c === shimCommand("hermes", "user"))).toHaveLength(1);
  });

  it("B16: a near-name package binary (midbrain-memory-mcp-wrapper) is never claimed", async () => {
    const own = "/usr/local/bin/midbrain-memory-mcp-wrapper hook hermes user";
    const cfg = await readConfig();
    cfg.hooks.pre_llm_call.unshift({ command: own, timeout: 5 });
    await writeConfig(cfg);

    expect(await hermes.isFresh()).toBe(true);

    await hermes.repairHooks();

    const after = await readConfig();
    const commands = after.hooks.pre_llm_call.map((h) => h.command);
    expect(commands[0]).toBe(own);
    expect(commands.filter((c) => c === shimCommand("hermes", "user"))).toHaveLength(1);
  });

  it("real legacy forms are still claimed and migrated", async () => {
    const cfg = await readConfig();
    cfg.hooks.pre_llm_call = [{ command: "node /old/plugins/hermes/capture-user.mjs" }];
    await writeConfig(cfg);

    expect(await hermes.isFresh()).toBe(false);

    await hermes.repairHooks();

    const after = await readConfig();
    const commands = after.hooks.pre_llm_call.map((h) => h.command);
    expect(commands.join("\n")).not.toContain("capture-user.mjs");
    expect(commands.filter((c) => c === shimCommand("hermes", "user"))).toHaveLength(1);
  });
});
