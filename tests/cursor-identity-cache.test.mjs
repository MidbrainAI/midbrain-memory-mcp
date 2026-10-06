import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { makeTestEnv } from "./helpers/test-env.mjs";
import { loadServerInstructions } from "../mcp.mjs";
import { formatIdentityContext } from "../shared/identity-context.mjs";

let env;
beforeEach(async () => { env = await makeTestEnv(); });
afterEach(async () => { vi.restoreAllMocks(); await env.restore(); });
async function cache(project, text, metadata = { serverName: "midbrain-memory", serverIdentifier: "user-midbrain-memory" }) {
  const dir = path.join(env.home, ".cursor/projects", project, "mcps/user-midbrain-memory");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SERVER_METADATA.json"), JSON.stringify(metadata));
  const file = path.join(dir, "INSTRUCTIONS.md");
  if (text !== undefined) await fs.writeFile(file, text);
  return file;
}
const load = (persona = null) => loadServerInstructions({
  clientId: "cursor", log: () => {},
  createApiFn: async () => ({ getPersona: async () => persona, getProfile: async () => null }),
});

describe("Cursor identity cache retirement", () => {
  it("does not populate other projects' instruction caches", async () => {
    const files = await Promise.all([cache("a"), cache("b")]);
    expect(await load("Only for this connection")).toContain("Only for this connection");
    for (const file of files) await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retires and backs up legacy identity even when the API fields are blank", async () => {
    const old = formatIdentityContext({ persona: "Old private identity" });
    const file = await cache("a", old);
    expect(await load()).toBe("No persona or profile is supplied for this server connection.");
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    const backups = path.join(env.home, ".config/midbrain/cursor-identity-backups");
    const names = await fs.readdir(backups);
    expect(names).toHaveLength(1);
    expect(await fs.readFile(path.join(backups, names[0]), "utf8")).toBe(old);
  });

  it("preserves mixed instructions, unknown servers and symlinks", async () => {
    const old = formatIdentityContext({ profile: "Old profile" });
    const mixed = await cache("mixed", `User instructions\n${old}`);
    const unknown = await cache("unknown", old, { serverName: "other" });
    const target = path.join(env.root, "owned-by-user.md");
    await fs.writeFile(target, old);
    const link = await cache("link");
    await fs.symlink(target, link);
    await load();
    expect(await fs.readFile(mixed, "utf8")).toBe(`User instructions\n${old}`);
    expect(await fs.readFile(unknown, "utf8")).toBe(old);
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe(old);
  });

  it("retires old files even when no credential resolves", async () => {
    const file = await cache("old", formatIdentityContext({ persona: "Old identity" }));
    expect(await loadServerInstructions({ clientId: "cursor", log: () => {},
      createApiFn: async () => { throw new Error("No key"); },
    })).toBe("No persona or profile is supplied for this server connection.");
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a project replaced by a symlink after enumeration", async () => {
    const old = formatIdentityContext({ persona: "Outside identity" });
    const file = await cache("race", old);
    const project = path.join(env.home, ".cursor/projects/race");
    const outside = path.join(env.root, "outside");
    const readdir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      const result = await readdir(...args);
      if (args[0] === path.dirname(project)) {
        await fs.rename(project, outside);
        await fs.symlink(outside, project);
      }
      return result;
    });
    await load();
    expect(await fs.readFile(file, "utf8")).toBe(old);
  });

  it.each(["tmp", "worktree", "ci"])("does not retire caches in %s launches", async (kind) => {
    const { retireLegacyCursorInstructionCaches } = await import("../shared/cursor-identity-cache.mjs");
    const old = formatIdentityContext({ persona: "Preserved identity" });
    const file = await cache("skip", old);
    expect(await retireLegacyCursorInstructionCaches({ context: { kind } })).toBe(0);
    expect(await fs.readFile(file, "utf8")).toBe(old);
  });

  it("preserves signed instructions that Cursor itself may have cached", async () => {
    const { MidbrainApi } = await import("../shared/midbrain-api.mjs");
    const block = formatIdentityContext({ persona: "Native cached identity" }, new MidbrainApi("fixture", "fixture"));
    const file = await cache("signed", block);
    await load();
    expect(await fs.readFile(file, "utf8")).toBe(block);
  });
});
