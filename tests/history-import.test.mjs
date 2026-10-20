/**
 * Issue #75: opt-in import of existing local conversation history.
 * Planning, server-side dedupe, upload and the CLI preview, with a fake
 * client; each client's reader has its own test file.
 */

import { describe, expect, it } from "vitest";

import {
  ACTIVE_SESSION_MS,
  IMPORT_ORIGIN,
  MAX_TEXT_CHARS,
  importId,
  planImport,
  prepareText,
  summarize,
  trimAgainstServer,
  uploadImport,
} from "../shared/history-import/plan.mjs";
import { parseImportArgs, runImportCli } from "../shared/history-import/cli.mjs";

function fakeReaders(sessions) {
  return {
    fake: {
      list: () => sessions.map((_, index) => `file-${index}`),
      read: async (file) => JSON.parse(JSON.stringify(sessions[Number(file.split("-")[1])])),
    },
  };
}

function session(overrides = {}) {
  return {
    client: "fake",
    file: "f",
    sessionId: "s1",
    cwd: "/work/proj",
    skip: null,
    automated: false,
    entries: [
      { role: "user", text: "p1", occurredAt: "2026-09-01T10:00:00.000Z" },
      { role: "assistant", text: "r1", occurredAt: "2026-09-01T10:00:05.000Z" },
      { role: "user", text: "p2", occurredAt: "2026-09-02T10:00:00.000Z" },
      { role: "assistant", text: "r2", occurredAt: "2026-09-02T10:00:05.000Z" },
    ],
    ...overrides,
  };
}

describe("planImport", () => {
  const now = Date.parse("2026-10-13T00:00:00Z");
  const old = () => now - ACTIVE_SESSION_MS - 1;

  it("applies the date range per entry", async () => {
    const [planned] = await planImport({
      readers: fakeReaders([session()]), clients: ["fake"], now, mtimeMs: old,
      since: "2026-09-02T00:00:00.000Z",
    });
    expect(planned.entries.map((entry) => entry.text)).toEqual(["p2", "r2"]);
  });

  it("uses a session's own last-written time when the reader gives one", async () => {
    const planned = await planImport({
      readers: fakeReaders([
        session({ sessionId: "db-active", lastWrittenMs: now - 1000 }),
        session({ sessionId: "db-old", lastWrittenMs: old() }),
      ]),
      clients: ["fake"],
      now,
      mtimeMs: () => { throw new Error("not a file"); },
    });
    expect(planned.map((item) => [item.sessionId, item.skip])).toEqual([
      ["db-active", "active (written in the last 10 minutes)"],
      ["db-old", null],
    ]);
  });

  it("skips active, automated, out-of-project and empty sessions", async () => {
    const planned = await planImport({
      readers: fakeReaders([
        session({ sessionId: "active" }),
        session({ sessionId: "auto", automated: true }),
        session({ sessionId: "elsewhere", cwd: "/other" }),
        session({ sessionId: "inside", cwd: "/work/proj/sub" }),
        session({ sessionId: "old" }),
      ]),
      clients: ["fake"],
      now,
      project: "/work/proj",
      until: "2026-09-01T00:00:00.000Z",
      mtimeMs: (file) => (file === "file-0" ? now - 1000 : old()),
    });
    expect(planned.map((item) => [item.sessionId, item.skip])).toEqual([
      ["active", "active (written in the last 10 minutes)"],
      ["auto", "automated (started by a program, not typed)"],
      ["elsewhere", "outside --project"],
      ["inside", "no turns in range"],
      ["old", "no turns in range"],
    ]);
  });

  it("imports automated sessions when asked", async () => {
    const [planned] = await planImport({
      readers: fakeReaders([session({ automated: true })]), clients: ["fake"], now, mtimeMs: old, includeAutomated: true,
    });
    expect(planned.skip).toBeNull();
  });
});

