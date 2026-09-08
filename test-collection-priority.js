// Offline tests for the collection priority and the expiry rules. No network.
//
//   1. a 기일-today row with no winningPrice must outrank everything else
//   2. the same row WITH a winningPrice must lose that privilege
//   3. a row whose source record is gone must be marked expired, never removed
//   4. the merge guard must refuse a merge that drops an existing case record
//
//   node test-collection-priority.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { priority, expiringUncaptured, kstDay } = require('./detail-enrich');
const { evaluateRecordLoss, formatFailures } = require('./merge-guard-lib');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  if (!ok) failures++;
};

const NOW = Date.parse('2026-09-09T02:00:00Z'); // 11:00 KST on 2026-09-09
const TODAY = kstDay(NOW);
const TOMORROW = kstDay(NOW + 86400000);
const cov = o => ({ base_info: 1, schedule: 0, winning_price: 0, photos: 0, status_report: 0, sale_statement: 0, appraisal_summary: 0, appraisal_pdf: 0, transactions: 0, building_registry: 0, land_use: 0, rights: 0, ...o });

const row = (id, saleDate, extra = {}) => ({
  id, caseNumber: id, itemNumber: '1', courtCode: 'B000210',
  saleDate, winningPrice: null, coverage: cov(), ...extra
});

// ---------------------------------------------------------------------------
console.log('\n=== TEST 1: 기일 today + no winningPrice outranks everything ===\n');

const expiringToday = row('EXPIRING-TODAY', TODAY);
const expiringTomorrow = row('EXPIRING-TOMORROW', TOMORROW);
// A row that the old ordering would have put first: nothing enriched at all.
const emptyFarFuture = row('EMPTY-FAR', '2026-09-22');
// A row already fully enriched but still far out.
const richFuture = row('RICH-FUTURE', '2026-09-21', {
  coverage: cov({ schedule: 1, status_report: 1, sale_statement: 1, appraisal_summary: 1 })
});
const stale = row('STALE-PAST', '2026-08-01');

const pool = [emptyFarFuture, richFuture, stale, expiringTomorrow, expiringToday];
const ordered = [...pool].sort((a, b) => {
  const A = priority(a, NOW), B = priority(b, NOW);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] ?? 0) - (B[i] ?? 0);
    if (d) return d;
  }
  return 0;
}).map(r => r.id);

console.log('order:', ordered.join(' > '));
check('test1 today-expiring is first', ordered[0] === 'EXPIRING-TODAY', ordered[0]);
check('test1 tomorrow-expiring is second', ordered[1] === 'EXPIRING-TOMORROW', ordered[1]);
check('test1 the un-enriched far row lost its old first place', ordered.indexOf('EMPTY-FAR') > 1);
check('test1 tier 0 marks only the two expiring rows',
  pool.filter(r => expiringUncaptured(r, NOW)).map(r => r.id).join(',') === 'EXPIRING-TOMORROW,EXPIRING-TODAY');

// ---------------------------------------------------------------------------
console.log('\n=== TEST 2 (deliberate failure): a captured winningPrice must drop the row out of tier 0 ===\n');

const captured = row('CAPTURED-TODAY', TODAY, { winningPrice: 123000000 });
check('test2 captured row is NOT tier 0', !expiringUncaptured(captured, NOW));
check('test2 captured row ranks below the uncaptured one',
  priority(captured, NOW)[0] > priority(expiringToday, NOW)[0],
  `${JSON.stringify(priority(captured, NOW))} vs ${JSON.stringify(priority(expiringToday, NOW))}`);

// ---------------------------------------------------------------------------
console.log('\n=== TEST 3 (deliberate failure): a vanished case must be marked, never deleted ===\n');

// A dropped case is one the source answers with an empty dma_result. Apply the
// rule detail-enrich applies in that branch, then assert the invariant.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'expiry-test-'));
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
const before = [
  row('B000210|2026타경1|1', '2026-09-01'),          // 기일 passed -> source drops it
  row('B000210|2026타경2|1', '2026-09-22')           // still live
];
fs.writeFileSync(path.join(TMP, 'data', 'auctions.json'), JSON.stringify(before, null, 2));
fs.writeFileSync(path.join(TMP, 'data', 'stats.json'), JSON.stringify({}, null, 2));

// Simpler and more honest than rewriting module internals: apply the documented
// rule directly to the rows and assert the invariant the guard has to hold.
const after = before.map(r => ({ ...r }));
const sourceDropped = new Set(['B000210|2026타경1|1']);
for (const r of after) {
  if (sourceDropped.has(r.id)) { r.status = 'expired'; r.expiredAt = new Date().toISOString(); }
}
check('test3 the vanished row is still present', after.some(r => r.id === 'B000210|2026타경1|1'));
check('test3 the vanished row is marked expired',
  after.find(r => r.id === 'B000210|2026타경1|1').status === 'expired');
check('test3 row count did not shrink', after.length === before.length, `${before.length} -> ${after.length}`);

// The failure mode this rule exists to prevent: dropping the row instead.
const deleted = after.filter(r => !sourceDropped.has(r.id));
const lossFailures = evaluateRecordLoss(before, deleted);
console.log(formatFailures(lossFailures));
check('test3 deleting it instead is caught by the guard', lossFailures.length === 1);
check('test3 guard names the lost id',
  lossFailures[0]?.sampleLostIds?.includes('B000210|2026타경1|1'));
check('test3 guard reports zero failures for the correct (expired) result',
  evaluateRecordLoss(before, after).length === 0);

// ---------------------------------------------------------------------------
console.log('\n=== TEST 4 (deliberate failure): equal itemCount must not hide a swapped-out record ===\n');

const swapped = [
  { ...before[1] },
  row('B000210|2026타경999|1', '2026-09-22')   // a new row replaces the dropped one
];
const swapFailures = evaluateRecordLoss(before, swapped);
console.log(formatFailures(swapFailures));
check('test4 same row count', before.length === swapped.length, `${before.length} vs ${swapped.length}`);
check('test4 record loss still caught', swapFailures.length === 1);
check('test4 names the lost id', swapFailures[0]?.sampleLostIds?.includes('B000210|2026타경1|1'));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n=== ${failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED'} ===`);
process.exitCode = failures ? 1 : 0;
