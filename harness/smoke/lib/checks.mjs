// Deterministic check helpers and the cell status rules (design doc §5.1).
export class BlockedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'BlockedError';
    this.blocked = true;
  }
}

export function check(name, ok, detail = '') {
  return { name, ok: Boolean(ok), detail: detail === undefined || detail === null ? '' : String(detail) };
}

export function statusFromChecks(checks) {
  if (!checks || checks.length === 0) return 'BLOCKED';
  return checks.every((c) => c.ok) ? 'PASS' : 'FAIL';
}

export function runExitCode(cells, isolationOk) {
  return isolationOk && cells.length > 0 && cells.every(c => c.status === 'PASS' || c.status === 'BLOCKED') ? 0 : 1;
}

export function runOutcome(cells, isolationOk) {
  if (runExitCode(cells, isolationOk)) return 'FAIL';
  return cells.some(c => c.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
}
