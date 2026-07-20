/**
 * Unit tests for shared/clients/shim.mjs (PRD-034 S2/S3) and
 * utils.writeFileIfChanged.
 *
 * Byte-parity blocks pin the canonical codex/hermes shim bodies to the exact
 * strings shipped at e0abf99: if these change, every existing user's shim
 * gets rewritten on the next repair (mtime churn, possible re-approval).
 */

import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";

import { makeTestEnv } from "./helpers/test-env.mjs";
import {
  shellQuote,
  windowsPathGuard,
  stableShimPath,
  buildShimBody,
  isDevShimContent,
  installShim,
  shimStatus,
} from "../shared/clients/shim.mjs";
import { writeFileIfChanged } from "../shared/clients/utils.mjs";

const IS_WIN = process.platform === "win32";

// --- Exact bodies shipped at e0abf99 (do not reformat) ---

const CODEX_BODY_E0ABF99 = `#!/bin/sh
set +e
npx -y midbrain-memory-mcp@latest hook codex "$@"
status=$?
case "$1" in
  assistant|tool)
    if [ "$status" -ne 0 ]; then
      printf '{}'
    fi
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;

const HERMES_POSIX_E0ABF99 = `#!/bin/sh
set +e
npx -y midbrain-memory-mcp@latest hook hermes "$@"
exit 0
`;

const HERMES_WIN_E0ABF99 =
  `@echo off\r\ncall npx.cmd -y midbrain-memory-mcp@latest hook hermes "%~1"\r\nexit /b 0\r\n`;

describe("buildShimBody — canonical byte parity with e0abf99", () => {
  it("codex canonical body is byte-identical to the shipped shim", () => {
    expect(buildShimBody("codex", { platform: "darwin" })).toBe(CODEX_BODY_E0ABF99);
    expect(buildShimBody("codex", { platform: "win32" })).toBe(CODEX_BODY_E0ABF99);
  });

  it("hermes canonical bodies are byte-identical to the shipped shims", () => {
    expect(buildShimBody("hermes", { platform: "darwin" })).toBe(HERMES_POSIX_E0ABF99);
    expect(buildShimBody("hermes", { platform: "win32" })).toBe(HERMES_WIN_E0ABF99);
  });

  it("claude canonical bodies mirror the hermes template", () => {
    expect(buildShimBody("claude", { platform: "linux" })).toBe(
      `#!/bin/sh\nset +e\nnpx -y midbrain-memory-mcp@latest hook claude "$@"\nexit 0\n`
    );
    expect(buildShimBody("claude", { platform: "win32" })).toBe(
      `@echo off\r\ncall npx.cmd -y midbrain-memory-mcp@latest hook claude "%~1"\r\nexit /b 0\r\n`
    );
  });
});

describe("buildShimBody — dev variants (S3)", () => {
  it("posix dev bodies carry the dev marker and shellQuoted checkout paths", () => {
    for (const client of ["claude", "hermes"]) {
      const body = buildShimBody(client, {
        isDev: true, platform: "darwin", execPath: "/opt/my node/bin/node", repoRoot: "/Users/d ev/checkout",
      });
      expect(body.split("\n")[1]).toBe("# midbrain-dev");
      expect(body).toContain(`'/opt/my node/bin/node' '/Users/d ev/checkout/index.js' hook ${client} "$@"`);
      expect(isDevShimContent(body)).toBe(true);
    }
  });

  it("codex dev body keeps the {} failure fallback wrapper", () => {
    const body = buildShimBody("codex", {
      isDev: true, platform: "darwin", execPath: "/usr/bin/node", repoRoot: "/checkout",
    });
    expect(body.split("\n")[1]).toBe("# midbrain-dev");
    expect(body).toContain(`'/usr/bin/node' '/checkout/index.js' hook codex "$@"`);
    expect(body).toContain("printf '{}'");
    expect(isDevShimContent(body)).toBe(true);
  });

  it("win32 dev bodies use @rem marker and quoted paths", () => {
    const body = buildShimBody("claude", {
      isDev: true, platform: "win32", execPath: "C:\\node\\node.exe", repoRoot: "C:\\checkout",
    });
    expect(body.split("\r\n")[1]).toBe("@rem midbrain-dev");
    expect(body).toContain(`"C:\\node\\node.exe" "C:\\checkout\\index.js" hook claude "%~1"`);
    expect(isDevShimContent(body)).toBe(true);
  });

  it("canonical bodies are not dev-marked", () => {
    for (const client of ["claude", "codex", "hermes"]) {
      expect(isDevShimContent(buildShimBody(client, { platform: "darwin" }))).toBe(false);
    }
  });
});