describe("trimAgainstServer", () => {
  it("keeps only whole turns from before the first live capture", async () => {
    const [trimmed] = await trimAgainstServer([session()], async () => [
      { occurred_at: "2026-09-02T10:00:03", memory_metadata: { client: "fake", session_id: "s1" } },
    ]);
    expect(trimmed.entries.map((entry) => entry.text)).toEqual(["p1", "r1"]);
    expect(trimmed.capturedLive).toBe(2);
  });

  it("drops the reply when its prompt was captured live", async () => {
    const [trimmed] = await trimAgainstServer([session()], async () => [
      { occurred_at: "2026-09-02T10:00:04Z", memory_metadata: {} },
    ]);
    expect(trimmed.entries.map((entry) => entry.text)).toEqual(["p1", "r1"]);
  });

  it("skips entries an earlier import stored and resumes after them", async () => {
    const planned = session();
    const done = planned.entries.slice(0, 3).map((entry) => ({
      occurred_at: "2026-10-13T00:00:00",
      memory_metadata: { origin: IMPORT_ORIGIN, import_id: importId(planned, entry) },
    }));
    const [trimmed] = await trimAgainstServer([planned], async () => done);
    expect(trimmed.entries.map((entry) => entry.text)).toEqual(["r2"]);
    expect(trimmed.alreadyImported).toBe(3);

    const fresh = session();
    const [complete] = await trimAgainstServer([fresh], async () => fresh.entries.map((entry) => ({
      occurred_at: "2026-10-13T00:00:00",
      memory_metadata: { origin: IMPORT_ORIGIN, import_id: importId(fresh, entry) },
    })));
    expect(complete.skip).toBe("already imported");
  });

  it("cuts at a live capture of the same text even when it was stored after the turn", async () => {
    const planned = session({
      entries: [
        { role: "user", text: "first prompt here", occurredAt: "2026-09-01T10:00:00.000Z" },
        { role: "assistant", text: "first reply", occurredAt: "2026-09-01T10:00:05.000Z" },
        { role: "user", text: "Wake up, my friend!", occurredAt: "2026-09-02T10:00:00.000Z" },
        { role: "assistant", text: "Awake and ready to help.", occurredAt: "2026-09-02T10:00:05.000Z" },
      ],
    });
    const [trimmed] = await trimAgainstServer([planned], async () => [
      // Stored 2 s after the prompt, with the client's envelope added.
      { role: "user", text: "[Mon 2026-09-02 12:00 GMT+2] Wake up, my friend!", occurred_at: "2026-09-02T10:00:02" },
    ]);
    expect(trimmed.entries.map((entry) => entry.text)).toEqual(["first prompt here", "first reply"]);
    expect(trimmed.capturedLive).toBe(2);
  });

  it("keeps an earlier turn that repeats a live-captured prompt", async () => {
    const planned = session({
      entries: [
        { role: "user", text: "commit and push the branch", occurredAt: "2026-09-01T10:00:00.000Z" },
        { role: "assistant", text: "Pushed.", occurredAt: "2026-09-01T10:00:05.000Z" },
        { role: "user", text: "run the tests again", occurredAt: "2026-09-01T11:00:00.000Z" },
        { role: "assistant", text: "All pass.", occurredAt: "2026-09-01T11:00:05.000Z" },
      ],
    });
    const [trimmed] = await trimAgainstServer([planned], async () => [
      { role: "user", text: "commit and push the branch", occurred_at: "2026-09-01T14:00:00" },
    ]);
    expect(trimmed.entries).toHaveLength(4);
  });

  it("does not match short or other-role text", async () => {
    const planned = session();
    planned.entries[2].text = "a much longer user prompt text";
    const [trimmed] = await trimAgainstServer([planned], async () => [
      { role: "user", text: "p1", occurred_at: "2026-12-01T00:00:00" },
      { role: "assistant", text: "a much longer user prompt text", occurred_at: "2026-12-01T00:00:00" },
    ]);
    expect(trimmed.entries).toHaveLength(4);
  });

  it("skips a session it cannot check rather than risk duplicates", async () => {
    const [trimmed] = await trimAgainstServer([session()], async () => { throw new Error("API 500"); });
    expect(trimmed.skip).toBe("could not check MidBrain (API 500)");
  });

  it("skips a session live capture fully covered", async () => {
    const [trimmed] = await trimAgainstServer([session()], async () => [{ occurred_at: "2026-08-01T00:00:00", memory_metadata: {} }]);
    expect(trimmed.skip).toBe("already captured live");
  });
});

