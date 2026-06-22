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
import { beforeEach, afterEach, vi } from "vitest";
import fsSync from "fs";
import fs from "fs/promises";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { formatPkContext } from "../shared/pk-inject.mjs";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "..");
const BUNDLE_PATH = path.join(REPO_ROOT, "dist", "midbrain-shared.mjs");
const SHIM_PATH = path.join(REPO_ROOT, "plugins", "opencode", "midbrain-shared.mjs");
const PLUGIN_PATH = path.join(REPO_ROOT, "plugins", "opencode", "midbrain-memory.ts");
const PK_ENV = "MIDBRAIN_ENABLE_PK_INJECTION";

async function pluginImportedSymbols() {
  const source = await fs.readFile(PLUGIN_PATH, "utf8");
  const match = source.match(/import\s*\{([^}]+)\}\s*from\s*["']\.\/midbrain-shared\.mjs["']/);
  if (!match) return [];
  return match[1].split(",")
    .map((part) => part.replace(/\btype\b/g, "").trim())
    .filter(Boolean);
}

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

  it("bundle exports every runtime symbol imported by the plugin", async () => {
    const bundle = await import(pathToFileURL(BUNDLE_PATH).href);
    const symbols = await pluginImportedSymbols();

    for (const symbol of symbols) {
      if (symbol === "Plugin") continue;
      expect(bundle[symbol], `missing bundle export: ${symbol}`).toBeDefined();
    }
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

  it("dev shim exports every runtime symbol imported by the plugin", async () => {
    const shim = await import(pathToFileURL(SHIM_PATH).href);
    const symbols = await pluginImportedSymbols();

    for (const symbol of symbols) {
      if (symbol === "Plugin") continue;
      expect(shim[symbol], `missing shim export: ${symbol}`).toBeDefined();
    }
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

  it("exports only callable plugin functions for OpenCode's loader", async () => {
    const plugin = await import(pathToFileURL(PLUGIN_PATH).href);
    const exportedValues = Object.values(plugin);

    expect(exportedValues.length).toBeGreaterThan(0);
    expect(exportedValues.every((value) => typeof value === "function")).toBe(true);
    expect(typeof plugin.MidBrainMemoryPlugin).toBe("function");
    expect(typeof plugin.default).toBe("function");
    expect(plugin.default).toBe(plugin.MidBrainMemoryPlugin);
    expect(plugin.OPENCODE_HISTORY_TIMEOUT_MS).toBeUndefined();
    expect(plugin.normalizeHistoryMessages).toBeUndefined();
    expect(plugin.textPartsFromMessages).toBeUndefined();
    expect(plugin.fetchPriorMessageTexts).toBeUndefined();
  });
});

describe("OpenCode plugin PK delivery helpers", () => {
  let originalHome;
  let originalPkEnv;
  let tempHome;
  let fetchSpy;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalPkEnv = process.env[PK_ENV];
    tempHome = fsSync.mkdtempSync(path.join(os.tmpdir(), "opencode-plugin-home-"));
    const keyDir = path.join(tempHome, ".config", "midbrain");
    fsSync.mkdirSync(keyDir, { recursive: true });
    fsSync.writeFileSync(path.join(keyDir, ".midbrain-key"), "test-key\n", { mode: 0o600 });
    process.env.HOME = tempHome;
    delete process.env[PK_ENV];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const text = String(url);
      if (text.includes("/memories/episodic")) return { ok: true, status: 201 };
      if (text.includes("/memories/search/procedural")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 7, title: "OpenCode", content: "mutate current output parts" }],
        };
      }
      return { ok: false, status: 404, text: async () => "not found" };
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.HOME = originalHome;
    if (originalPkEnv === undefined) delete process.env[PK_ENV];
    else process.env[PK_ENV] = originalPkEnv;
    fsSync.rmSync(tempHome, { recursive: true, force: true });
  });

  it("stores user text without procedural search or message mutation by default", async () => {
    const { MidBrainMemoryPlugin } = await import(pathToFileURL(PLUGIN_PATH).href);
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue([]),
      },
    };
    const hooks = await MidBrainMemoryPlugin({ client, directory: "/repo" });
    const output = {
      message: { id: "m1" },
      parts: [{ type: "text", text: "How does OpenCode deliver context?" }],
    };

    await hooks["chat.message"]({ sessionID: "session-1" }, output);

    expect(output.parts[0].text).toBe("How does OpenCode deliver context?");
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("/search/procedural"))).toBe(false);
  });

  it("mutates the current chat.message text part when PK matches and injection is opted in", async () => {
    process.env[PK_ENV] = "1";
    const { MidBrainMemoryPlugin } = await import(pathToFileURL(PLUGIN_PATH).href);
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue([]),
      },
    };
    const hooks = await MidBrainMemoryPlugin({ client, directory: "/repo" });
    const output = {
      message: { id: "m1" },
      parts: [{ type: "text", text: "How does OpenCode deliver context?" }],
    };

    await hooks["chat.message"]({ sessionID: "session-1" }, output);

    expect(output.parts[0].text).toContain("<!-- mb:ctx-start -->");
    expect(output.parts[0].text).toContain("OpenCode");
    expect(output.parts[0].text).toContain("How does OpenCode deliver context?");
    const [searchUrl] = fetchSpy.mock.calls.find(([url]) => String(url).includes("/search/procedural"));
    expect(new URL(searchUrl).searchParams.getAll("exclude_ids")).toEqual([]);
  });

  it("extracts prior PK ids from wrapped OpenCode history responses", async () => {
    process.env[PK_ENV] = "1";
    const { MidBrainMemoryPlugin } = await import(pathToFileURL(PLUGIN_PATH).href);
    const priorBlock = formatPkContext([{ id: 42, title: "Prior", content: "exclude me" }]);
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue({
          data: [{ parts: [{ type: "text", text: priorBlock }] }],
        }),
      },
    };
    const hooks = await MidBrainMemoryPlugin({ client, directory: "/repo" });
    const output = {
      message: { id: "m1" },
      parts: [{ type: "text", text: "How does OpenCode deliver context?" }],
    };

    await hooks["chat.message"]({ sessionID: "session-1" }, output);

    const [searchUrl] = fetchSpy.mock.calls.find(([url]) => String(url).includes("/search/procedural"));
    expect(new URL(searchUrl).searchParams.getAll("exclude_ids")).toEqual(["42"]);
  });

  it("scrubs injected PK echoes before storing assistant messages", async () => {
    const { MidBrainMemoryPlugin } = await import(pathToFileURL(PLUGIN_PATH).href);
    const block = formatPkContext([{ id: 13, title: "Echo Risk", content: "do not store me" }]);
    const client = {
      session: {
        messages: vi.fn().mockResolvedValue([]),
        message: vi.fn().mockResolvedValue({
          data: {
            parts: [{ type: "text", text: `${block}\n\nVisible answer` }],
          },
        }),
      },
    };
    const hooks = await MidBrainMemoryPlugin({ client, directory: "/repo" });

    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-1",
            role: "assistant",
            sessionID: "session-1",
            time: { completed: Date.now() },
            path: { cwd: "/repo" },
          },
        },
      },
    });

    await vi.waitFor(() => {
      const episodicCall = fetchSpy.mock.calls.find(([url]) => String(url).includes("/memories/episodic"));
      expect(episodicCall).toBeDefined();
      const body = JSON.parse(episodicCall[1].body);
      expect(body.text).toBe("Visible answer");
      expect(body.text).not.toContain("Echo Risk");
      expect(body.text).not.toContain("<!-- mb:pk 13 -->");
    });
  });
});
