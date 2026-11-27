import readline from "node:readline";
import { runImportCli } from "./cli.mjs";
import { READERS } from "./readers/index.mjs";

async function askQuestion(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try { return await new Promise((resolve) => rl.question(question, resolve)); }
  finally { rl.close(); }
}

/** Offer each detected client's history after an interactive installation. */
export async function offerHistoryImport(clients, {
  nonInteractive = false,
  isTTY = process.stdin.isTTY,
  ask = askQuestion,
  runImport = runImportCli,
  err = process.stderr,
} = {}) {
  if (nonInteractive || !isTTY) return;
  const selected = [];
  for (const client of clients.filter((client) => READERS[client.id])) {
    const answer = await ask(`Review and import earlier conversations from ${client.displayName}? [y/N] `);
    if (/^y(es)?$/i.test(answer.trim())) selected.push(client.id);
  }
  if (!selected.length) return;
  try {
    const result = await runImport(["--client", selected.join(","), "--apply"]);
    if (result > 1) err.write("History import did not start. Installation is complete; retry with the import command.\n");
  } catch (error) {
    err.write(`History import failed: ${error.message}. Installation is complete; retry with the import command.\n`);
  }
}
