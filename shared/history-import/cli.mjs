/**
 * `npx midbrain-memory-mcp@latest import`: opt-in import of existing local conversation
 * history into MidBrain episodic memory (issue #75).
 *
 * Preview by default. Nothing is uploaded without `--apply` and a
 * confirmation (or `--yes`). Output goes to stderr, like the installer;
 * `--json` prints the plan to stdout instead.
 */

import readline from "node:readline";

import { allClients } from "../clients/registry.mjs";
import { MidbrainApi } from "../midbrain-api.mjs";
import { READERS } from "./readers/index.mjs";
import { planImport, summarize, trimAgainstServer, uploadImport } from "./plan.mjs";

const HELP = `Usage: npx midbrain-memory-mcp@latest import [options]

Import conversations from before MidBrain was installed. Shows a preview
unless --apply is given; asks before uploading.

Options:
  --client <list>   Clients to read: ${Object.keys(READERS).join(", ")} (default: all)
  --since <date>    Only turns on or after this date (YYYY-MM-DD)
  --until <date>    Only turns before this date (YYYY-MM-DD)
  --project <dir>   Only sessions started in this directory or below it
  --include-automated
                    Also import sessions a program started (Agent SDK,
                    headless and exec runs), where no prompt was typed
  --apply           Upload after showing the preview
  --yes             With --apply: do not ask for confirmation
  --dream           Let MidBrain run its per-memory processing on imported
                    turns (off by default, as for any bulk load)
  --offline         Preview without asking MidBrain what it already has
  --json            Print the plan as JSON on stdout
  -h, --help        Show this help

What is imported: your prompts and the reply that ended each turn, with
their original time, labeled origin=import. Tool calls and output, injected
context, subagent threads, sessions a program started, sessions active in the last 10 minutes, and turns
MidBrain already captured live are left out. Recognised secrets (API keys,
tokens, private keys, password=... values) are replaced with [redacted].
Each session is stored with the key that live capture would use for its
directory, so project keys apply.`;

const VALUE_FLAGS = new Set(["--client", "--since", "--until", "--project"]);
const BOOLEAN_FLAGS = new Set(["--help", "-h", "--include-automated", "--apply", "--yes", "--dream", "--offline", "--json"]);

/**
 * Split `--flag=value` and reject anything unknown, so a typo or an
 * unsupported form never drops a filter and widens the import.
 */
function normalizeArgs(argv) {
  const args = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.has(flag)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[i + 1];
      if (!value || String(value).startsWith("--")) throw new Error(`${flag} requires a value`);
      args.push(flag, String(value));
      if (eq < 0) i += 1;
    } else if (BOOLEAN_FLAGS.has(arg)) {
      args.push(arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1];
}