describe("shellQuote / windowsPathGuard", () => {
  it("shellQuote wraps and escapes single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("windowsPathGuard rejects cmd metacharacters on win32 only", () => {
    expect(() => windowsPathGuard("C:\\bad&path\\node.exe", "label", "win32")).toThrow(/label/);
    expect(() => windowsPathGuard("C:\\ok\\node.exe", "label", "win32")).not.toThrow();
    expect(() => windowsPathGuard("/has&amp/node", "label", "darwin")).not.toThrow();
  });
});

describe("stableShimPath", () => {
  it("resolves under the (sandboxed) home .midbrain/bin", async () => {
    const env = await makeTestEnv();
    try {
      expect(stableShimPath("claude")).toBe(path.join(env.home, ".midbrain", "bin", "claude-hook"));
      expect(stableShimPath("codex")).toBe(path.join(env.home, ".midbrain", "bin", "codex-hook"));
    } finally {
      await env.restore();
    }
  });
});

describe("installShim (sandboxed)", () => {
  it("writes an executable canonical shim; identical re-install is a no-write", async () => {
    const env = await makeTestEnv();
    try {
      const first = await installShim("claude", { mode: "install" });
      expect(first.written).toBe(true);
      const shimFile = stableShimPath("claude");
      const stat1 = await fs.stat(shimFile);
      expect(stat1.mode & 0o777).toBe(0o755);

      await new Promise((r) => setTimeout(r, 10));
      const second = await installShim("claude", { mode: "install" });
      expect(second.written).toBe(false);
      const stat2 = await fs.stat(shimFile);
      expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
    } finally {
      await env.restore();
    }
  });

  it("restores a stripped exec bit even when content is unchanged (no mtime churn)", async () => {
    const env = await makeTestEnv();
    try {
      await installShim("claude", { mode: "install" });
      const shimFile = stableShimPath("claude");
      await fs.chmod(shimFile, 0o644); // exec bit stripped out-of-band
      await new Promise((r) => setTimeout(r, 10));
      const statBefore = await fs.stat(shimFile);

      const result = await installShim("claude", { mode: "repair" });

      expect(result.written).toBe(false); // content identical
      const statAfter = await fs.stat(shimFile);
      expect(statAfter.mode & 0o777).toBe(0o755); // exec restored
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs); // chmod is mtime-safe
    } finally {
      await env.restore();
    }
  });

  it("repair mode preserves a dev-marked shim byte-for-byte (B4)", async () => {
    const env = await makeTestEnv();
    try {
      await installShim("claude", { mode: "install", isDev: true });
      const shimFile = stableShimPath("claude");
      const devBody = await fs.readFile(shimFile, "utf8");
      expect(isDevShimContent(devBody)).toBe(true);

      const result = await installShim("claude", { mode: "repair" });
      expect(result.written).toBe(false);
      expect(result.preservedDev).toBe(true);
      expect(await fs.readFile(shimFile, "utf8")).toBe(devBody);
    } finally {
      await env.restore();
    }
  });

  it("repair mode rewrites a stale non-dev shim to canonical (B11 path)", async () => {
    const env = await makeTestEnv();
    try {
      const shimFile = stableShimPath("claude");
      await fs.mkdir(path.dirname(shimFile), { recursive: true });
      await fs.writeFile(shimFile, "#!/bin/sh\n/old/stale/path hook claude \"$@\"\n", "utf8");

      const result = await installShim("claude", { mode: "repair" });
      expect(result.written).toBe(true);
      expect(await fs.readFile(shimFile, "utf8")).toBe(buildShimBody("claude"));
    } finally {
      await env.restore();
    }
  });

  it("explicit install (no dev) overwrites a dev shim with canonical (B7)", async () => {
    const env = await makeTestEnv();
    try {
      await installShim("claude", { mode: "install", isDev: true });
      const result = await installShim("claude", { mode: "install" });
      expect(result.written).toBe(true);
      expect(await fs.readFile(stableShimPath("claude"), "utf8")).toBe(buildShimBody("claude"));
    } finally {
      await env.restore();
    }
  });

  it.skipIf(IS_WIN)("repair mode restores exec on a preserved dev shim (B15, mtime-safe)", async () => {
    const env = await makeTestEnv();
    try {
      await installShim("claude", { mode: "install", isDev: true });
      const shimFile = stableShimPath("claude");
      const devBody = await fs.readFile(shimFile, "utf8");
      await fs.chmod(shimFile, 0o644); // exec stripped out-of-band
      await new Promise((r) => setTimeout(r, 10));
      const statBefore = await fs.stat(shimFile);

      const result = await installShim("claude", { mode: "repair" });

      expect(result.preservedDev).toBe(true);
      expect(await fs.readFile(shimFile, "utf8")).toBe(devBody); // bytes untouched
      const statAfter = await fs.stat(shimFile);
      expect(statAfter.mode & 0o777).toBe(0o755); // exec restored
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    } finally {
      await env.restore();
    }
  });
});

