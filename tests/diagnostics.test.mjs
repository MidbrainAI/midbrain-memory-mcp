import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  assembleDiagnosticsReport,
  assembleResolutionFailureReport,
  credentialShadowNote,
  homeRelativePath,
  nextStepsFor,
  probeApi,
  runMemoryDiagnostics,
} from "../shared/diagnostics.mjs";
import { _setCachePath, appendToCache } from "../shared/episodic-cache.mjs";

describe("homeRelativePath", () => {
  it("renders POSIX home paths without the username", () => {
    expect(homeRelativePath("/Users/alice/project/file", "/Users/alice", "linux"))
      .toBe("~/project/file");
    expect(homeRelativePath("/Users/alice", "/Users/alice", "linux")).toBe("~");
    expect(homeRelativePath("/opt/midbrain", "/Users/alice", "linux"))
      .toBe("/opt/midbrain");
  });

  it("renders win32 home paths with portable separators", () => {
    expect(homeRelativePath(
      "C:\\Users\\Alice\\AppData\\Local\\midbrain",
      "c:\\users\\alice",
      "win32",
    )).toBe("~/AppData/Local/midbrain");
  });

  it("leaves environment and default source labels unchanged", () => {
    expect(homeRelativePath("env:MIDBRAIN_API_KEY", "/Users/alice", "linux"))
      .toBe("env:MIDBRAIN_API_KEY");
    expect(homeRelativePath("default", "/Users/alice", "linux")).toBe("default");
  });
});

const BASE_STATE = {
  version: "0.4.7",
  clientId: "opencode",
  projectDir: "/Users/alice/project",
  homeDir: "/Users/alice",
  apiBase: "https://memory.midbrain.ai",
  apiBaseScope: "default",
  apiBaseSource: "default",
  keyScope: "global",
  keySource: "/Users/alice/.config/midbrain/.midbrain-key",
  credentialScopes: [
    { scope: "project", status: "absent" },
    { scope: "client", status: "absent" },
    {
      scope: "global",
      status: "present",
      winner: true,
      source: "/Users/alice/.config/midbrain/.midbrain-key",
    },
    { scope: "environment", status: "absent" },
  ],
  probeStatus: "ok",
  pendingEntries: 0,
  cacheFilesPresent: false,
  otherBindings: 0,
  cacheDir: "/Users/alice/.cache/midbrain",
  logPath: "/Users/alice/Library/Logs/midbrain/midbrain-opencode.log",
};

describe("credentialShadowNote", () => {
  it("reports a differing higher-priority credential", () => {
    expect(credentialShadowNote("project", "project-secret", "global-secret"))
      .toBe("project credential shadows the global credential for this client");
  });

  it("does not warn for identical, absent, or lower-priority credentials", () => {
    expect(credentialShadowNote("client", "same", "same")).toBeNull();
    expect(credentialShadowNote("project", "only-project", null)).toBeNull();
    expect(credentialShadowNote("global", "global", "global")).toBeNull();
  });
});

describe("nextStepsFor", () => {
  it("selects auth, cache, custom-host, shadow, and credential-file guidance", () => {
    expect(nextStepsFor({ probeStatus: "auth-failed (401)" }).join("\n"))
      .toContain("credential scope");
    expect(nextStepsFor({ pendingEntries: 2 }).join("\n"))
      .toContain("auto-flush");
    expect(nextStepsFor({ apiBaseScope: "client" }).join("\n"))
      .toContain("non-default host");
    expect(nextStepsFor({ shadowNote: "project credential shadows global" }).join("\n"))
      .toContain("shadowing note");
    expect(nextStepsFor({ credentialError: "empty file" }).join("\n"))
      .toContain("credential file");
  });
});

