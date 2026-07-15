/**
 * Real-filesystem coverage for the npx cache deletion boundary.
 * Fixtures are created only beneath the test process's isolated TMPDIR.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { clearStaleSelfNpxCache } from "../install.mjs";

const fixtureRoots = [];

async function makeFixture(metadata, { npx = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "midbrain-pr32-real-fs-"));
  fixtureRoots.push(root);
  const cacheRoot = path.join(root, npx ? "_npx" : "cache");
  const hashDir = path.join(cacheRoot, "abc123");
  const packageDir = path.join(hashDir, "node_modules", "midbrain-memory-mcp");
  const sibling = path.join(cacheRoot, "sibling", "sentinel.txt");
  await fs.mkdir(packageDir, { recursive: true });
  await fs.mkdir(path.dirname(sibling), { recursive: true });
  await fs.writeFile(sibling, "keep", "utf8");
  if (metadata !== undefined) {
    await fs.writeFile(path.join(packageDir, "package.json"), metadata, "utf8");
  }
  return { hashDir, packageDir, sibling };
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => (
    fs.rm(root, { recursive: true, force: true })
  )));
});

describe("clearStaleSelfNpxCache real filesystem", () => {
  it("removes only a target whose package metadata matches", async () => {
    const fixture = await makeFixture(JSON.stringify({ name: "midbrain-memory-mcp" }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const removed = await clearStaleSelfNpxCache(fixture.packageDir, "9.9.9");

    errSpy.mockRestore();
    expect(removed).toBe(true);
    await expect(fs.access(fixture.hashDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(fixture.sibling, "utf8")).resolves.toBe("keep");
  });

  it("fails closed for missing, malformed, mismatched, and non-_npx metadata paths", async () => {
    const fixtures = [
      await makeFixture(undefined),
      await makeFixture("not-json"),
      await makeFixture(JSON.stringify({ name: "another-package" })),
      await makeFixture(JSON.stringify({ name: "midbrain-memory-mcp" }), { npx: false }),
    ];

    for (const fixture of fixtures) {
      await expect(clearStaleSelfNpxCache(fixture.packageDir, "9.9.9")).resolves.toBe(false);
      await expect(fs.access(fixture.hashDir)).resolves.toBeUndefined();
      await expect(fs.readFile(fixture.sibling, "utf8")).resolves.toBe("keep");
    }
  });
});