describe("shimStatus (AC-11)", () => {
  it("missing shim is stale", async () => {
    const env = await makeTestEnv();
    try {
      expect(await shimStatus("claude")).toEqual({ fresh: false, isDev: false });
    } finally {
      await env.restore();
    }
  });

  it("canonical executable shim is fresh", async () => {
    const env = await makeTestEnv();
    try {
      await installShim("claude", { mode: "install" });
      expect(await shimStatus("claude")).toEqual({ fresh: true, isDev: false });
    } finally {
      await env.restore();
    }
  });

  it.skipIf(IS_WIN)("canonical body without exec mode is stale (B15)", async () => {
    const env = await makeTestEnv();
    try {
      await installShim("claude", { mode: "install" });
      await fs.chmod(stableShimPath("claude"), 0o644);
      expect(await shimStatus("claude")).toEqual({ fresh: false, isDev: false });
    } finally {
      await env.restore();
    }
  });

  it("unmarked foreign body is stale even when executable (B14)", async () => {
    const env = await makeTestEnv();
    try {
      const shimFile = stableShimPath("claude");
      await fs.mkdir(path.dirname(shimFile), { recursive: true });
      await fs.writeFile(
        shimFile,
        `#!/bin/sh\nset +e\n'/private/tmp/gone/node' '/private/tmp/gone/index.js' hook claude "$@"\nexit 0\n`,
        "utf8",
      );
      await fs.chmod(shimFile, 0o755);
      expect(await shimStatus("claude")).toEqual({ fresh: false, isDev: false });
    } finally {
      await env.restore();
    }
  });

  it("dev-marked executable shim is fresh and dev", async () => {
    const env = await makeTestEnv();
    try {
      await installShim("claude", { mode: "install", isDev: true });
      expect(await shimStatus("claude")).toEqual({ fresh: true, isDev: true });
    } finally {
      await env.restore();
    }
  });

  it.skipIf(IS_WIN)("dev-marked shim without exec mode is stale but still dev (B15)", async () => {
    const env = await makeTestEnv();
    try {
      await installShim("claude", { mode: "install", isDev: true });
      await fs.chmod(stableShimPath("claude"), 0o644);
      expect(await shimStatus("claude")).toEqual({ fresh: false, isDev: true });
    } finally {
      await env.restore();
    }
  });
});

describe("writeFileIfChanged", () => {
  it("creates, skips identical content (mtime stable), rewrites changed content", async () => {
    const env = await makeTestEnv();
    try {
      const file = path.join(env.home, "sub", "x.json");
      expect(await writeFileIfChanged(file, "{}\n")).toBe(true);
      const stat1 = await fs.stat(file);

      await new Promise((r) => setTimeout(r, 10));
      expect(await writeFileIfChanged(file, "{}\n")).toBe(false);
      expect((await fs.stat(file)).mtimeMs).toBe(stat1.mtimeMs);

      expect(await writeFileIfChanged(file, '{"a":1}\n')).toBe(true);
      expect(await fs.readFile(file, "utf8")).toBe('{"a":1}\n');
    } finally {
      await env.restore();
    }
  });
});
