#!/usr/bin/env node
/**
 * MidBrain Memory MCP Server — entry point.
 *
 * Dispatches to mcp.mjs (MCP tools), install.mjs (install subcommand),
 * or published hook entry points.
 * All logic lives in those modules.
 *
 * IMPORTANT: No console.log — corrupts stdio JSON-RPC pipe. Use console.error only.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp.mjs";
import { PKG_VERSION, checkForUpdate, prepareCaptureClientMigration } from "./install.mjs";
import { realpathSync } from "fs";
import { fileURLToPath } from "url";

export { createServer };

/** Start the real MCP stdio path with only capture-label migration pre-ready. */
export async function startMcpServer({
  serverFactory = createServer,
  transportFactory = () => new StdioServerTransport(),
  prepareCaptureClientMigrationFn = prepareCaptureClientMigration,
  checkForUpdateFn = checkForUpdate,
  prepareOptions,
  log = console.error,
} = {}) {
  const preparation = await prepareCaptureClientMigrationFn(prepareOptions);
  const server = serverFactory(PKG_VERSION);
  const transport = transportFactory();
  await server.connect(transport);
  log(`MCP server running (midbrain-memory-mcp v${PKG_VERSION})`);
  try {
    const update = checkForUpdateFn({ ...prepareOptions, preparation });
    if (update?.catch) update.catch(() => {});
  } catch { /* never break the connected server */ }
}

const isMain = process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (isMain) {
  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(PKG_VERSION);
    process.exit(0);
  } else if (process.argv[2] === "hook") {
    const [, , , client, event] = process.argv;
    if (client === "claude" && event === "user") {
      await import("./plugins/claude-code/capture-user.mjs");
    } else if (client === "claude" && event === "assistant") {
      await import("./plugins/claude-code/capture-assistant.mjs");
    } else if (client === "codex" && event === "user") {
      await import("./plugins/codex/capture-user.mjs");
    } else if (client === "codex" && event === "assistant") {
      await import("./plugins/codex/capture-assistant.mjs");
    } else if (client === "codex" && event === "tool") {
      await import("./plugins/codex/capture-tool.mjs");
    } else if (client === "hermes" && event === "user") {
      await import("./plugins/hermes/capture-user.mjs");
    } else if (client === "hermes" && event === "assistant") {
      await import("./plugins/hermes/capture-assistant.mjs");
    } else {
      console.error("Usage: midbrain-memory-mcp hook claude user|assistant OR hook codex user|assistant|tool OR hook hermes user|assistant");
      process.exit(2);
    }
  } else if (process.argv[2] === "install") {
    const { runInstallerCli } = await import("./install.mjs");
    await runInstallerCli(process.argv.slice(3));
  } else if (process.argv[2] === "user-key") {
    const { runUserKeyCli } = await import("./install.mjs");
    await runUserKeyCli(process.argv.slice(3));
  } else {
    await startMcpServer();
  }
}
