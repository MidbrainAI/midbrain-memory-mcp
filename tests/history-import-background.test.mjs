import { describe, it, expect, vi } from "vitest";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { sandboxHomeEnv } from "./helpers/sandboxed-child-env.mjs";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { MidbrainApi } from "../shared/midbrain-api.mjs";
import { importId } from "../shared/history-import/plan.mjs";
import os from "node:os";
import path from "node:path";
import { startBackgroundImport, claimImport, readImportStatus } from "../shared/history-import/background.mjs";

describe("background history import", () => {
  it.each(["success", "binding-changed", "dedupe-failed"])("real worker: %s", async (mode) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-import-api-"));
    const posts = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.method === "GET") {
          res.statusCode = mode === "dedupe-failed" ? 500 : 200;
          res.end(JSON.stringify({ items: [], next_cursor: null }));
        } else {
          posts.push({ body: JSON.parse(body), skip: req.headers["x-skip-dream"] });
          res.end("{}");
        }
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const host = `http://127.0.0.1:${server.address().port}`;
      const key = "test-import-background-key";
      fs.mkdirSync(path.join(dir, ".midbrain"));
      fs.writeFileSync(path.join(dir, ".midbrain", ".midbrain-key"), key);
      fs.writeFileSync(path.join(dir, ".midbrain", "config.json"), JSON.stringify({ apiUrl: host }));
      const binding = { host, fingerprint: new MidbrainApi(key, "test", { apiBase: host }).keyFingerprint };
      if (mode === "binding-changed") binding.fingerprint = "different";
      const sessions = ["2026-09-02T10:00:00Z", "2026-09-01T10:00:00Z"].map((occurredAt, index) => {
        const session = { client: "codex", cwd: dir, sessionId: `s${index}`, entries: [
          { role: "user", text: `prompt${index}`, occurredAt, importBinding: binding },
        ] };
        session.importIds = new Set(session.entries.map((entry) => importId(session, entry)));
        return session;
      });
      const spawn = (exe, args, options) => nodeSpawn(exe, args, { ...options,
        env: sandboxHomeEnv(dir, { MIDBRAIN_STATE_DIR: path.join(dir, "state") }),
      });
      await startBackgroundImport(sessions, { spawn, logPath: path.join(dir, "import.log") });
      const stateDir = path.join(dir, "state", "cache", "history-import");
      await vi.waitFor(() => expect(readImportStatus(stateDir)).toContain(mode === "success" ? "complete: 2/2" : "failed:"), { timeout: 10000 });
      await vi.waitFor(() => expect(fs.existsSync(path.join(stateDir, "active.json"))).toBe(false));
      if (mode === "success") {
        expect(posts.map((post) => post.body.text)).toEqual(["prompt1", "prompt0"]);
        expect(posts.every((post) => post.skip === undefined)).toBe(true);
      } else { expect(posts).toEqual([]); }
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("continues after its launching process exits and preserves Sets over IPC", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-import-detach-"));
    const worker = path.join(dir, "fixture-worker.mjs");
    const parent = path.join(dir, "fixture-parent.mjs");
    const exited = path.join(dir, "parent-exited");
    const completed = path.join(dir, "completed");
    try {
      fs.writeFileSync(worker, `
        import fs from "node:fs";
        process.once("message", (job) => {
          if (!(job.sessions[0].importIds instanceof Set)) process.exit(2);
          process.send({ ready: true }, () => { if (process.connected) process.disconnect(); });
          const timer = setInterval(() => {
            if (fs.existsSync(${JSON.stringify(exited)})) {
              fs.writeFileSync(${JSON.stringify(completed)}, "done");
              clearInterval(timer);
            }
          }, 20);
          setTimeout(() => process.exit(3), 10000).unref();
        });
      `);
      fs.writeFileSync(parent, `
        import { spawn } from "node:child_process";
        import { startBackgroundImport } from ${JSON.stringify(new URL("../shared/history-import/background.mjs", import.meta.url).href)};
        await startBackgroundImport([{ importIds: new Set(["approved"]) }], {
          logPath: ${JSON.stringify(path.join(dir, "import.log"))},
          spawn: (exe, _args, options) => spawn(exe, [${JSON.stringify(worker)}], options),
        });
      `);
      const result = spawnSync(process.execPath, [parent], { timeout: 5000, encoding: "utf8", env: sandboxHomeEnv(dir) });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(completed)).toBe(false);
      fs.writeFileSync(exited, "exited");
      await vi.waitFor(() => expect(fs.existsSync(completed)).toBe(true), { timeout: 5000 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 15000);

  it("starts the real worker without a terminal and records completion", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-import-worker-"));
    try {
      const spawn = (exe, args, options) => nodeSpawn(exe, args, { ...options,
        env: sandboxHomeEnv(dir, { MIDBRAIN_STATE_DIR: dir, MIDBRAIN_LOG_DIR: dir }),
      });
      await startBackgroundImport([], { spawn, logPath: path.join(dir, "import.log") });
      const stateDir = path.join(dir, "cache", "history-import");
      await vi.waitFor(() => expect(readImportStatus(stateDir)).toContain("complete: 0/0"), { timeout: 10000 });
      await vi.waitFor(() => expect(fs.existsSync(path.join(stateDir, "active.json"))).toBe(false));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 15000);

  it("hands off only the approved snapshot, detaches, and does not inherit terminal handles", async () => {
    const child = new EventEmitter();
    child.pid = 123;
    child.unref = vi.fn();
    child.kill = vi.fn();
    child.connected = true;
    child.disconnect = vi.fn(() => { child.connected = false; });
    child.send = vi.fn((_job, callback) => { callback?.(); process.nextTick(() => child.emit("message", { ready: true })); });
    const spawn = vi.fn(() => child);
    const sessions = [{ entries: [{ text: "approved" }] }];
    const job = await startBackgroundImport(sessions, { spawn });
    expect(spawn.mock.calls[0][2]).toMatchObject({ detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    expect(child.send.mock.calls[0][0].sessions).toEqual(sessions);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(child.disconnect).toHaveBeenCalledOnce();
    expect(job.pid).toBe(123);
  });

  it("reports worker startup errors rather than claiming an import started", async () => {
    const child = new EventEmitter();
    child.kill = vi.fn();
    child.send = vi.fn(() => process.nextTick(() => child.emit("message", { error: "Another import is running" })));
    await expect(startBackgroundImport([], { spawn: () => child })).rejects.toThrow("Another import is running");
  });

  it("holds one lock across clients and releases it only for its owner", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "midbrain-import-lock-"));
    try {
      const release = claimImport(dir);
      expect(() => claimImport(dir)).toThrow(/import/);
      release();
      const nextRelease = claimImport(dir);
      nextRelease();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