describe("uploadImport", () => {
  it("posts each entry once with its original time and import labels", async () => {
    const posts = [];
    const totals = await uploadImport({
      sessions: [session({ entries: [{ role: "user", text: "first prompt", occurredAt: "2026-09-01T10:00:00.000Z", cwd: "/work/proj/sub" }] })],
      post: async (_session, entry, metadata) => { posts.push({ entry, metadata }); return "ok"; },
      spacingMs: 0,
      importedAt: "2026-10-13T00:00:00.000Z",
    });
    expect(totals).toMatchObject({ sent: 1, sessions: 1, stopped: null });
    expect(posts[0].entry).toMatchObject({ role: "user", text: "first prompt", occurredAt: "2026-09-01T10:00:00.000Z" });
    expect(posts[0].metadata).toEqual({
      client: "fake",
      cwd: "/work/proj/sub",
      session_id: "s1",
      origin: "import",
      import_id: expect.stringMatching(/^[a-f0-9]{24}$/),
      imported_at: "2026-10-13T00:00:00.000Z",
    });
    expect(posts[0].metadata).not.toHaveProperty("source");
  });

  it("stops at once when the account is out of credits", async () => {
    const results = ["ok", "outOfCredits"];
    let calls = 0;
    const totals = await uploadImport({
      sessions: [session()],
      post: async () => { calls += 1; return results.shift() ?? "ok"; },
      spacingMs: 0,
      wait: async () => {},
    });
    expect(calls).toBe(2);
    expect(totals).toMatchObject({ sent: 1, stopped: "out of MidBrain credits" });
  });

  it.each([
    ["unknown", "an upload failed and may or may not have been stored"],
    ["rateLimited", "rate limited"],
    ["rejected", "MidBrain rejected an entry"],
  ])("posts each entry once and stops on %s, never retrying", async (result, reason) => {
    const results = ["ok", result];
    let calls = 0;
    const totals = await uploadImport({
      sessions: [session()],
      post: async () => { calls += 1; return results.shift() ?? "ok"; },
      spacingMs: 0,
      wait: async () => {},
    });
    expect(calls).toBe(2);
    expect(totals).toMatchObject({ sent: 1, sessions: 0, stopped: reason });
  });

  it("skips and reports an entry the firewall blocks, and keeps going", async () => {
    const results = ["ok", "blocked", "ok", "ok"];
    const totals = await uploadImport({
      sessions: [session()],
      post: async () => results.shift(),
      spacingMs: 0,
      wait: async () => {},
    });
    expect(totals).toMatchObject({ sent: 3, sessions: 1, stopped: null });
    expect(totals.blocked).toEqual([{ client: "fake", sessionId: "s1", role: "assistant", occurredAt: expect.any(String) }]);
  });
});

describe("prepareText", () => {
  it("strips injected MidBrain context and caps length", () => {
    const long = prepareText("x".repeat(MAX_TEXT_CHARS + 10));
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBe(MAX_TEXT_CHARS);
  });
});

describe("summarize", () => {
  it("counts entries and skip reasons per client", () => {
    const summary = summarize([session(), session({ skip: "already imported" })]);
    expect(summary.fake).toMatchObject({ sessions: 1, user: 2, assistant: 2, first: "2026-09-01T10:00:00.000Z", skipped: { "already imported": 1 } });
  });
});

