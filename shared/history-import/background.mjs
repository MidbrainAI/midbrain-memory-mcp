import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cacheDir } from "../state-dir.mjs";
import { logFile } from "../logger.mjs";

export const importStateDir = () => path.join(cacheDir(), "history-import");

/** A lock survives abnormal termination: fail closed rather than overlap uploads. */
export function claimImport(dir = importStateDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, "active.json");
  const owner = JSON.stringify({ pid: process.pid, token: randomUUID() });
  try { fs.writeFileSync(lock, owner, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`An import is active or was interrupted. Run import --status. If its process has exited, remove ${lock} before retrying.`, { cause: error });
  }
  return () => {
    if (fs.readFileSync(lock, "utf8") === owner) fs.unlinkSync(lock);
  };
}

export function writeImportStatus(status, dir = importStateDir()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `${randomUUID()}.json`);
  fs.writeFileSync(temp, JSON.stringify(status), { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, path.join(dir, "status.json"));
}

export function readImportStatus(dir = importStateDir()) {
  let status;
  try { status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return "No background import recorded."; throw error; }
  if (status.state === "running") {
    try { process.kill(status.pid, 0); }
    catch (error) { if (error.code === "ESRCH") status.state = "interrupted"; }
  }
  return `${status.state}: ${status.stored ?? 0}/${status.total} entries stored (PID ${status.pid}).\nLog: ${status.logPath}`;
}

/** No history or credentials on disk: IPC carries the exact confirmed snapshot. */
export async function startBackgroundImport(sessions, { spawn = nodeSpawn, timeoutMs = 30_000, logPath = logFile(`midbrain-import-${randomUUID()}.log`) } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./worker.mjs", import.meta.url))], {
      detached: true, windowsHide: true, serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { reject(error); }
      else {
        if (child.connected) child.disconnect();
        child.unref();
        resolve({ pid: child.pid, logPath });
      }
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`Import worker did not start; check ${logPath}`)); }, timeoutMs);
    child.once("error", finish);
    child.once("exit", () => finish(new Error(`Import worker exited before startup; check ${logPath}`)));
    child.once("message", (message) => finish(message.ready ? null : new Error(message.error || "Import worker failed")));
    child.send({ sessions, logPath }, (error) => { if (error) finish(error); });
  });
}
