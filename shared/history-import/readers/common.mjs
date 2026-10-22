/** Helpers shared by the history readers (issue #75). */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";

import { openTranscript } from "../../claude-transcript.mjs";

/** A missing directory is no history; any other failure must be reported. */
function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
    throw error;
  }
}

/** Regular files (no symlinks) directly inside `dir` matching `test`. */
export function regularFiles(dir, test) {
  return readDir(dir)
    .filter((entry) => entry.isFile() && test(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

/** Directories (no symlinks) directly inside `dir`. */
export function subdirectories(dir) {
  return readDir(dir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

/** Yielded in place of a corrupt line in the middle of a file. */
export const CORRUPT_ROW = Object.freeze({ type: "corrupt" });

/**
 * The rows of a JSONL file inside `root`, opened only as a regular file
 * reached without symlinks (a file swapped for a link after listing is
 * refused). A corrupt line yields CORRUPT_ROW, so a reader can end the turn
 * it was building instead of pairing the next reply with the wrong prompt;
 * a torn last line (a write cut short) is skipped. A `.zst` file is
 * decompressed; a runtime without zstd (Node before 22.15) throws, so the
 * file is reported as unreadable instead of being left out.
 */
export async function* jsonRows(file, root) {
  const source = openTranscript(file, root);
  if (!source) throw Object.assign(new Error(`not a regular file inside ${root}`), { code: "EUNSAFE", path: file });
  const stream = fs.createReadStream(file, { fd: source.fd });
  let input = stream;
  if (file.endsWith(".zst")) {
    if (typeof zlib.createZstdDecompress !== "function") {
      stream.destroy();
      throw Object.assign(new Error("reading a .zst file needs Node 22.15 or later"), { code: "ENOZSTD", path: file });
    }
    input = stream.pipe(zlib.createZstdDecompress());
    stream.on("error", (error) => input.destroy(error));
  }
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    let corrupt = false;
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row = null;
      try {
        row = JSON.parse(line);
      } catch { /* checked below */ }
      if (corrupt) yield CORRUPT_ROW;
      corrupt = !row || typeof row !== "object";
      if (!corrupt) yield row;
    }
  } finally {
    lines.close();
    input.destroy();
    stream.destroy();
  }
}

export function validTimestamp(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}