describe("import CLI", () => {
  function capture() {
    let text = "";
    return { write: (chunk) => { text += chunk; return true; }, get text() { return text; } };
  }

  it("parses and validates options", () => {
    const readers = fakeReaders([]);
    expect(parseImportArgs(["--client", "fake", "--since", "2026-09-01", "--apply"], readers)).toMatchObject({
      clients: ["fake"], since: "2026-09-01T00:00:00.000Z", apply: true, yes: false, dream: false,
    });
    expect(parseImportArgs([], readers).clients).toEqual(["fake"]);
    expect(() => parseImportArgs(["--client", "nope"], readers)).toThrow(/unsupported client/);
    expect(() => parseImportArgs(["--since", "yesterday"], readers)).toThrow(/--since/);
  });

  it("accepts --flag=value and rejects unknown arguments, so no filter is dropped", () => {
    expect(parseImportArgs(["--since=2026-09-01", "--client=fake", "--apply"], fakeReaders([]))).toMatchObject({
      clients: ["fake"], since: "2026-09-01T00:00:00.000Z", apply: true,
    });
    expect(() => parseImportArgs(["--sinse", "2026-09-01", "--apply"])).toThrow(/unknown argument: --sinse/);
    expect(() => parseImportArgs(["--since"])).toThrow(/--since requires a value/);
    expect(() => parseImportArgs(["--client=", "--apply"])).toThrow(/--client requires a value/);
  });

  function applyFixture() {
    return fakeReaders([session({ lastWrittenMs: Date.now() - ACTIVE_SESSION_MS * 2 })]);
  }

  it("previews offline without uploading", async () => {
    const err = capture();
    const out = capture();
    const code = await runImportCli(["--client", "fake", "--offline"], { readers: applyFixture(), err, out });
    expect(code).toBe(0);
    expect(err.text).toContain("fake: 1 session(s), 2 prompt(s) + 2 reply(ies) = 4 entries");
    expect(err.text).toContain("Preview only");
    expect(out.text).toBe("");
  });


  function fakeApi(results) {
    const posts = [];
    const api = {
      keyScope: "client",
      effectiveApiBase: "https://example.test",
      keyFingerprint: "k1",
      listEpisodicForSession: async () => [],
      postImportedEpisodic: async (text, role) => { posts.push({ text, role }); return results.shift() ?? "ok"; },
    };
    return { apiFor: async () => api, posts, api };
  }

  it("refuses --apply without a terminal or --yes, and stops when declined", async () => {
    const { apiFor, posts } = fakeApi([]);
    const err = capture();
    expect(await runImportCli(["--client", "fake", "--apply"], { readers: applyFixture(), err, out: capture(), apiFor, isTTY: false })).toBe(2);
    expect(err.text).toContain("needs confirmation");
    const declined = capture();
    expect(await runImportCli(["--client", "fake", "--apply"], {
      readers: applyFixture(), err: declined, out: capture(), apiFor, isTTY: true, confirmFn: async () => false,
    })).toBe(1);
    expect(declined.text).toContain("Nothing was uploaded");
    expect(posts).toEqual([]);
  });

  it("uploads with --yes and reports the credits it needs", async () => {
    const { apiFor, posts } = fakeApi([]);
    const err = capture();
    const code = await runImportCli(["--client", "fake", "--apply", "--yes"], { readers: applyFixture(), err, out: capture(), apiFor, wait: async () => {} });
    expect(code).toBe(0);
    expect(err.text).toContain("this import needs 4 credits");
    expect(err.text).toContain("Imported 4 entries from 1 session(s)");
    expect(posts.map((post) => post.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("stops at once with exit 1 and how to resume when credits run out", async () => {
    const { apiFor, posts } = fakeApi(["ok", "outOfCredits"]);
    const err = capture();
    const code = await runImportCli(["--client", "fake", "--apply", "--yes"], { readers: applyFixture(), err, out: capture(), apiFor, wait: async () => {} });
    expect(code).toBe(1);
    expect(posts).toHaveLength(2);
    expect(err.text).toContain("out of credits");
    expect(err.text).toContain("run the same command again to continue");
  });

  it("retries a rate-limited check, and skips a session it still cannot check", async () => {
    const { apiFor, api } = fakeApi([]);
    const waits = [];
    let calls = 0;
    api.listEpisodicForSession = async () => { calls += 1; throw new Error("API 429 listing session memories"); };
    const err = capture();
    await runImportCli(["--client", "fake"], { readers: applyFixture(), err, out: capture(), apiFor, wait: async (ms) => { waits.push(ms); } });
    expect(calls).toBe(3);
    expect(waits).toEqual([2000, 4000]);
    expect(err.text).toContain("could not check MidBrain (API 429");
  });

  it("stores each turn with its own directory's key and checks every destination", async () => {
    const moved = session({ lastWrittenMs: Date.now() - ACTIVE_SESSION_MS * 2 });
    // The second turn ran after a cd into another project.
    for (const entry of moved.entries.slice(2)) entry.cwd = "/work/other";
    const readers = fakeReaders([moved]);
    const apis = new Map();
    const listed = [];
    const apiFor = async ({ cwd }) => {
      if (!apis.has(cwd)) {
        const posts = [];
        apis.set(cwd, {
          posts,
          keyScope: cwd === "/work/other" ? "project" : "client",
          effectiveApiBase: "https://example.test",
          keyFingerprint: cwd,
          listEpisodicForSession: async (id) => { listed.push([cwd, id]); return []; },
          postImportedEpisodic: async (text, role, metadata) => { posts.push({ role, cwd: metadata.cwd }); return "ok"; },
        });
      }
      return apis.get(cwd);
    };
    const err = capture();
    expect(await runImportCli(["--client", "fake", "--apply", "--yes"], { readers, err, out: capture(), apiFor, wait: async () => {} })).toBe(0);
    expect(listed.map(([cwd]) => cwd).sort()).toEqual(["/work/other", "/work/proj"]);
    expect(apis.get("/work/proj").posts.map((post) => post.cwd)).toEqual(["/work/proj", "/work/proj"]);
    expect(apis.get("/work/other").posts.map((post) => post.cwd)).toEqual(["/work/other", "/work/other"]);
    expect(err.text).toContain("1 session(s) with the client key, 1 session(s) with the project key");
  });

  it("reports entries the firewall blocked", async () => {
    const { apiFor } = fakeApi(["ok", "blocked"]);
    const err = capture();
    expect(await runImportCli(["--client", "fake", "--apply", "--yes"], { readers: applyFixture(), err, out: capture(), apiFor, wait: async () => {} })).toBe(0);
    expect(err.text).toContain("Imported 3 entries");
    expect(err.text).toContain("1 entry was blocked by MidBrain's firewall");
  });

  it("does not retry a check that failed closed", async () => {
    const { apiFor, api } = fakeApi([]);
    let calls = 0;
    api.listEpisodicForSession = async () => { calls += 1; throw new Error("more than 20 pages of memories for one session"); };
    const err = capture();
    await runImportCli(["--client", "fake"], { readers: applyFixture(), err, out: capture(), apiFor, wait: async () => {} });
    expect(calls).toBe(1);
    expect(err.text).toContain("could not check MidBrain (more than 20 pages");
  });

  it("refuses --apply with --offline", async () => {
    const err = capture();
    expect(await runImportCli(["--apply", "--offline"], { err, out: capture() })).toBe(2);
    expect(err.text).toContain("drop --offline");
  });
});
