import { afterEach, describe, expect, it, vi } from "vitest";
import { validateRegistry, validatePackage, validateTarball, verifyConditions } from "../scripts/release-guard.mjs";

afterEach(() => vi.unstubAllGlobals());

describe("release preflight", () => {
  it("detects an unfinished publication even when there are no new commits", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      "dist-tags": { latest: "0.4.10" }, versions: { "0.4.10": {} },
    }) }));
    await expect(verifyConditions({}, { branch: { tags: [
      { version: "0.4.10" }, { version: "0.5.0" },
    ] } })).rejects.toThrow(/disagree/);
  });
  it("selects the highest stable version numerically", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      "dist-tags": { latest: "0.4.10" }, versions: { "0.4.10": {} },
    }) }));
    await expect(verifyConditions({}, { branch: { tags: [
      { version: "0.4.9" }, { version: "0.4.10" },
    ] } })).resolves.toBeUndefined();
  });
  it("fails closed on a registry outage", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(verifyConditions({}, { branch: { tags: [{ version: "0.4.10" }] } }))
      .rejects.toThrow(/503/);
  });
});

describe("release tarball", () => {
  const pack = { name: "midbrain-memory-mcp", version: "0.5.0", files: [
    "index.js", "install.mjs", "mcp.mjs", "dist/midbrain-shared.mjs",
  ].map(path => ({ path })) };
  it("requires the entry points and rebuilt bundle", () => {
    expect(() => validateTarball(pack, "0.5.0")).not.toThrow();
    expect(() => validateTarball({ "midbrain-memory-mcp": pack }, "0.5.0")).not.toThrow();
    expect(() => validateTarball({ ...pack, files: pack.files.slice(0, -1) }, "0.5.0")).toThrow();
    expect(() => validateTarball(pack, "0.4.10")).toThrow();
  });
  it("rejects accidentally packaged credentials", () => {
    expect(() => validateTarball({ ...pack, files: [...pack.files,
      { path: "plugins/.midbrain/.midbrain-key" },
    ] }, "0.5.0")).toThrow();
  });
});

describe("release registry guard", () => {
  const registry = { "dist-tags": { latest: "0.4.10" }, versions: { "0.4.10": {} } };
  it("allows a new version after the published baseline", () => {
    expect(() => validateRegistry(registry, "0.4.10", "0.5.0")).not.toThrow();
  });
  it("rejects already published versions and registry/tag drift", () => {
    expect(() => validateRegistry(registry, "0.4.9", "0.5.0")).toThrow();
    expect(() => validateRegistry(registry, "0.4.10", "0.4.10")).toThrow();
    expect(() => validateRegistry(registry, "0.4.10", "0.4.9")).toThrow();
    expect(() => validateRegistry({}, "0.4.10", "0.5.0")).toThrow();
  });
});

describe("release package guard", () => {
  const pkg = { name: "midbrain-memory-mcp", version: "0.5.0" };
  const lock = { version: "0.5.0", packages: { "": pkg } };
  it("requires the prepared source and both lockfile versions to match", () => {
    expect(() => validatePackage(pkg, lock, "0.5.0")).not.toThrow();
    expect(() => validatePackage(pkg, lock, "0.4.10")).toThrow();
    expect(() => validatePackage(pkg, { ...lock, version: "0.4.10" }, "0.5.0")).toThrow();
    expect(() => validatePackage(pkg, { ...lock, packages: { "": { ...pkg, version: "0.4.10" } } }, "0.5.0")).toThrow();
  });
});
