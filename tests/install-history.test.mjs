import { describe, it, expect, vi } from "vitest";
import { offerHistoryImport } from "../shared/history-import/install.mjs";

const clients = [{ id: "codex", displayName: "Codex" }, { id: "claude", displayName: "Claude Code" }, { id: "nanoclaw", displayName: "NanoClaw" }];
function deps(extra = {}) {
  return { isTTY: true, ask: vi.fn().mockResolvedValue("y"), runImport: vi.fn().mockResolvedValue(0), err: { write: vi.fn() }, ...extra };
}
describe("installation history offer", () => {
  it("collects supported client choices into one ordered import and retains confirmation", async () => {
    const options = deps();
    await offerHistoryImport(clients, options);
    expect(options.ask).toHaveBeenCalledTimes(2);
    expect(options.ask.mock.calls[0][0]).toContain("Codex");
    expect(options.runImport.mock.calls.map(([args]) => args)).toEqual([["--client", "codex,claude", "--apply"]]);
  });
  it.each([{ nonInteractive: true }, { isTTY: false }])("does not prompt or import unattended: %j", async (extra) => {
    const options = deps(extra);
    await offerHistoryImport(clients, options);
    expect(options.ask).not.toHaveBeenCalled();
    expect(options.runImport).not.toHaveBeenCalled();
  });
  it.each(["", "n", "no"])("declining (%s) never uploads", async (answer) => {
    const options = deps({ ask: vi.fn().mockResolvedValue(answer) });
    await offerHistoryImport(clients, options);
    expect(options.runImport).not.toHaveBeenCalled();
  });
  it("does not fail installation when the combined import fails", async () => {
    const options = deps({ runImport: vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(1) });
    await offerHistoryImport(clients, options);
    expect(options.runImport).toHaveBeenCalledTimes(1);
    expect(options.err.write).toHaveBeenCalledWith(expect.stringContaining("offline"));
  });
});
