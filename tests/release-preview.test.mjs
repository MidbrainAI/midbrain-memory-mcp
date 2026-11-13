import { describe, expect, it } from "vitest";
import { selectBaseline, previewCommits } from "../scripts/release-preview.mjs";

describe("release preview baseline", () => {
  it("uses the manual baseline and ignores historical v1.1.0", () => {
    expect(selectBaseline(["v1.1.0", "v0.4.10"])).toEqual({ tag: "v0.4.10", version: "0.4.10" });
  });
  it("chooses the highest automated version numerically", () => {
    expect(selectBaseline(["v1.1.0", "npm-v0.4.9", "npm-v0.4.10", "npm-v0.5.0-beta.1"]))
      .toEqual({ tag: "npm-v0.4.10", version: "0.4.10" });
  });
  it("fails when the bootstrap tag is unavailable", () => {
    expect(() => selectBaseline(["v1.1.0"])).toThrow(/fetch/);
  });
});

describe("release preview uses the release commit analyzer", () => {
  const baseline = { tag: "v0.4.10", version: "0.4.10" };
  it.each([
    ["fix: repair a hook", "patch", "0.4.11"],
    ["perf: reduce latency", "patch", "0.4.11"],
    ["feat: add a client", "minor", "0.5.0"],
    ["feat: replace configuration\n\nBREAKING CHANGE: remove old config", "major", "1.0.0"],
    ["docs: explain setup", null, null],
    ["feat: excluded change [skip release]", null, null],
    ["feat: excluded change [release skip]", null, null],
  ])("analyzes %s", async (message, type, version) => {
    expect(await previewCommits(baseline, [{ message }])).toMatchObject({ type, version });
  });
  it("takes the largest bump and reports no release for an empty range", async () => {
    expect(await previewCommits(baseline, [{ message: "fix: repair" }, { message: "feat: add" }]))
      .toMatchObject({ type: "minor", version: "0.5.0" });
    expect(await previewCommits(baseline, [])).toMatchObject({ type: null, version: null });
  });
});
