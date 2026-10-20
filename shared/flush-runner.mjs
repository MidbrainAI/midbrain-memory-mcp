/**
 * shared/flush-runner.mjs
 *
 * One disciplined, WAF-aware, single-pass drain used by BOTH the keyless
 * recovery spool (issue #52) and the offline episodic cache (issue #53).
 *
 * The failure model (issue #53) is deliberately simple: there is no permanent
 * failure. Any entry that fails to POST — 4xx (e.g. a rotated/absent key),
 * 5xx, network, or a WAF rejection — is retryable and stays cached to be
 * retried on the next client/server start. Entries have no permanent retry
 * cap, age expiry, or quarantine. A caller may bound one pass; unattempted
 * entries remain survivors for a later start.
 *
 * Discipline (kills the "replay the whole backlog on every hook" amplification
 * that produced 1,610 errors in 32 minutes):
 *   - Runs once per invocation (callers run it at boot), never per capture.
 *   - Single pass: each claimed entry is POSTed at most once; failures are
 *     preserved as survivors for the next run.
 *   - WAF-aware: on a rate-limit signal (429, or an HTML-bodied 403) the pass
 *     stops immediately, the remaining entries are preserved, and a cooldown
 *     timestamp defers the next run so a rapid respawn does not re-burst.
 *   - Small inter-POST spacing so a recovered backlog drips rather than bursts.
 *
 * The spool and the cache now share IDENTICAL policy, so this runner needs no
 * per-consumer disposition callback — only a storage "source" and a poster.
 *
 * Node 20 + Bun compatible. No npm deps. Never throws.
 */

/** @typedef {"ok"|"rateLimited"|"failed"} PostResult */

/**
 * A pluggable flush source. Both claude-spool and episodic-cache expose these
 * shapes (begin/finish + cooldown read/write/clear).
 *
 * @typedef {object} FlushSource
 * @property {() => { claimed: boolean, entries: Array<object> }} begin
 *   Atomically claim the pending batch.
 * @property {(flush: object, survivors: Array<object>) => void} finish
 *   Complete the batch, preserving survivors for the next run.
 * @property {() => number} readCooldownUntil  Epoch-ms gate, 0 when unset.
 * @property {(until: number) => void} writeCooldownUntil
 * @property {() => void} clearCooldown
 */

const sleep = (ms) => new Promise((resolve) => (ms > 0 ? setTimeout(resolve, ms) : resolve()));

/**
 * Run one disciplined drain pass over a flush source.
 *
 * @param {object} opts
 * @param {FlushSource} opts.source
 * @param {(entry: object) => Promise<PostResult>} opts.post  POST one entry.
 * @param {number} [opts.spacingMs]   Inter-POST spacing (default 0).
 * @param {number} [opts.cooldownMs]  Cooldown to persist on WAF stop (default 0).
 * @param {number} [opts.maxEntries]  Maximum entries attempted in this pass.
 * @param {(msg: string) => void} [opts.log]  Optional status logger.
 * @param {string} [opts.label]       Human label for log lines.
 * @returns {Promise<{ sent: number, survivors: number, rateLimited: boolean, claimed: boolean }>}
 */
export async function runFlush({
  source,
  post,
  spacingMs = 0,
  cooldownMs = 0,
  maxEntries = Infinity,
  log,
  label = "flush",
}) {
  const summary = { sent: 0, survivors: 0, rateLimited: false, claimed: false };
  try {
    if (Date.now() < source.readCooldownUntil()) {
      log?.(`[midbrain] ${label} deferred (cooldown active)`);
      return summary;
    }

    const flush = source.begin();
    if (!flush.claimed) return summary;
    summary.claimed = true;

    const survivors = [];
    let rateLimited = false;
    let sent = 0;
    const attemptLimit = Number.isFinite(maxEntries)
      ? Math.max(0, Math.floor(maxEntries))
      : flush.entries.length;

    for (let i = 0; i < flush.entries.length; i += 1) {
      const entry = flush.entries[i];
      if (i >= attemptLimit) { survivors.push(entry); continue; }
      if (rateLimited) { survivors.push(entry); continue; }

      const result = await post(entry);
      if (result === "ok") {
        sent += 1;
      } else if (result === "rateLimited") {
        // Stop the pass; preserve this and every remaining entry.
        rateLimited = true;
        survivors.push(entry);
      } else {
        // Any other failure — retry on the next run (single pass here).
        survivors.push(entry);
      }
      const hasAnotherAttempt = !rateLimited && i + 1 < Math.min(attemptLimit, flush.entries.length);
      if (spacingMs > 0 && hasAnotherAttempt) await sleep(spacingMs);
    }

    if (rateLimited) {
      try {
        source.writeCooldownUntil(Date.now() + cooldownMs);
      } catch {
        // Cooldown is best effort; finishing still preserves every survivor.
      }
    }

    source.finish(flush, survivors);

    summary.sent = sent;
    summary.survivors = survivors.length;
    summary.rateLimited = rateLimited;

    if (rateLimited) {
      log?.(`[midbrain] ${label} rate-limited after ${sent}; ${survivors.length} preserved, cooling down`);
    } else {
      if (sent > 0) log?.(`[midbrain] ${label} recovered ${sent} entr${sent === 1 ? "y" : "ies"}`);
    }
    return summary;
  } catch {
    // Non-fatal: a drain must never affect the rest of startup.
    return summary;
  }
}
