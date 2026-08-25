/**
 * Unit tests for shared/flush-runner.mjs — the disciplined drain shared by the
 * #52 spool flush and the #53 offline-cache drain.
 */

import { describe, it, expect, vi } from "vitest";
import { runFlush } from "../shared/flush-runner.mjs";

/** A fake flush source backed by an in-memory array. */
function makeSource(entries, { cooldownUntil = 0 } = {}) {
  const state = { entries: [...entries], cooldownUntil, cleared: false, finished: null };
  return {
    state,
    begin() {
      if (state.entries.length === 0) return { claimed: false, entries: [] };
      const claimed = { claimed: true, entries: [...state.entries] };
      state.entries = []; // handoff to processing
      return claimed;
    },
    finish(_flush, survivors) {
      state.finished = survivors;
      state.entries = [...survivors];
    },
    readCooldownUntil() { return state.cooldownUntil; },
    writeCooldownUntil(until) { state.cooldownUntil = until; },
    clearCooldown() { state.cleared = true; state.cooldownUntil = 0; },
  };
}

const okPost = async () => "ok";

describe("runFlush", () => {
  it("drains all entries on success and clears cooldown", async () => {
    const source = makeSource([{ text: "a" }, { text: "b" }]);
    const summary = await runFlush({ source, post: okPost });

    expect(summary).toMatchObject({ sent: 2, survivors: 0, rateLimited: false, claimed: true });
    expect(source.state.entries).toEqual([]);
    expect(source.state.cleared).toBe(true);
  });

  it("no-op when nothing is claimed", async () => {
    const source = makeSource([]);
    const post = vi.fn(okPost);
    const summary = await runFlush({ source, post });

    expect(summary.claimed).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("defers entirely when a cooldown is active (no POSTs)", async () => {
    const source = makeSource([{ text: "a" }], { cooldownUntil: Date.now() + 60_000 });
    const post = vi.fn(okPost);
    const summary = await runFlush({ source, post });

    expect(summary.claimed).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(source.state.entries).toEqual([{ text: "a" }]); // preserved
  });

  it("stops the pass on a rate-limit, preserves the rest, and sets a cooldown", async () => {
    const source = makeSource([{ text: "a" }, { text: "b" }, { text: "c" }]);
    let calls = 0;
    const post = vi.fn(async () => { calls += 1; return calls === 1 ? "ok" : "rateLimited"; });

    const summary = await runFlush({ source, post, cooldownMs: 300_000 });

    // a=ok, b=rateLimited stops the pass; c never attempted.
    expect(post).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ sent: 1, rateLimited: true });
    // b and c preserved (never dropped).
    expect(source.state.entries.map((e) => e.text)).toEqual(["b", "c"]);
    expect(source.state.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("preserves ordinary failures as survivors (retry next run), single pass", async () => {
    const source = makeSource([{ text: "a" }, { text: "b" }]);
    const post = vi.fn(async (e) => (e.text === "a" ? "ok" : "failed"));

    const summary = await runFlush({ source, post });

    expect(post).toHaveBeenCalledTimes(2); // single pass, both attempted
    expect(summary).toMatchObject({ sent: 1, survivors: 1, rateLimited: false });
    expect(source.state.entries.map((e) => e.text)).toEqual(["b"]);
  });

  it("applies inter-POST spacing between successful posts", async () => {
    const source = makeSource([{ text: "a" }, { text: "b" }]);
    const sleeps = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms) => { sleeps.push(ms); fn(); return 0; });
    try {
      await runFlush({ source, post: okPost, spacingMs: 150 });
    } finally {
      globalThis.setTimeout.mockRestore();
    }
    // Spacing applied once (between the two entries, not after the last).
    expect(sleeps).toEqual([150]);
  });

  it("applies inter-POST spacing after ordinary failed attempts", async () => {
    const source = makeSource([{ text: "a" }, { text: "b" }, { text: "c" }]);
    const sleeps = [];
    const post = vi.fn(async () => "failed");
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms) => { sleeps.push(ms); fn(); return 0; });
    try {
      await runFlush({ source, post, spacingMs: 150 });
    } finally {
      globalThis.setTimeout.mockRestore();
    }

    expect(post).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([150, 150]);
  });

  it("limits one pass without losing the unattempted tail", async () => {
    const source = makeSource([{ text: "a" }, { text: "b" }, { text: "c" }]);
    const post = vi.fn(okPost);

    const summary = await runFlush({ source, post, maxEntries: 2 });

    expect(post).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ sent: 2, survivors: 1, rateLimited: false, claimed: true });
    expect(source.state.entries.map((entry) => entry.text)).toEqual(["c"]);
  });

  it("never throws when the source misbehaves", async () => {
    const badSource = {
      begin() { throw new Error("boom"); },
      finish() {},
      readCooldownUntil() { return 0; },
      writeCooldownUntil() {},
      clearCooldown() {},
    };
    await expect(runFlush({ source: badSource, post: okPost })).resolves.toMatchObject({ sent: 0 });
  });
});
