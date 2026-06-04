/**
 * Shared fs mock helpers for client adapter and installer tests.
 *
 * USAGE in a test file:
 *
 *   import { enoent, makeResetMocks, makeExistsFor, makeReadFileReturns }
 *     from "./fs-mock.mjs";
 *
 *   // 1. Declare mocks with vi.hoisted() so they're available to vi.mock() factories
 *   const mocks = vi.hoisted(() => ({
 *     readFile:   vi.fn(),
 *     writeFile:  vi.fn().mockResolvedValue(undefined),
 *     mkdir:      vi.fn().mockResolvedValue(undefined),
 *     chmod:      vi.fn().mockResolvedValue(undefined),
 *     stat:       vi.fn(),
 *     realpath:   vi.fn(),
 *     copyFile:   vi.fn().mockResolvedValue(undefined),
 *     existsSync: vi.fn(() => false),
 *   }));
 *
 *   // 2. Wire mocks into modules under test
 *   vi.mock("fs/promises", () => ({
 *     default: { readFile: mocks.readFile, writeFile: mocks.writeFile,
 *                mkdir: mocks.mkdir, chmod: mocks.chmod,
 *                stat: mocks.stat, realpath: mocks.realpath, copyFile: mocks.copyFile },
 *     readFile: mocks.readFile, writeFile: mocks.writeFile,
 *     mkdir: mocks.mkdir, chmod: mocks.chmod,
 *   }));
 *   vi.mock("fs", async (importOriginal) => {
 *     const orig = await importOriginal();
 *     return { ...orig, existsSync: mocks.existsSync, realpathSync: orig.realpathSync };
 *   });
 *
 *   // 3. Bind helpers to the mocks
 *   const resetMocks     = makeResetMocks(mocks);
 *   const existsFor      = makeExistsFor(mocks);
 *   const readFileReturns = makeReadFileReturns(mocks);
 */

import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Stateless helpers
// ---------------------------------------------------------------------------

/** Builds an ENOENT error for a given path. */
export function enoent(filePath) {
  const err = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
  err.code = "ENOENT";
  return err;
}

// ---------------------------------------------------------------------------
// Helper factories — call with your local mocks object
// ---------------------------------------------------------------------------

/** Returns a resetMocks() function bound to the given mocks. */
export function makeResetMocks(mocks) {
  return function resetMocks() {
    vi.clearAllMocks();
    mocks.readFile.mockRejectedValue(enoent("default"));
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.chmod.mockResolvedValue(undefined);
    mocks.copyFile.mockResolvedValue(undefined);
    mocks.stat.mockRejectedValue(enoent("default"));
    mocks.realpath.mockImplementation(async (p) => p);
    mocks.existsSync.mockReturnValue(false);
  };
}

/** Returns an existsFor() function bound to the given mocks. */
export function makeExistsFor(mocks) {
  return function existsFor(...paths) {
    mocks.existsSync.mockImplementation((p) => paths.includes(p));
  };
}

/** Returns a readFileReturns() function bound to the given mocks. */
export function makeReadFileReturns(mocks) {
  return function readFileReturns(mapping) {
    mocks.readFile.mockImplementation(async (filePath) => {
      if (mapping[filePath] !== undefined) return mapping[filePath];
      throw enoent(filePath);
    });
  };
}
