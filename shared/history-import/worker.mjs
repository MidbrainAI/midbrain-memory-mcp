import { makeLogger } from "../logger.mjs";
import { claimImport, writeImportStatus } from "./background.mjs";
import { apiResolver, checkImportSessions, uploadApprovedImport } from "./cli.mjs";

// This entry point is internal: no CLI, no re-reading history, no interactive prompts.
if (process.send) process.once("message", async ({ sessions, logPath }) => {
  let release;
  let status;
  const logger = makeLogger(logPath, { level: "info" });
  try {
    release = claimImport();
    status = { state: "running", pid: process.pid, logPath, stored: 0,
      total: sessions.reduce((sum, session) => sum + session.entries.length, 0) };
    writeImportStatus(status);
    logger.info(`Import started: ${status.total} approved entries.`);
    await new Promise((resolve, reject) => process.send({ ready: true }, (error) => error ? reject(error) : resolve()));
    if (process.connected) process.disconnect();
    const apiFor = apiResolver();
    for (const session of sessions) {
      for (const entry of session.entries) {
        const api = await apiFor({ client: session.client, cwd: entry.cwd || session.cwd || null });
        if (api.effectiveApiBase !== entry.importBinding?.host || api.keyFingerprint !== entry.importBinding?.fingerprint) {
          throw new Error("Import destination changed after confirmation; run the import again to review it.");
        }
      }
    }
    // Another import may have finished after preview. Check again under the lock.
    await checkImportSessions(sessions, apiFor);
    const unchecked = sessions.filter((session) => session.skip?.startsWith("could not check"));
    if (unchecked.length) throw new Error("Could not recheck imported memories; no uploads started. Run the import again to retry.");
    for (const session of sessions) { if (session.skip) logger.info(`Skipped session: ${session.skip}`); }
    const pending = sessions.filter((session) => !session.skip && session.entries.length);
    status.total = pending.reduce((sum, session) => sum + session.entries.length, 0);
    writeImportStatus(status);
    const result = await uploadApprovedImport(pending, {
      apiFor, err: { write: (text) => logger.info(text.trimEnd()) },
      onProgress: (event) => {
        status.stored = event.totals.sent;
        writeImportStatus(status);
      },
    });
    status.state = result === 0 ? "complete" : "stopped";
    writeImportStatus(status);
    logger.info(`Import ${status.state}: ${status.stored}/${status.total} entries stored.`);
  } catch (error) {
    logger.error(error.message);
    if (status) { status.state = "failed"; writeImportStatus(status); }
    if (process.connected) {
      await new Promise((resolve) => process.send({ error: error.message }, () => resolve()));
      if (process.connected) process.disconnect();
    }
    process.exitCode = 1;
  } finally { release?.(); }
});