describe("assembleDiagnosticsReport", () => {
  it("assembles a deterministic healthy report without usernames", () => {
    const report = assembleDiagnosticsReport(BASE_STATE);
    expect(report).toContain("MidBrain memory diagnostics");
    expect(report).toContain("version: 0.4.7");
    expect(report).toContain("client: opencode");
    expect(report).toContain("project: ~/project");
    expect(report).toContain("api_host: https://memory.midbrain.ai");
    expect(report).toContain("api_scope: default");
    expect(report).toContain("credential_scope: global");
    expect(report).toContain("credential_source: ~/.config/midbrain/.midbrain-key");
    expect(report).toContain("probe: ok");
    expect(report).toContain("pending_entries: 0");
    expect(report).toContain("other_cache_bindings_with_pending_entries: 0");
    expect(report).not.toContain("alice");
    expect(report).not.toContain("note:");
  });

  it("includes the shadow note and malformed-only cache wording", () => {
    const report = assembleDiagnosticsReport({
      ...BASE_STATE,
      shadowNote: "client credential shadows the global credential for this client",
      cacheFilesPresent: true,
    });
    expect(report).toContain(
      "note: client credential shadows the global credential for this client",
    );
    expect(report).toContain(
      "pending_entries: 0 valid entries (cache files present but unparseable)",
    );
  });

  it("reports an unset project without synthesizing a path", () => {
    const report = assembleDiagnosticsReport({ ...BASE_STATE, projectDir: undefined });
    expect(report).toContain("project: not configured");
    expect(report).not.toContain("undefined");
  });
});

describe("assembleResolutionFailureReport", () => {
  it("reports no configured credential with checked scopes", () => {
    const report = assembleResolutionFailureReport({
      version: "0.4.7",
      clientId: "codex",
      error: new Error("No API key configured. Run: npx midbrain-memory-mcp install"),
    });
    expect(report).toContain("credential_error: no credential found");
    expect(report).toContain("scopes_checked: project, client, global, environment");
    expect(report).toContain("npx midbrain-memory-mcp install");
  });

  it("sanitizes an empty credential file error", () => {
    const report = assembleResolutionFailureReport({
      version: "0.4.7",
      clientId: "codex",
      homeDir: "/Users/alice",
      error: new Error("Key file is empty: /Users/alice/.codex/.midbrain-key"),
    });
    expect(report).toContain("credential_error: empty file ~/.codex/.midbrain-key");
    expect(report).not.toContain("alice");
  });

  it("sanitizes an unreadable credential file error", () => {
    const report = assembleResolutionFailureReport({
      version: "0.4.7",
      clientId: "codex",
      homeDir: "/Users/alice",
      error: new Error(
        "Permission denied reading key file: /Users/alice/.codex/.midbrain-key",
      ),
    });
    expect(report).toContain("credential_error: unreadable file ~/.codex/.midbrain-key");
    expect(report).toContain("repair the credential file shown above");
    expect(report).not.toContain("alice");
  });
});

describe("probeApi", () => {
  afterEach(() => { delete process.env.MIDBRAIN_SIMULATE_OFFLINE; });

  it("classifies success, auth, network, HTTP classes, skipped, and simulated offline", async () => {
    const api = { EPISODIC: "https://example.test/episodic", fetch: vi.fn() };
    api.fetch.mockResolvedValueOnce({ items: [] });
    await expect(probeApi(api, true)).resolves.toBe("ok");
    api.fetch.mockRejectedValueOnce(new Error("API 401 (auth failed): host=x"));
    await expect(probeApi(api, true)).resolves.toBe("auth-failed (401)");
    api.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(probeApi(api, true)).resolves.toBe("network-error");
    api.fetch.mockRejectedValueOnce(new Error("API 503: unavailable"));
    await expect(probeApi(api, true)).resolves.toBe("http-5xx");
    api.fetch.mockRejectedValueOnce(new Error("API 418: teapot"));
    await expect(probeApi(api, true)).resolves.toBe("http-4xx");
    await expect(probeApi(api, false)).resolves.toBe("skipped");
    process.env.MIDBRAIN_SIMULATE_OFFLINE = "1";
    await expect(probeApi(api, true)).resolves.toBe("network-error");
  });
});

