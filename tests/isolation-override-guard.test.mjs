import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "check-test-isolation.sh");
const IS_WIN = process.platform === "win32";

function runIsolationCheck({ home, override }) {
  return spawnSync("bash", [SCRIPT_PATH], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      MIDBRAIN_ISOLATION_HOME: override,
    },
    timeout: 30000,
  });
}

describe.skipIf(IS_WIN)("isolation override guard", () => {
  it("refuses an override whose sentinel path escapes through a symlink", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-isolation-guard-"));
    try {
      const home = path.join(fixtureRoot, "home");
      const override = path.join(fixtureRoot, "override");
      const externalConfig = path.join(fixtureRoot, "external-config");
      const externalKey = path.join(externalConfig, "midbrain", ".midbrain-key");
      fs.mkdirSync(home);
      fs.mkdirSync(override);
      fs.mkdirSync(path.dirname(externalKey), { recursive: true });
      fs.writeFileSync(externalKey, "dummy-external-key\n", "utf8");
      fs.symlinkSync(externalConfig, path.join(override, ".config"), "dir");

      const result = runIsolationCheck({ home, override });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ERROR:");
      expect(fs.readFileSync(externalKey, "utf8")).toBe("dummy-external-key\n");
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 30000);

  it("refuses an override contained within the real home", () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-isolation-guard-"));
    try {
      const home = path.join(fixtureRoot, "home");
      const override = path.join(home, "override");
      const sentinel = path.join(override, ".config", "midbrain", ".midbrain-key");
      fs.mkdirSync(override, { recursive: true });

      const result = runIsolationCheck({ home, override });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("ERROR:");
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 30000);
});
