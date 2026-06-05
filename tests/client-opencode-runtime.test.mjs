/**
 * Runtime smoke for the copied OpenCode plugin client bundle.
 */

import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const CLIENT_FILES = [
  "base.mjs",
  "generic.mjs",
  "opencode.mjs",
  "claude.mjs",
  "codex.mjs",
  "registry.mjs",
];

describe("OpenCode copied client runtime", () => {
  it("keeps codex.mjs free of top-level package imports", async () => {
    const source = await fs.readFile(path.join(REPO_ROOT, "shared", "clients", "codex.mjs"), "utf8");

    expect(source).not.toMatch(/from ['"]smol-toml['"]/);
  });

  it("imports the copied registry without package dependencies", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-runtime-"));
    const clientsDir = path.join(root, "clients");
    await fs.mkdir(clientsDir, { recursive: true });

    try {
      for (const file of CLIENT_FILES) {
        await fs.copyFile(
          path.join(REPO_ROOT, "shared", "clients", file),
          path.join(clientsDir, file),
        );
      }

      const registry = await import(pathToFileURL(path.join(clientsDir, "registry.mjs")));
      expect(registry.getClient("opencode").id).toBe("opencode");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