describe("runMemoryDiagnostics", () => {
  const dirs = [];

  afterEach(() => {
    _setCachePath(null);
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("has no output caller for credential fingerprint helpers", () => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const outputSources = [
      "mcp.mjs",
      "shared/diagnostics.mjs",
      "shared/midbrain-api.mjs",
      "plugins/opencode/midbrain-memory.ts",
    ].map((name) => fs.readFileSync(path.join(repoRoot, name), "utf8"));
    const callers = outputSources.join("\n");
    expect(callers).not.toContain("api.keyFingerprint");
    expect(callers).not.toContain("BaseClient.maskKey");
  });

  function fakeApi(overrides = {}) {
    return {
      effectiveApiBase: "https://memory.midbrain.ai",
      apiBaseScope: "default",
      apiBaseSource: "default",
      keyScope: "global",
      keySource: "/Users/alice/.config/midbrain/.midbrain-key",
      credentialScopes: BASE_STATE.credentialScopes,
      credentialShadowNote: null,
      cacheScope: "current-binding",
      EPISODIC: "https://memory.midbrain.ai/api/v1/memories/episodic",
      fetch: vi.fn().mockResolvedValue({ items: [] }),
      ...overrides,
    };
  }

  it.each(["opencode", "codex"])("reports B1 for %s", async (clientId) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-run-"));
    dirs.push(dir);
    _setCachePath(dir);
    const report = await runMemoryDiagnostics({
      probe: true,
      createApi: async () => fakeApi(),
      clientId,
      projectDir: "/Users/alice/project",
      homeDir: "/Users/alice",
      version: "0.4.7",
    });
    expect(report).toContain(`client: ${clientId}`);
    expect(report).toContain("probe: ok");
    expect(report).toContain("pending_entries: 0");
  });

  it.each(["opencode", "codex"])("distinguishes B3 capture pending for %s", async (clientId) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-run-"));
    dirs.push(dir);
    _setCachePath(dir);
    appendToCache({ text: "pending", role: "user" }, "current-binding");
    const report = await runMemoryDiagnostics({
      probe: true,
      createApi: async () => fakeApi(),
      clientId,
      homeDir: "/Users/alice",
      version: "0.4.7",
    });
    expect(report).toContain("probe: ok");
    expect(report).toContain("pending_entries: 1");
    expect(report).toContain("auto-flush");
    expect(report).not.toContain("current-binding");
  });

  it.each(["opencode", "codex"])(
    "supports probe:false and reports B4 for %s without credential fragments",
    async (clientId) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-run-"));
    dirs.push(dir);
    _setCachePath(dir);
    const report = await runMemoryDiagnostics({
      probe: false,
      createApi: async () => fakeApi({
        credentialShadowNote: "client credential shadows the global credential for this client",
      }),
      clientId,
      homeDir: "/Users/alice",
      version: "0.4.7",
    });
    expect(report).toContain("probe: skipped");
    expect(report).toContain("client credential shadows the global credential for this client");
    expect(report).not.toMatch(/secret|\.\.\.[A-Za-z0-9]{4}/i);
    },
  );

  it("distinguishes B2 auth failure from B3 capture pending", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-run-"));
    dirs.push(dir);
    _setCachePath(dir);
    const api = fakeApi();
    api.fetch.mockRejectedValue(new Error("API 401 (auth failed): host=x"));
    const report = await runMemoryDiagnostics({
      probe: true,
      createApi: async () => api,
      clientId: "opencode",
      homeDir: "/Users/alice",
      version: "0.4.7",
    });
    expect(report).toContain("probe: auth-failed (401)");
    expect(report).toContain("pending_entries: 0");
    expect(report).toContain("credential scope");
    expect(report).not.toContain("auto-flush");
  });

  it.each([
    ["B5", "client", "/Users/alice/.config/midbrain/config.json", "http-4xx"],
    ["B6", "environment", "env:MIDBRAIN_API_URL", "network-error"],
  ])("reports %s custom-host scope %s with actionable guidance", async (
    _scenario,
    scope,
    source,
    expectedProbe,
  ) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-run-"));
    dirs.push(dir);
    _setCachePath(dir);
    const api = fakeApi({
      effectiveApiBase: "https://staging.example.test",
      apiBaseScope: scope,
      apiBaseSource: source,
    });
    api.fetch.mockRejectedValue(
      expectedProbe === "http-4xx" ? new Error("API 404: not found") : new TypeError("fetch failed"),
    );
    const report = await runMemoryDiagnostics({
      probe: true,
      createApi: async () => api,
      clientId: "codex",
      homeDir: "/Users/alice",
      version: "0.4.7",
    });
    expect(report).toContain(`api_scope: ${scope}`);
    expect(report).toContain(
      `api_source: ${scope === "client" ? "~/.config/midbrain/config.json" : source}`,
    );
    expect(report).toContain(`probe: ${expectedProbe}`);
    expect(report).toContain("verify the non-default host source shown above is intentional");
    expect(report).not.toContain("alice");
  });

  it.each([
    [
      "B7 no key configured",
      new Error("No API key configured. Run: npx midbrain-memory-mcp install"),
      "credential_error: no credential found",
    ],
    [
      "B8 unreadable source",
      new Error(
        "Permission denied reading key file: /Users/alice/.config/codex/.midbrain-key",
      ),
      "credential_error: unreadable file ~/.config/codex/.midbrain-key",
    ],
  ])("reports %s through the diagnostics runner", async (_scenario, error, expected) => {
    const report = await runMemoryDiagnostics({
      createApi: async () => { throw error; },
      clientId: "codex",
      projectDir: "/Users/alice/project",
      homeDir: "/Users/alice",
      version: "0.4.7",
    });
    expect(report).toContain(expected);
    expect(report).toContain("project: ~/project");
    expect(report).not.toContain("alice");
  });

  it("reports B9 probe:false with the remaining static diagnostics", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-run-"));
    dirs.push(dir);
    _setCachePath(dir);
    const api = fakeApi();
    const report = await runMemoryDiagnostics({
      probe: false,
      createApi: async () => api,
      clientId: "opencode",
      projectDir: "/Users/alice/project",
      homeDir: "/Users/alice",
      version: "0.4.7",
    });
    expect(report).toContain("probe: skipped");
    expect(report).toContain("api_host: https://memory.midbrain.ai");
    expect(report).toContain("credential_scope: global");
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("reports B10 with no project directory or placeholder leakage", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-run-"));
    dirs.push(dir);
    _setCachePath(dir);
    const report = await runMemoryDiagnostics({
      probe: false,
      createApi: async () => fakeApi(),
      clientId: "codex",
      homeDir: "/Users/alice",
      version: "0.4.7",
    });
    expect(report).toContain("project: not configured");
    expect(report).not.toMatch(/undefined|placeholder/i);
  });

  it("audits B1-B10 reports together for paths and credential fragments", async () => {
    const reports = [];
    const run = async (options = {}) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-audit-"));
      dirs.push(dir);
      _setCachePath(dir);
      if (options.pending) appendToCache({ text: "pending", role: "user" }, "current-binding");
      const api = fakeApi(options.api);
      if (options.probeError) api.fetch.mockRejectedValue(options.probeError);
      reports.push(await runMemoryDiagnostics({
        probe: options.probe,
        createApi: options.createApi || (async () => api),
        clientId: options.clientId || "codex",
        projectDir: options.projectDir,
        homeDir: "/Users/alice",
        logPath: "/Users/alice/Library/Logs/midbrain/midbrain-codex.log",
        version: "0.4.7",
      }));
    };

    await run({ projectDir: "/Users/alice/project" }); // B1
    await run({ probeError: new Error("API 401 (auth failed): host=x") }); // B2
    await run({ pending: true }); // B3
    await run({ api: {
      credentialShadowNote: "client credential shadows the global credential for this client",
    } }); // B4
    await run({ api: {
      effectiveApiBase: "https://client.example.test",
      apiBaseScope: "client",
      apiBaseSource: "/Users/alice/.config/midbrain/config.json",
    } }); // B5
    await run({ api: {
      effectiveApiBase: "https://environment.example.test",
      apiBaseScope: "environment",
      apiBaseSource: "env:MIDBRAIN_API_URL",
    } }); // B6
    await run({ createApi: async () => {
      throw new Error("No API key configured. Run: npx midbrain-memory-mcp install");
    } }); // B7
    await run({ createApi: async () => {
      throw new Error(
        "Permission denied reading key file: /Users/alice/.config/codex/.midbrain-key",
      );
    } }); // B8
    await run({ probe: false }); // B9
    await run({ projectDir: undefined }); // B10

    expect(reports).toHaveLength(10);
    for (const report of reports) {
      expect(report).not.toMatch(/\/Users\/[^/\s]+/);
      expect(report).not.toMatch(/\b[a-f0-9]{64}\b/i);
      expect(report).not.toMatch(/A1b2|secret-A1b2|key=/i);
    }
  });
});
