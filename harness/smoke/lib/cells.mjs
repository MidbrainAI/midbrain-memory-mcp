export function cell({ row, scenario, client, checks = [], prompt = '', expected = '', evidence = [], notes = '', status, blockedReason }) {
  let st = status;
  if (!st) st = blockedReason ? 'BLOCKED' : (checks.length && checks.every((c) => c.ok) ? 'PASS' : (checks.length ? 'FAIL' : 'BLOCKED'));
  return { row, scenario, client: client.id, clientDisplay: client.displayName, status: st, checks, prompt, expected, evidence: evidence.filter(Boolean), notes, blockedReason: blockedReason || null };
}

export function blockedCells(rows, scenario, client, reason, extra = {}) {
  return rows.map((row) => cell({ row, scenario, client, blockedReason: reason, ...extra }));
}
