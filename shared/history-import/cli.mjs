/**
 * `npx midbrain-memory-mcp@latest import`: opt-in import of existing local conversation
 * history into MidBrain episodic memory (issue #75).
 *
 * Preview by default. Nothing is uploaded without `--apply` and a
 * confirmation (or `--yes`). Output goes to stderr, like the installer.
 */

import readline from "node:readline";
import { parseArgs } from "node:util";

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
  --apply           Upload after showing the preview
  --yes             With --apply: do not ask for confirmation
  --dream           Let MidBrain run its per-memory processing on imported
                    turns (off by default, as for any bulk load)
  -h, --help        Show this help

What is imported: your prompts and the reply that ended each turn, with
their original time, labeled origin=import. Tool calls and output, injected
context, subagent threads, sessions a program started, sessions active in
the last 10 minutes, and turns MidBrain already captured live are left out.
Each turn is stored with the key live capture would use for its directory.`;

/** Strict, so a typo never drops a filter and widens the import. */
export function parseImportArgs(argv, readers = READERS) {
  const { values } = parseArgs({
    args: argv.map(String),
    strict: true,
    options: {
      client: { type: "string" },
      since: { type: "string" },
      apply: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      dream: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.client === "") throw new Error("--client requires a value");
  // Each client once: a repeated name would plan, and upload, its sessions twice.
  const clients = values.client ? [...new Set(values.client.split(",").map((name) => name.trim()).filter(Boolean))] : Object.keys(readers);
  const unknown = clients.filter((name) => !readers[name]);
  if (unknown.length) throw new Error(`unsupported client: ${unknown.join(", ")} (supported: ${Object.keys(readers).join(", ")})`);
  let since = null;
  if (values.since !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.since) || Number.isNaN(Date.parse(`${values.since}T00:00:00Z`))) {
      throw new Error("--since must be a date like 2026-09-01");
    }
    since = new Date(`${values.since}T00:00:00Z`).toISOString();
  }
  return { help: values.help, clients, since, apply: values.apply, yes: values.yes, dream: values.dream };
}

/**
 * One line per key scope for the directories of pending entries that have no
 * project key, in place of the warning key resolution prints for each.
 */
async function keyFallbackLine(sessions, apiFor) {
  const fallbacks = new Map();
  for (const session of sessions) {
    for (const entry of session.entries) {
      const api = await apiFor({ client: session.client, cwd: entryCwd(session, entry) });
      if (api.projectFallbackNote && api.requestedProjectDir) fallbacks.set(api.requestedProjectDir, api.keyScope);
    }
  }
  const byScope = {};
  for (const scope of fallbacks.values()) byScope[scope] = (byScope[scope] || 0) + 1;
  return Object.entries(byScope).map(([scope, count]) =>
    `${count} folder${count === 1 ? " has" : "s have"} no project key; ${count === 1 ? "its" : "their"} turns use your ${scope} key, as live capture does.`,
  ).join("\n");
}

function formatPreview(summary) {
  const lines = [];
  for (const [client, row] of Object.entries(summary)) {
    const entries = row.user + row.assistant;
    lines.push(`${client}: ${row.sessions} session(s), ${row.user} prompt(s) + ${row.assistant} reply(ies) = ${entries} entr${entries === 1 ? "y" : "ies"}, ~${Math.round(row.chars / 1000)}k characters`);
    if (row.first) lines.push(`  from ${row.first.slice(0, 10)} to ${row.last.slice(0, 10)}`);
    for (const [reason, count] of Object.entries(row.skipped)) lines.push(`  skipped ${count} session(s): ${reason}`);
  }
  if (lines.length === 0) lines.push("No history found for the selected clients.");
  return lines.join("\n");
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
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
        // Quiet: one directory per turn would print a warning each; the
        // preview reports the fallback once instead (keyFallbackLine).
        ? MidbrainApi.create(adapter, cwd ?? undefined, { clientLabel: client, quiet: true })
        : Promise.reject(new Error(`no adapter for ${client}`)));
    }
    return cache.get(cacheKey);
  };
}

/** The directory an entry is stored from: its own, else its session's. */
const entryCwd = (session, entry) => entry.cwd || session.cwd || null;

/** Each distinct destination (host and key) and the session's entries stored there. */
async function sessionDestinations(session, apiFor) {
  const destinations = new Map();
  for (const entry of session.entries) {
    const api = await apiFor({ client: session.client, cwd: entryCwd(session, entry) });
    const key = `${api.effectiveApiBase}\0${api.keyFingerprint}`;
    if (!destinations.has(key)) destinations.set(key, { api, entries: [] });
    destinations.get(key).entries.push(entry);
  }
  return [...destinations.values()];
}

export async function runImportCli(argv, {
  readers = READERS,
  err = process.stderr,
  isTTY = process.stdin.isTTY,
  apiFor = apiResolver(),
  confirmFn = confirm,
  wait,
} = {}) {
  let options;
  try {
    options = parseImportArgs(argv, readers);
  } catch (error) {
    err.write(`Error: ${error.message}\n\n${HELP}\n`);
    return 2;
  }
  if (options.help) {
    err.write(`${HELP}\n`);
    return 0;
  }

  err.write("Reading local history (nothing is uploaded yet)...\n");
  const sessions = await planImport({ ...options, readers });
  err.write("Checking which sessions MidBrain already has (sends session ids only)...\n");
  // Each entry is checked against what its own destination holds. A failed
  // check skips the session (see trimAgainstServer); a re-run retries.
  // Live capture may have stored the conversation under a linked id too
  // (e.g. the Claude Code session an OpenClaw session ran on).
  await trimAgainstServer(sessions, async (session) => {
    const destinations = await sessionDestinations(session, apiFor);
    const ids = [session.sessionId, ...(session.linkedSessionIds ?? [])];
    return Promise.all(destinations.map(async ({ api, entries }) => {
      const lists = await Promise.all(ids.map((id) => api.listEpisodicForSession(id)));
      return { entries, existing: lists.flat() };
    }));
  });
  err.write(`\n${formatPreview(summarize(sessions))}\n\n`);

  const pending = sessions.filter((session) => !session.skip && session.entries.length);
  const fallbackLine = await keyFallbackLine(pending, apiFor);
  if (fallbackLine) err.write(`${fallbackLine}\n`);
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
  err.write(totals.truncated ? `, ${totals.truncated} long entr${totals.truncated === 1 ? "y" : "ies"} truncated` : "");
  err.write(".\n");
  if (totals.blocked.length) {
    err.write(`${totals.blocked.length} entr${totals.blocked.length === 1 ? "y was" : "ies were"} blocked by MidBrain's firewall and not imported `
      + "(it can read text such as localhost URLs, SQL or HTML as an attack):\n");
    for (const item of totals.blocked.slice(0, 10)) err.write(`  ${item.client} ${item.sessionId} ${item.role} at ${item.occurredAt}\n`);
    if (totals.blocked.length > 10) err.write(`  ...and ${totals.blocked.length - 10} more\n`);
  }
  if (totals.stopped) {
    const next = { outOfCredits: "Add credits, then run", rateLimited: "Wait a few minutes, then run" }[totals.stoppedOn] ?? "Run";
    err.write(`Stopped early: ${totals.stopped}, after storing ${totals.sent} of ${total} entries.\n`
      + `${next} the same command again to continue; entries already stored are skipped.\n`);
    return 1;
  }
  return 0;
}
