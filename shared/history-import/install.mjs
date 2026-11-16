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
  for (const client of clients.filter((client) => READERS[client.id])) {
    const answer = await ask(`Review and import earlier conversations from ${client.displayName}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) continue;
    try {
      const result = await runImport(["--client", client.id, "--apply"]);
      if (result > 1) err.write(`${client.displayName} history import did not finish. Retry with npx midbrain-memory-mcp@latest import --client ${client.id} --apply.\n`);
    } catch (error) {
      err.write(`${client.displayName} history import failed: ${error.message}. Installation is complete; retry with the import command.\n`);
    }
  }
}
