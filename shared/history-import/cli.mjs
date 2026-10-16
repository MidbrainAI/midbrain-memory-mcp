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

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function isoDate(value, flag) {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${flag} must be a date like 2026-09-01`);
  }
  return new Date(`${value}T00:00:00Z`).toISOString();
}

export function parseImportArgs(argv) {
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

/** One MidbrainApi per (client, directory): the key live capture would use there. */
function apiResolver() {
  const adapters = Object.fromEntries(allClients().map((client) => [client.id, client]));
  const cache = new Map();
  return (session) => {
    const cacheKey = `${session.client}\0${session.cwd ?? ""}`;
    if (!cache.has(cacheKey)) {
      const adapter = adapters[session.client];
      cache.set(cacheKey, adapter
        ? quietly(() => MidbrainApi.create(adapter, session.cwd ?? undefined, { clientLabel: session.client }))
        : Promise.reject(new Error(`no adapter for ${session.client}`)));
    }
    return cache.get(cacheKey);
  };
}

function formatKeyScopes(sessions) {
  const counts = {};
  for (const session of sessions) {
    if (session.skip || !session.keyScope) continue;
    counts[session.keyScope] = (counts[session.keyScope] || 0) + 1;
  }
  const parts = Object.entries(counts).map(([scope, count]) => `${count} session(s) with the ${scope} key`);
  return parts.length ? `Keys: ${parts.join(", ")}.` : "";
}

export async function runImportCli(argv, { readers = READERS, out = process.stdout, err = process.stderr, isTTY = process.stdin.isTTY } = {}) {
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
  const apiFor = apiResolver();
  if (!options.offline) {
    err.write("Checking which sessions MidBrain already has (sends session ids only)...\n");
    await trimAgainstServer(sessions, async (session) => {
      const api = await apiFor(session);
      session.keyScope = api.keyScope;
      return api.listEpisodicForSession(session.sessionId);
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
    if (!(await confirm(`Import ${total} entries from ${pending.length} session(s) into MidBrain? [y/N] `))) {
      err.write("Cancelled. Nothing was uploaded.\n");
      return 1;
    }
  }

  let lastReport = 0;
  const totals = await uploadImport({
    sessions: pending,
    post: async (session, entry, metadata) => {
      const api = await apiFor(session);
      return api.postEpisodicResult(entry.text, entry.role, metadata, {
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
  if (totals.stopped) {
    err.write(`Stopped early: ${totals.stopped}. Run the same command again to continue; entries already stored are skipped.\n`);
    return 1;
  }
  return 0;
}
