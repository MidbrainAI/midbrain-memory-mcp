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

  it("reports history it cannot list instead of showing none", async () => {
    const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES", path: "/home/me/.fake" });
    const [row] = await planImport({ readers: { fake: { list: () => { throw denied; }, read: async () => null } }, clients: ["fake"], now });
    expect(row).toMatchObject({ client: "fake", entries: [], skip: "could not list history (EACCES: /home/me/.fake)" });
  });

  it("skips active, automated and empty sessions", async () => {
    const planned = await planImport({
      readers: fakeReaders([
        session({ sessionId: "active" }),
        session({ sessionId: "auto", automated: true }),
        session({ sessionId: "old" }),
      ]),
      clients: ["fake"],
      now,
      since: "2026-10-01T00:00:00.000Z",
      mtimeMs: (file) => (file === "file-0" ? now - 1000 : old()),
    });
    expect(planned.map((item) => [item.sessionId, item.skip])).toEqual([
      ["active", "active (written in the last 10 minutes)"],
      ["auto", "automated (started by a program, not typed)"],
      ["old", "no turns in range"],
    ]);
  });
});

describe("trimAgainstServer", () => {
  // Every entry goes to one destination that holds `existing`.
  const oneDestination = (existing) => async (planned) => [{ entries: planned.entries, existing }];

  it("keeps only whole turns from before the first live capture", async () => {
    const [trimmed] = await trimAgainstServer([session()], oneDestination([
      { occurred_at: "2026-09-02T10:00:03", memory_metadata: { client: "fake", session_id: "s1" } },
    ]));
    expect(trimmed.entries.map((entry) => entry.text)).toEqual(["p1", "r1"]);
    expect(trimmed.capturedLive).toBe(2);
  });

  it("drops the reply when its prompt was captured live", async () => {
    const [trimmed] = await trimAgainstServer([session()], oneDestination([
      { occurred_at: "2026-09-02T10:00:04Z", memory_metadata: {} },
    ]));
    expect(trimmed.entries.map((entry) => entry.text)).toEqual(["p1", "r1"]);
  });

  it("skips entries an earlier import stored and resumes after them", async () => {
    const planned = session();
    const done = planned.entries.slice(0, 3).map((entry) => ({
      occurred_at: "2026-10-13T00:00:00",
      memory_metadata: { origin: IMPORT_ORIGIN, import_id: importId(planned, entry) },
    }));
    const [trimmed] = await trimAgainstServer([planned], oneDestination(done));
    expect(trimmed.entries.map((entry) => entry.text)).toEqual(["r2"]);
    expect(trimmed.alreadyImported).toBe(3);

    const fresh = session();
    const [complete] = await trimAgainstServer([fresh], oneDestination(fresh.entries.map((entry) => ({
      occurred_at: "2026-10-13T00:00:00",
      memory_metadata: { origin: IMPORT_ORIGIN, import_id: importId(fresh, entry) },
    }))));
    expect(complete.skip).toBe("already imported");
  });

  it("leaves out a turn live capture stored a few minutes after it happened", async () => {
    const [trimmed] = await trimAgainstServer([session()], oneDestination([
      // The second prompt, stored 4 minutes after it was typed.
      { role: "user", occurred_at: "2026-09-02T10:04:00", memory_metadata: {} },
    ]));
    expect(trimmed.entries.map((entry) => entry.text)).toEqual(["p1", "r1"]);
    expect(trimmed.capturedLive).toBe(2);
  });

  it("keeps turns from before the capture window", async () => {
    const [trimmed] = await trimAgainstServer([session()], oneDestination([
      { role: "user", occurred_at: "2026-09-02T14:00:00", memory_metadata: {} },
    ]));
    expect(trimmed.entries).toHaveLength(4);
  });

  it("skips a session it cannot check rather than risk duplicates", async () => {
    const [trimmed] = await trimAgainstServer([session()], async () => { throw new Error("API 500"); });
    expect(trimmed.skip).toBe("could not check MidBrain (API 500)");
  });

  it("skips a session live capture fully covered", async () => {
    const [trimmed] = await trimAgainstServer([session()], oneDestination([{ occurred_at: "2026-08-01T00:00:00", memory_metadata: {} }]));
    expect(trimmed.skip).toBe("already captured live");
  });

  it("checks each entry only against its own destination", async () => {
    const [trimmed] = await trimAgainstServer([session()], async (planned) => [
      // Live capture in the first project, after its turn.
      { entries: planned.entries.slice(0, 2), existing: [{ occurred_at: "2026-09-01T10:00:06", memory_metadata: {} }] },
      // Nothing captured in the second project.
      { entries: planned.entries.slice(2), existing: [] },
    ]);
    expect(trimmed.entries.map((entry) => entry.text)).toEqual(["p2", "r2"]);
    expect(trimmed.capturedLive).toBe(2);
  });

  it("skips a session with an entry no destination was checked for", async () => {
    const [trimmed] = await trimAgainstServer([session()], async (planned) => [{ entries: planned.entries.slice(1), existing: [] }]);
    expect(trimmed.skip).toBe("could not check MidBrain (an entry has no destination)");
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
    expect(totals).toMatchObject({ sent: 1, stopped: "out of MidBrain credits", stoppedOn: "outOfCredits" });
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
    // A repeated name would plan its sessions twice and upload them twice.
    expect(parseImportArgs(["--client", "fake, fake,fake"], readers).clients).toEqual(["fake"]);
    expect(() => parseImportArgs(["--client", "nope"], readers)).toThrow(/unsupported client/);
    expect(() => parseImportArgs(["--since", "yesterday"], readers)).toThrow(/--since/);
  });

  it("accepts --flag=value and rejects unknown arguments, so no filter is dropped", () => {
    expect(parseImportArgs(["--since=2026-09-01", "--client=fake", "--apply"], fakeReaders([]))).toMatchObject({
      clients: ["fake"], since: "2026-09-01T00:00:00.000Z", apply: true,
    });
    expect(() => parseImportArgs(["--sinse", "2026-09-01", "--apply"])).toThrow(/Unknown option '--sinse'/);
    expect(() => parseImportArgs(["--since"])).toThrow(/--since <value>' argument missing/);
    expect(() => parseImportArgs(["--since", "--apply"])).toThrow(/ambiguous/);
    expect(() => parseImportArgs(["--client=", "--apply"])).toThrow(/--client requires a value/);
  });

  function applyFixture() {
    return fakeReaders([session({ lastWrittenMs: Date.now() - ACTIVE_SESSION_MS * 2 })]);
  }

  function fakeApi(results) {
    const posts = [];
    const api = {
      effectiveApiBase: "https://example.test",
      keyFingerprint: "k1",
      listEpisodicForSession: async () => [],
      postImportedEpisodic: async (text, role) => { posts.push({ text, role }); return results.shift() ?? "ok"; },
    };
    return { apiFor: async () => api, posts, api };
  }

  it("previews without uploading", async () => {
    const { apiFor, posts } = fakeApi([]);
    const err = capture();
    expect(await runImportCli(["--client", "fake"], { readers: applyFixture(), err, apiFor })).toBe(0);
    expect(err.text).toContain("fake: 1 session(s), 2 prompt(s) + 2 reply(ies) = 4 entries");
    expect(err.text).toContain("Preview only");
    expect(posts).toEqual([]);
  });

  it("refuses --apply without a terminal or --yes, and stops when declined", async () => {
    const { apiFor, posts } = fakeApi([]);
    const err = capture();
    expect(await runImportCli(["--client", "fake", "--apply"], { readers: applyFixture(), err, apiFor, isTTY: false })).toBe(2);
    expect(err.text).toContain("needs confirmation");
    const declined = capture();
    expect(await runImportCli(["--client", "fake", "--apply"], {
      readers: applyFixture(), err: declined, apiFor, isTTY: true, confirmFn: async () => false,
    })).toBe(1);
    expect(declined.text).toContain("Nothing was uploaded");
    expect(posts).toEqual([]);
  });

  it("uploads with --yes and reports the credits it needs", async () => {
    const { apiFor, posts } = fakeApi([]);
    const err = capture();
    const code = await runImportCli(["--client", "fake", "--apply", "--yes"], { readers: applyFixture(), err, apiFor, wait: async () => {} });
    expect(code).toBe(0);
    expect(err.text).toContain("this import needs 4 credits");
    expect(err.text).toContain("Imported 4 entries from 1 session(s)");
    expect(posts.map((post) => post.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("stops at once with exit 1 and how to resume when credits run out", async () => {
    const { apiFor, posts } = fakeApi(["ok", "outOfCredits"]);
    const err = capture();
    const code = await runImportCli(["--client", "fake", "--apply", "--yes"], { readers: applyFixture(), err, apiFor, wait: async () => {} });
    expect(code).toBe(1);
    expect(posts).toHaveLength(2);
    expect(err.text).toContain("Stopped early: out of MidBrain credits, after storing 1 of 4 entries.");
    expect(err.text).toContain("Add credits, then run the same command again to continue");
  });

  it("asks to wait before resuming after a rate limit", async () => {
    const { apiFor } = fakeApi(["ok", "ok", "rateLimited"]);
    const err = capture();
    expect(await runImportCli(["--client", "fake", "--apply", "--yes"], { readers: applyFixture(), err, apiFor, wait: async () => {} })).toBe(1);
    expect(err.text).toContain("Stopped early: rate limited, after storing 2 of 4 entries.");
    expect(err.text).toContain("Wait a few minutes, then run the same command again to continue");
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
          effectiveApiBase: "https://example.test",
          keyFingerprint: cwd,
          listEpisodicForSession: async (id) => { listed.push([cwd, id]); return []; },
          postImportedEpisodic: async (text, role, metadata) => { posts.push({ role, cwd: metadata.cwd }); return "ok"; },
        });
      }
      return apis.get(cwd);
    };
    const err = capture();
    expect(await runImportCli(["--client", "fake", "--apply", "--yes"], { readers, err, apiFor, wait: async () => {} })).toBe(0);
    expect(listed.map(([cwd]) => cwd).sort()).toEqual(["/work/other", "/work/proj"]);
    expect(apis.get("/work/proj").posts.map((post) => post.cwd)).toEqual(["/work/proj", "/work/proj"]);
    expect(apis.get("/work/other").posts.map((post) => post.cwd)).toEqual(["/work/other", "/work/other"]);
  });

  it("uploads each session once when a client is named twice", async () => {
    const { apiFor, posts } = fakeApi([]);
    const err = capture();
    expect(await runImportCli(["--client", "fake,fake", "--apply", "--yes"], { readers: applyFixture(), err, apiFor, wait: async () => {} })).toBe(0);
    expect(posts).toHaveLength(4);
  });

  it("imports a project's turns even when another project of the session was captured live", async () => {
    const moved = session({ lastWrittenMs: Date.now() - ACTIVE_SESSION_MS * 2 });
    for (const entry of moved.entries.slice(2)) entry.cwd = "/work/other";
    const posts = [];
    const apiFor = async ({ cwd }) => ({
      effectiveApiBase: "https://example.test",
      keyFingerprint: cwd,
      // Live capture ran in the first project only, after its turn.
      listEpisodicForSession: async () => (cwd === "/work/proj" ? [{ occurred_at: "2026-09-01T10:00:06", memory_metadata: {} }] : []),
      postImportedEpisodic: async (text) => { posts.push(text); return "ok"; },
    });
    const err = capture();
    expect(await runImportCli(["--client", "fake", "--apply", "--yes"], { readers: fakeReaders([moved]), err, apiFor, wait: async () => {} })).toBe(0);
    expect(posts).toEqual(["p2", "r2"]);
  });

  it("reports entries the firewall blocked", async () => {
    const { apiFor } = fakeApi(["ok", "blocked"]);
    const err = capture();
    expect(await runImportCli(["--client", "fake", "--apply", "--yes"], { readers: applyFixture(), err, apiFor, wait: async () => {} })).toBe(0);
    expect(err.text).toContain("Imported 3 entries");
    expect(err.text).toContain("1 entry was blocked by MidBrain's firewall");
  });

  it("skips a session it cannot check, without retrying", async () => {
    const { apiFor, api } = fakeApi([]);
    let calls = 0;
    api.listEpisodicForSession = async () => { calls += 1; throw new Error("API 429 listing session memories"); };
    const err = capture();
    await runImportCli(["--client", "fake"], { readers: applyFixture(), err, apiFor });
    expect(calls).toBe(1);
    expect(err.text).toContain("skipped 1 session(s): could not check MidBrain (API 429");
  });
});
