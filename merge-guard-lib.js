// Merge safety guard for the cloud master one-shot.
// Snapshots canonical volume/coverage before and after a merge and refuses the
// commit when anything shrinks, so a bad delta can never overwrite good data.

const COVERAGE_KEYS = [
  'base_info', 'schedule', 'winning_price', 'photos', 'status_report',
  'sale_statement', 'appraisal_summary', 'appraisal_pdf', 'transactions',
  'building_registry', 'land_use', 'rights'
];

// Totals that must never go down across a merge.
const GUARDED_TOTALS = ['itemCount', 'documentCount', 'photoCount', 'eventCount', 'winningCount'];

const sum = (rows, fn) => rows.reduce((n, r) => n + Number(fn(r) || 0), 0);

function snapshot(rows) {
  const coverage = {};
  for (const k of COVERAGE_KEYS) {
    coverage[k] = rows.filter(r => Number(r.coverage?.[k] || 0) === 1).length;
  }
  return {
    itemCount: rows.length,
    documentCount: sum(rows, r => r.documentCount),
    photoCount: sum(rows, r => r.photoCount),
    eventCount: sum(rows, r => r.eventCount),
    winningCount: rows.filter(r => r.winningPrice).length,
    coverage
  };
}

// Returns a list of failure descriptions. Empty list means the merge is safe.
function evaluateGuard(before, after, { tolerance = 0 } = {}) {
  const failures = [];
  const drop = (field, b, a) => {
    const delta = Number(a || 0) - Number(b || 0);
    if (delta < -Math.abs(tolerance)) {
      failures.push({ field, before: Number(b || 0), after: Number(a || 0), delta });
    }
  };
  for (const k of GUARDED_TOTALS) drop(k, before?.[k], after?.[k]);
  for (const k of COVERAGE_KEYS) drop(`coverage.${k}`, before?.coverage?.[k], after?.coverage?.[k]);
  return failures;
}

// The source deletes a case the day after its 기일, so canonical is the only
// remaining record. Losing a row is therefore unrecoverable, and itemCount alone
// does not catch it: rows can be swapped one-for-one and keep the count level.
function findLostIds(beforeRows, afterRows, { limit = 20 } = {}) {
  const after = new Set(afterRows.map(r => r.id));
  const lost = [];
  for (const r of beforeRows) {
    if (!after.has(r.id)) lost.push(r.id);
    if (lost.length > limit) break;
  }
  return lost;
}

function evaluateRecordLoss(beforeRows, afterRows) {
  const lost = findLostIds(beforeRows, afterRows);
  if (!lost.length) return [];
  return [{
    field: 'lostCaseRecords',
    before: beforeRows.length,
    after: afterRows.length,
    delta: -lost.length,
    sampleLostIds: lost.slice(0, 20)
  }];
}

function formatFailures(failures) {
  return failures
    .map(f => `  ${f.field}: ${f.before} -> ${f.after} (${f.delta})` +
      (f.sampleLostIds ? `\n    lost ids: ${f.sampleLostIds.join(', ')}` : ''))
    .join('\n');
}

// stats.json coverage is written by the enrich workers, which under laptop-worker
// only ever see a truncated candidate subset. Recompute it from canonical here so
// the published numbers match the real database.
function syncStatsCoverage(stats, rows) {
  const snap = snapshot(rows);
  const next = { ...stats };
  next.itemCount = snap.itemCount;
  next.documentCount = snap.documentCount;
  next.photoCount = snap.photoCount;
  next.eventCount = snap.eventCount;
  next.winningCount = snap.winningCount;
  next.coverage = { ...(stats?.coverage || {}), ...snap.coverage };
  next.coverageSource = 'canonical-recount';
  next.generatedAt = new Date().toISOString();
  return next;
}

module.exports = { COVERAGE_KEYS, GUARDED_TOTALS, snapshot, evaluateGuard, evaluateRecordLoss, findLostIds, formatFailures, syncStatsCoverage };
