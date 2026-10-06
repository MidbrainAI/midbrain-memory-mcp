import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { home, REPO_ROOT } from "./clients/utils.mjs";
import { globalConfigDir } from "./state-dir.mjs";
import { IDENTITY_MARKER_START, IDENTITY_MARKER_END } from "./identity-context.mjs";

import { classifyInstallContext, shouldSkipSelfRepair } from "./install-context.mjs";

const CACHE_ID = "user-midbrain-memory";
const MAX_BYTES = 32_000;
const LEGACY_BLOCK = /^<!-- mb:identity-start -->\n## (?:Agent persona|User profile)\n[^]*\n<!-- mb:identity-end -->$/;

async function directories(paths) {
  const result = [];
  for (const file of paths) {
    const stat = await fs.lstat(file);
    if (!stat.isDirectory()) throw new Error("Not a real directory");
    result.push({ file, stat });
  }
  return result;
}

async function unchanged(dirs) {
  for (const { file, stat } of dirs) {
    const current = await fs.lstat(file);
    if (!current.isDirectory() || current.dev !== stat.dev || current.ino !== stat.ino) return false;
  }
  return true;
}

function ancestors(file) {
  const result = [];
  for (let dir = file; dir !== path.dirname(dir); dir = path.dirname(dir)) {
    result.unshift(dir);
    if (dir === home()) break;
  }
  return result;
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && b.isFile();
}

async function readRegular(file) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.size > MAX_BYTES) return null;
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!sameFile(before, await handle.stat())) return null;
    // Fixed-size read even if the file grows after stat.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== before.size || !sameFile(before, await handle.stat())) return null;
    if (!sameFile(before, await fs.lstat(file))) return null;
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), stat: before };
  } finally { await handle.close(); }
}

/**
 * Retire the draft's unscoped cache workaround; never populate Cursor caches.
 * Only a complete legacy block with matching server metadata is owned. Keep a
 * private backup outside Cursor's cache. Unknown/mixed/new signed files stay.
 */
export async function retireLegacyCursorInstructionCaches({ context = classifyInstallContext(REPO_ROOT) } = {}) {
  if (shouldSkipSelfRepair(context)) return 0;
  const root = path.join(home(), ".cursor", "projects");
  let roots;
  try { roots = await directories([path.dirname(root), root]); } catch { return 0; }
  let retired = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const project = path.join(root, entry.name);
    const mcps = path.join(project, "mcps");
    const dir = path.join(mcps, CACHE_ID);
    try {
      const dirs = [...roots, ...await directories([project, mcps, dir])];
      if (!await unchanged(dirs)) continue;
      const metaFile = await readRegular(path.join(dir, "SERVER_METADATA.json"));
      const meta = metaFile && JSON.parse(metaFile.text);
      if (meta?.serverName !== "midbrain-memory" || meta?.serverIdentifier !== CACHE_ID) continue;
      const file = path.join(dir, "INSTRUCTIONS.md");
      const original = await readRegular(file);
      if (!original || !LEGACY_BLOCK.test(original.text)) continue;
      // Legacy descriptions escaped HTML markers; an inner marker means this
      // is mixed content or a signed block, not a file this migration owns.
      if (original.text.slice(IDENTITY_MARKER_START.length, -IDENTITY_MARKER_END.length).includes("<!--")) continue;
      const backups = path.join(globalConfigDir(), "cursor-identity-backups");
      await fs.mkdir(backups, { recursive: true, mode: 0o700 });
      const backupDirs = await directories(ancestors(backups));
      if (!await unchanged(dirs) || !await unchanged(backupDirs)) continue;
      await fs.writeFile(path.join(backups, `${entry.name}-${randomUUID()}.md`), original.text, { flag: "wx", mode: 0o600 });
      if (!await unchanged(dirs) || !await unchanged(backupDirs)) continue;
      if (!sameFile(original.stat, await fs.lstat(file))) continue;
      await fs.unlink(file);
      retired += 1;
    } catch { /* unreadable, changed or user-owned state is preserved */ }
  }
  return retired;
}
