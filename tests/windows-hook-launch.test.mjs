import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeTestEnv } from "./helpers/test-env.mjs";
import { buildShimBody, shimCommand, stableShimPath, installShim } from "../shared/clients/shim.mjs";

const gitBash = "C:/Program Files/Git/bin/bash.exe";
const clients = ["codex", "claude", "cursor", "hermes"];

describe.skipIf(process.platform !== "win32")("native Windows hook launch", () => {
  it.each(clients)("%s forwards stdin and role through cmd, PowerShell, and Git Bash", async (client) => {
    const env = await makeTestEnv({ homeName: "User O'Brien space" });
    try {
      const repo = path.join(env.root, "checkout space");
      await fs.mkdir(repo);
      await fs.writeFile(path.join(repo, "index.js"), 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:s}));});');
      const shim = stableShimPath(client);
      await fs.mkdir(path.dirname(shim), { recursive: true });
      await fs.writeFile(shim, buildShimBody(client, { isDev: true, repoRoot: repo }));
      const command = shimCommand(client, "user");
      for (const [exe, args] of [["cmd.exe", ["/d", "/s", "/c", command]], ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]], [gitBash, ["-c", command]]]) {
        const child = spawnSync(exe, args, { input: '{"prompt":"hello"}', encoding: "utf8", env: env.childEnv(), windowsHide: true, windowsVerbatimArguments: exe === "cmd.exe", timeout: 15000 });
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({ args: ["hook", client, "user"], input: '{"prompt":"hello"}' });
      }
    } finally { await env.restore(); }
  });

  it.each(clients)("%s canonical launcher resolves npx and forwards stdin", async (client) => {
    const env = await makeTestEnv();
    try {
      const bin = path.join(env.root, "fake bin");
      await fs.mkdir(bin);
      const probe = path.join(bin, "probe.cjs");
      await fs.writeFile(probe, 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({args:process.argv.slice(2),input:s})));');
      await fs.writeFile(path.join(bin, "npx.cmd"), `@echo off\r\n"${process.execPath}" "${probe}" %*\r\n`);
      const shim = stableShimPath(client);
      await fs.mkdir(path.dirname(shim), { recursive: true });
      await fs.writeFile(shim, buildShimBody(client));
      const childEnv = env.childEnv();
      const pathKey = Object.keys(childEnv).find((key) => key.toLowerCase() === "path") || "PATH";
      childEnv[pathKey] = bin + path.delimiter + childEnv[pathKey];
      const child = spawnSync(process.execPath, [shim, "user"], { input: '{"prompt":"canonical"}', encoding: "utf8", env: childEnv, windowsHide: true, timeout: 15000 });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({ args: ["-y", "midbrain-memory-mcp@latest", "hook", client, "user"], input: '{"prompt":"canonical"}' });
    } finally { await env.restore(); }
  });

  it.each(clients)("%s repair does not silently replace a legacy development checkout", async (client) => {
    const env = await makeTestEnv();
    try {
      const target = stableShimPath(client);
      const legacy = target.replace(/\.cjs$/, client === "codex" ? "" : ".cmd");
      const body = client === "codex" ? "#!/bin/sh\n# midbrain-dev\ncustom-checkout-command\n" : "@echo off\r\n@rem midbrain-dev\r\ncustom-checkout-command\r\n";
      await fs.mkdir(path.dirname(legacy), { recursive: true });
      await fs.writeFile(legacy, body);
      await expect(installShim(client, { mode: "repair" })).rejects.toThrow(/install --dev/);
      expect(await fs.readFile(legacy, "utf8")).toBe(body);
      await expect(fs.stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      await installShim(client, { mode: "install", isDev: true });
      expect(await fs.readFile(target, "utf8")).toContain("// midbrain-dev");
    } finally { await env.restore(); }
  });

  it("Codex emits protocol fallback when its child fails", async () => {
    const env = await makeTestEnv();
    try {
      const repo = path.join(env.root, "probe");
      await fs.mkdir(repo);
      await fs.writeFile(path.join(repo, "index.js"), 'process.exit(7);');
      const shim = stableShimPath("codex");
      await fs.mkdir(path.dirname(shim), { recursive: true });
      await fs.writeFile(shim, buildShimBody("codex", { isDev: true, repoRoot: repo }));
      for (const role of ["assistant", "tool", "user"]) {
        const child = spawnSync("cmd.exe", ["/d", "/s", "/c", shimCommand("codex", role)], { encoding: "utf8", env: env.childEnv(), windowsHide: true, windowsVerbatimArguments: true });
        expect(child.status).toBe(0);
        expect(child.stdout.trim()).toBe(role === "user" ? "" : "{}");
      }
    } finally { await env.restore(); }
  });
});