function isoDate(value, flag) {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${flag} must be a date like 2026-09-01`);
  }
  return new Date(`${value}T00:00:00Z`).toISOString();
}

export function parseImportArgs(rawArgv) {
  const argv = normalizeArgs(rawArgv);
  const clientList = flagValue(argv, "--client");
  const clients = clientList ? clientList.split(",").map((name) => name.trim()).filter(Boolean) : Object.keys(READERS);
  const unknown = clients.filter((name) => !READERS[name]);
  if (unknown.length) throw new Error(`unsupported client: ${unknown.join(", ")} (supported: ${Object.keys(READERS).join(", ")})`);
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    clients,
    since: isoDate(flagValue(argv, "--since"), "--since"),
    until: isoDate(flagValue(argv, "--until"), "--until"),
    project: flagValue(argv, "--project"),
    includeAutomated: argv.includes("--include-automated"),
    apply: argv.includes("--apply"),
    yes: argv.includes("--yes"),
    dream: argv.includes("--dream"),
    offline: argv.includes("--offline"),
    json: argv.includes("--json"),
  };
}

function formatPreview(summary, { offline }) {
  const lines = [];
  for (const [client, row] of Object.entries(summary)) {
    const entries = row.user + row.assistant;
    lines.push(`${client}: ${row.sessions} session(s), ${row.user} prompt(s) + ${row.assistant} reply(ies) = ${entries} entr${entries === 1 ? "y" : "ies"}, ~${Math.round(row.chars / 1000)}k characters`);
    if (row.first) lines.push(`  from ${row.first.slice(0, 10)} to ${row.last.slice(0, 10)}`);
    for (const [reason, count] of Object.entries(row.skipped)) lines.push(`  skipped ${count} session(s): ${reason}`);
  }
  if (lines.length === 0) lines.push("No history found for the selected clients.");
  if (offline) lines.push("(--offline: turns MidBrain already has were not checked and may be counted.)");
  return lines.join("\n");
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

const NO_PROJECT_KEY_WARNING = /^WARN: no project key found in /;

/**
 * Key resolution warns once per directory without a project key. Across a
 * whole history that is one line per old project, so the preview reports the
 * key scope per session instead and these lines are held back.
 */
async function quietly(resolve) {
  const original = console.error;
  console.error = (...args) => {
    if (typeof args[0] === "string" && NO_PROJECT_KEY_WARNING.test(args[0])) return;
    original(...args);
  };
  try {
    return await resolve();
  } finally {
    console.error = original;
  }
}

/**
 * One MidbrainApi per (client, directory): the key and host live capture
 * would use there. Each entry is resolved from its own directory, so a
 * session that moved between projects stores each turn where live capture
 * would have.
 */
function apiResolver() {
  const adapters = Object.fromEntries(allClients().map((client) => [client.id, client]));
  const cache = new Map();
  return ({ client, cwd }) => {
    const cacheKey = `${client}\0${cwd ?? ""}`;
    if (!cache.has(cacheKey)) {
      const adapter = adapters[client];
      cache.set(cacheKey, adapter
        ? quietly(() => MidbrainApi.create(adapter, cwd ?? undefined, { clientLabel: client }))
        : Promise.reject(new Error(`no adapter for ${client}`)));
    }
    return cache.get(cacheKey);
  };
}

/** The directory an entry is stored from: its own, else its session's. */
const entryCwd = (session, entry) => entry.cwd || session.cwd || null;

/** Every distinct destination (host and key) a session's entries go to. */
async function sessionDestinations(session, apiFor) {
  const cwds = new Set(session.entries.map((entry) => entryCwd(session, entry)));
  if (cwds.size === 0) cwds.add(session.cwd ?? null);
  const destinations = new Map();
  for (const cwd of cwds) {
    const api = await apiFor({ client: session.client, cwd });
    destinations.set(`${api.effectiveApiBase}\0${api.keyFingerprint}`, api);
  }
  return [...destinations.values()];
}

function formatKeyScopes(sessions) {
  const counts = {};
  for (const session of sessions) {
    if (session.skip) continue;
    for (const scope of session.keyScopes ?? []) counts[scope] = (counts[scope] || 0) + 1;
  }
  const parts = Object.entries(counts).map(([scope, count]) => `${count} session(s) with the ${scope} key`);
  return parts.length ? `Keys: ${parts.join(", ")}.` : "";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One session's check, retried twice on a rate limit, a server error or a
 * dropped connection; any other error (or a third failure) is thrown, and
 * the planner skips that session rather than risk duplicates.
 */
async function withRetry(fn, wait) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const status = /\bAPI (\d{3})\b/.exec(error?.message ?? "")?.[1];
      // A dropped connection (fetch throws a TypeError) or a transient status;
      // a fail-closed check (too many pages, an unexpected shape) is final.
      const transient = status ? status === "429" || status === "403" || status.startsWith("5") : error instanceof TypeError;
      if (!transient || attempt >= 2) throw error;
      await wait(2_000 * 2 ** attempt);
    }
  }
}

export async function runImportCli(argv, {
  readers = READERS,
  out = process.stdout,
  err = process.stderr,
  isTTY = process.stdin.isTTY,
  apiFor = apiResolver(),
  wait = sleep,
  confirmFn = confirm,
} = {}) {
  let options;
  try {
    options = parseImportArgs(argv);
  } catch (error) {
    err.write(`Error: ${error.message}\n\n${HELP}\n`);
    return 2;
  }
  if (options.help) {
    err.write(`${HELP}\n`);
    return 0;
  }
  if (options.apply && options.offline) {
    err.write("Error: --apply needs the MidBrain check; drop --offline.\n");
    return 2;
  }

  err.write("Reading local history (nothing is uploaded yet)...\n");
  const sessions = await planImport({ ...options, readers });
  if (!options.offline) {
    err.write("Checking which sessions MidBrain already has (sends session ids only)...\n");
    await trimAgainstServer(sessions, async (session) => {
      // Check every destination the session's entries go to: what each one
      // already holds is skipped. Live capture may have stored the
      // conversation under a linked id too (e.g. the Claude Code session an
      // OpenClaw session ran on).
      const destinations = await sessionDestinations(session, apiFor);
      session.keyScopes = [...new Set(destinations.map((api) => api.keyScope).filter(Boolean))];
      const ids = [session.sessionId, ...(session.linkedSessionIds ?? [])];
      const lists = await Promise.all(destinations.flatMap((api) => ids.map((id) => withRetry(() => api.listEpisodicForSession(id), wait))));
      return lists.flat();
    });
  }
  const summary = summarize(sessions);

  if (options.json) {
    out.write(`${JSON.stringify({ summary, sessions: sessions.map(({ entries, ...rest }) => ({ ...rest, entries: entries.length })) }, null, 2)}\n`);
  } else {
    const keys = formatKeyScopes(sessions);
    err.write(`\n${formatPreview(summary, options)}\n${keys ? `${keys}\n` : ""}\n`);
  }

  const pending = sessions.filter((session) => !session.skip && session.entries.length);
  const total = pending.reduce((sum, session) => sum + session.entries.length, 0);
  // Each stored memory uses one MidBrain credit, as a live capture does.
  if (total) err.write(`Each entry uses one MidBrain credit: this import needs ${total} credits.\n`);
  if (!options.apply) {
    if (total) err.write(`Preview only. To import these ${total} entries, re-run with --apply.\n`);
    return 0;
  }
  if (total === 0) {
    err.write("Nothing to import.\n");
    return 0;
  }
  if (!options.yes) {
    if (!isTTY) {
      err.write("Error: --apply needs confirmation; run it in a terminal or add --yes.\n");
      return 2;
    }
    if (!(await confirmFn(`Import ${total} entries from ${pending.length} session(s) into MidBrain? [y/N] `))) {
      err.write("Cancelled. Nothing was uploaded.\n");
      return 1;
    }
  }

  let lastReport = 0;
  const totals = await uploadImport({
    sessions: pending,
    wait,
    post: async (session, entry, metadata) => {
      const api = await apiFor({ client: session.client, cwd: entryCwd(session, entry) });
      return api.postImportedEpisodic(entry.text, entry.role, metadata, {
        occurredAt: entry.occurredAt,
        skipDream: !options.dream,
      });
    },
    onProgress: (event) => {
      if (event.type === "entry" && (event.totals.sent - lastReport >= 50)) {
        lastReport = event.totals.sent;
        err.write(`  ${event.totals.sent}/${total} entries stored\n`);
      }
    },
  });
  err.write(`Imported ${totals.sent} entries from ${totals.sessions} session(s)`);
  err.write(totals.redactions ? `, ${totals.redactions} secret(s) redacted` : "");
  err.write(totals.truncated ? `, ${totals.truncated} long entr${totals.truncated === 1 ? "y" : "ies"} truncated` : "");
  err.write(".\n");
  if (totals.blocked.length) {
    err.write(`${totals.blocked.length} entr${totals.blocked.length === 1 ? "y was" : "ies were"} blocked by MidBrain's firewall and not imported `
      + "(it can read text such as localhost URLs, SQL or HTML as an attack):\n");
    for (const item of totals.blocked.slice(0, 10)) err.write(`  ${item.client} ${item.sessionId} ${item.role} at ${item.occurredAt}\n`);
    if (totals.blocked.length > 10) err.write(`  ...and ${totals.blocked.length - 10} more\n`);
  }
  if (totals.stopped === "out of MidBrain credits") {
    err.write("Stopped early: your MidBrain account is out of credits. Live capture and search need them too.\n"
      + "Add credits or wait for the next cycle, then run the same command again to continue; entries already stored are skipped.\n"
      + "To import less, narrow it with --since, --until, --project or --client.\n");
    return 1;
  }
  if (totals.stopped) {
    err.write(`Stopped early: ${totals.stopped}. Run the same command again to continue; entries already stored are skipped.\n`);
    return 1;
  }
  return 0;
}
