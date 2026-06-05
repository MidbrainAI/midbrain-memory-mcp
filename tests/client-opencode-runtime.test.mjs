/**
 * Runtime smoke for the OpenCode plugin bundle.
 *
 * Verifies that:
 * 1. The bundle (dist/midbrain-shared.mjs) exports the expected symbols
 * 2. The plugin source imports from ./midbrain-shared.mjs (no individual shared imports)
 * 3. The dev shim re-exports correctly from the source tree
 * 4. codex.mjs remains free of top-level package imports (lazy-load only)
 */

import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const BUNDLE_PATH = path.join(REPO_ROOT, "dist", "midbrain-shared.mjs");
const SHIM_PATH = path.join(REPO_ROOT, "plugins", "opencode", "midbrain-shared.mjs");

describe("OpenCode plugin bundle", () => {
  it("keeps codex.mjs free of top-level package imports", async () => {
    const source = await fs.readFile(path.join(REPO_ROOT, "shared", "clients", "codex.mjs"), "utf8");
    expect(source).not.toMatch(/from ['"]smol-toml['"]/);
  });

  it("dist/midbrain-shared.mjs exists (run npm run build:plugin if missing)", () => {
    expect(existsSync(BUNDLE_PATH)).toBe(true);
  });

  it("bundle exports MidbrainApi, makeDebugLogger, getClient", async () => {
    const bundle = await import(pathToFileURL(BUNDLE_PATH).href);
    expect(typeof bundle.MidbrainApi).toBe("function");
    expect(typeof bundle.makeDebugLogger).toBe("function");
    expect(typeof bundle.getClient).toBe("function");
  });

  it("getClient resolves opencode adapter from the bundle", async () => {
    const bundle = await import(pathToFileURL(BUNDLE_PATH).href);
    const client = bundle.getClient("opencode");
    expect(client.id).toBe("opencode");
  });

  it("dev shim re-exports the same symbols as the bundle", async () => {
    const shim = await import(pathToFileURL(SHIM_PATH).href);
    expect(typeof shim.MidbrainApi).toBe("function");
    expect(typeof shim.makeDebugLogger).toBe("function");
    expect(typeof shim.getClient).toBe("function");
  });

  it("plugin source imports only from ./midbrain-shared.mjs", async () => {
    const pluginSrc = await fs.readFile(
      path.join(REPO_ROOT, "plugins", "opencode", "midbrain-memory.ts"), "utf8",
    );
    // Should NOT have individual shared imports
    expect(pluginSrc).not.toContain("./midbrain-api.mjs");
    expect(pluginSrc).not.toContain("./logger.mjs");
    expect(pluginSrc).not.toContain("./clients/registry.mjs");
    // Should import from the unified shared module
    expect(pluginSrc).toContain('from "./midbrain-shared.mjs"');
  });
});
