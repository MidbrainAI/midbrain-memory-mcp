/**
 * Unit tests for shared/keystore.mjs
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  KEYSTORE_VERSION,
  emptyKeystore,
  readKeystore,
  writeKeystore,
  globalKeystorePath,
  getUserKey,
  setUserKey,
  getAgent,
  listAgents,
  upsertAgent,
  resolveAgentRef,
} from "../shared/keystore.mjs";
import { makeTestEnv } from "./helpers/test-env.mjs";

// Guarded writes (writeKeystore) only land at the global keystore path inside a
// declared MIDBRAIN_TEST_SANDBOX; reads accept any path.
describe("keystore guarded writes", () => {
  let env;

  beforeEach(async () => {
    env = await makeTestEnv();
  });

  afterEach(async () => {
    await env.restore();
  });

  it("writeKeystore then readKeystore round-trips (global path)", async () => {
    const ks = upsertAgent(emptyKeystore(), {
      agent_id: "agent_a", key_provider: "midbrain", agent_key: "sk-a", alias: "Alpha",
    });
    await writeKeystore(globalKeystorePath(), ks);
    const read = await readKeystore(globalKeystorePath());
    expect(read.version).toBe(KEYSTORE_VERSION);
    expect(read.agents.agent_a.agent_key).toBe("sk-a");
  });

  it("writeKeystore sets 0600 permissions (POSIX only)", async () => {
    if (process.platform === "win32") return;
    await writeKeystore(globalKeystorePath(), emptyKeystore());
    const mode = fs.statSync(globalKeystorePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("creates the ~/.config/midbrain directory on first write", async () => {
    await writeKeystore(globalKeystorePath(), emptyKeystore());
    expect(fs.existsSync(globalKeystorePath())).toBe(true);
  });

  it("refuses a target that is not the global keystore path", async () => {
    const bogus = path.join(env.home, "elsewhere", ".midbrain-keystore.json");
    await expect(writeKeystore(bogus, emptyKeystore())).rejects.toThrow(/does not match the global keystore/);
  });

  it("refuses a symlinked keystore target", async () => {
    if (process.platform === "win32") return; // symlink privilege varies
    const target = globalKeystorePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const decoy = path.join(env.home, "decoy.json");
    fs.writeFileSync(decoy, "{}");
    fs.symlinkSync(decoy, target);
    await expect(writeKeystore(target, emptyKeystore())).rejects.toThrow(/symlink/);
  });
});

describe("keystore file reads", () => {
  let tmpDir;
  let ksPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-keystore-"));
    ksPath = path.join(tmpDir, ".midbrain-keystore.json");
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("readKeystore returns null for a missing file", async () => {
    await expect(readKeystore(ksPath)).resolves.toBeNull();
  });

  it("fails closed on unparseable JSON (throws, never resets)", async () => {
    fs.writeFileSync(ksPath, "{ this is not json ");
    await expect(readKeystore(ksPath)).rejects.toThrow(/Failed to parse keystore/);
  });

  it("rejects a non-object JSON root", async () => {
    fs.writeFileSync(ksPath, "[1,2,3]");
    await expect(readKeystore(ksPath)).rejects.toThrow(/expected a JSON object/);
  });

  it("normalizes a legacy object missing version/agents on read", async () => {
    fs.writeFileSync(ksPath, JSON.stringify({ user_key: "sk-user" }));
    const read = await readKeystore(ksPath);
    expect(read.version).toBe(KEYSTORE_VERSION);
    expect(read.agents).toEqual({});
    expect(getUserKey(read)).toBe("sk-user");
  });
});

describe("keystore accessors/mutators", () => {
  it("getUserKey / setUserKey", () => {
    expect(getUserKey(emptyKeystore())).toBeNull();
    const ks = setUserKey(emptyKeystore(), "sk-user");
    expect(getUserKey(ks)).toBe("sk-user");
  });

  it("getUserKey returns null for empty string", () => {
    expect(getUserKey({ version: 1, agents: {}, user_key: "" })).toBeNull();
  });

  it("upsertAgent inserts then merges fields", () => {
    let ks = upsertAgent(emptyKeystore(), {
      agent_id: "a1", key_provider: "midbrain", agent_key: "sk-1", alias: "One",
    });
    expect(getAgent(ks, "a1").agent_key).toBe("sk-1");
    ks = upsertAgent(ks, { agent_id: "a1", alias: "Renamed" });
    expect(getAgent(ks, "a1").alias).toBe("Renamed");
    expect(getAgent(ks, "a1").agent_key).toBe("sk-1"); // preserved
  });

  it("upsertAgent requires an agent_id", () => {
    expect(() => upsertAgent(emptyKeystore(), { alias: "x" })).toThrow(/agent_id/);
  });

  it("listAgents returns all records with agent_id", () => {
    let ks = upsertAgent(emptyKeystore(), { agent_id: "a1", alias: "One" });
    ks = upsertAgent(ks, { agent_id: "a2", alias: "Two" });
    const list = listAgents(ks);
    expect(list.map((a) => a.agent_id).sort()).toEqual(["a1", "a2"]);
  });

  it("getAgent returns a specific record or null", () => {
    const ks = upsertAgent(emptyKeystore(), { agent_id: "a1", agent_key: "sk-1" });
    expect(getAgent(ks, "a1").agent_key).toBe("sk-1");
    expect(getAgent(ks, "missing")).toBeNull();
  });
});

describe("resolveAgentRef (agent resolution filter)", () => {
  const agents = [
    { agent_id: "agent_111", alias: "Work Agent" },
    { agent_id: "agent_222", alias: "Personal Agent" },
    { agent_id: "agent_333", name: "Secret Project" },
  ];

  it("resolves an exact agent_id", () => {
    const r = resolveAgentRef(agents, "agent_222");
    expect(r.status).toBe("ok");
    expect(r.agent.agent_id).toBe("agent_222");
  });

  it("resolves an exact name/alias case-insensitively", () => {
    const r = resolveAgentRef(agents, "work agent");
    expect(r.status).toBe("ok");
    expect(r.agent.agent_id).toBe("agent_111");
  });

  it("resolves a unique substring", () => {
    const r = resolveAgentRef(agents, "secret");
    expect(r.status).toBe("ok");
    expect(r.agent.agent_id).toBe("agent_333");
  });

  it("returns ambiguous when a substring matches multiple", () => {
    const r = resolveAgentRef(agents, "agent");
    expect(r.status).toBe("ambiguous");
    expect(r.candidates.length).toBe(2);
  });

  it("returns none when nothing matches", () => {
    expect(resolveAgentRef(agents, "nonexistent").status).toBe("none");
  });

  it("returns none for empty/blank input", () => {
    expect(resolveAgentRef(agents, "").status).toBe("none");
    expect(resolveAgentRef(agents, "   ").status).toBe("none");
  });

  it("exact name match wins over substring ambiguity", () => {
    const list = [
      { agent_id: "a1", alias: "Prod" },
      { agent_id: "a2", alias: "Production" },
    ];
    const r = resolveAgentRef(list, "Prod");
    expect(r.status).toBe("ok");
    expect(r.agent.agent_id).toBe("a1");
  });

  it("handles an empty agent list", () => {
    expect(resolveAgentRef([], "anything").status).toBe("none");
  });
});
