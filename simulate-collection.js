// Read-only rehearsal of the rebuilt collection logic against the canonical data
// already on disk. Sends nothing: it asserts that global.fetch is untouched and
// fails loudly if anything tries to reach the court.
//
// It answers three questions without asking the court anything:
//   1. which cases would the new priority pick first, versus the old one
//   2. what would the winning-result extraction fill in, given a detail response
//      of the shape the endpoint returns (field names from earlier measurement)
//   3. which rows would be marked expired, and does canonical stay whole
//
//   node simulate-collection.js

const fs = require('fs');
const path = require('path');

// Hard stop: this script must never talk to the court.
const realFetch = global.fetch;
global.fetch = () => { throw new Error('simulate-collection.js must not make any request'); };

const { priority, expiringUncaptured, missingCount, bidderCountFrom, kstDay } = require('./detail-enrich');
const { evaluateRecordLoss, snapshot } = require('./merge-guard-lib');
const { buildPatch, applyPatch } = require('./dual-collector-lib');

const DATA = path.join(__dirname, 'data', 'auctions.json');
const BATCH = Number(process.env.BATCH_SIZE || 24);
const NOW = Date.now();
const TODAY = kstDay(NOW);
const TOMORROW = kstDay(NOW + 86400000);

const rows = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const VALID = /^\d{4}타경\d+$/;
const eligible = rows.filter(r => VALID.test(String(r.caseNumber || '').trim()));

const cmp = fn => (a, b) => {
  const A = fn(a), B = fn(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const d = (A[i] ?? 0) - (B[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

// The ordering this replaced, kept here only so the two can be compared.
const oldPriority = row => {
  const t = Date.parse(row.saleDate || '');
  const enriched = ['schedule', 'appraisal_summary', 'status_report', 'sale_statement']
    .reduce((n, k) => n + Number(row.coverage?.[k] || 0), 0);
  if (!Number.isFinite(t)) return [enriched, 4, 999999];
  const d = (t - NOW) / 86400000;
  const bucket = d >= -14 && d <= 60 ? 0 : d < -14 && d >= -120 ? 1 : d > 60 ? 2 : 3;
  return [enriched, bucket, Math.abs(d)];
};

console.log(`=== canonical ${rows.length} rows, ${eligible.length} with a well-formed 사건번호 ===`);
console.log(`today(KST)=${TODAY} tomorrow=${TOMORROW}\n`);

// --- 1. what the queue would do -------------------------------------------
const tier0 = eligible.filter(r => expiringUncaptured(r, NOW));
const newBatch = [...eligible].sort(cmp(r => priority(r, NOW))).slice(0, BATCH);
const oldBatch = [...eligible].sort(cmp(oldPriority)).slice(0, BATCH);

const sameDay = r => r.saleDate === TODAY;
console.log('--- 1. next batch of ' + BATCH + ' ---');
console.log(`tier 0 pool (기일 today/tomorrow, no winningPrice) = ${tier0.length}`);
console.log(`  of which 기일 is TODAY = ${tier0.filter(sameDay).length}`);
console.log(`new priority: ${newBatch.filter(r => expiringUncaptured(r, NOW)).length}/${BATCH} of the batch are tier 0`);
console.log(`old priority: ${oldBatch.filter(r => expiringUncaptured(r, NOW)).length}/${BATCH} of the batch were tier 0`);
console.log('new batch head:');
for (const r of newBatch.slice(0, 5)) {
  console.log(`  ${r.caseNumber.padEnd(16)} 기일=${r.saleDate} missing=${missingCount(r)} tier0=${expiringUncaptured(r, NOW)}`);
}
console.log('old batch head:');
for (const r of oldBatch.slice(0, 5)) {
  console.log(`  ${r.caseNumber.padEnd(16)} 기일=${r.saleDate} missing=${missingCount(r)} tier0=${expiringUncaptured(r, NOW)}`);
}

// --- 2. what extraction would fill ----------------------------------------
// Response shape and field names come from the endpoint measurements already in
// hand (gdsDspslDxdyLst entries carry dspslDxdyYmd / dspslDxdyDvsNm /
// dspslDxdyRsltNm / lwsDspslPrc, and the winning amount arrives under one of the
// price keys or inside the result text).
const subject = tier0.find(sameDay) || tier0[0] || eligible[0];
const soldResponse = {
  data: {
    dma_result: {
      csBaseInfo: { csNm: '부동산강제경매', aeeWevlInstNm: '가나감정평가법인', clmAmt: '150,000,000' },
      dspslGdsDxdyInfo: { dspslUsgNm: '아파트', dspslGdsSpcfcEcdocId: 'DOC-1', orvParam: 'X' },
      gdsDspslDxdyLst: [
        { dspslDxdyYmd: '20260825', dspslDxdyDvsNm: '매각기일', dspslDxdyRsltNm: '유찰', lwsDspslPrc: '420,000,000' },
        {
          dspslDxdyYmd: String(subject?.saleDate || TODAY).replace(/-/g, ''),
          dspslDxdyDvsNm: '매각기일',
          dspslDxdyRsltNm: '매각 (응찰 7명)',
          lwsDspslPrc: '336,000,000',
          sucBidPrc: '451,300,000'
        }
      ],
      aeeWevlMnpntLst: [{ aeeWevlMnpntCtt: '남향, 도로접함' }]
    }
  }
};

// Replay exactly what detail-enrich does with that payload.
const asInt = v => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? Math.trunc(n) : null; };
const normDate = v => { const s = String(v || '').replace(/[^0-9]/g, ''); return s.length >= 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null; };
const eventResult = e => String(e.dspslDxdyRsltNm || e.rsltCtt || '');
const winningFrom = e => {
  for (const k of ['winningPrice', 'bidPrice', 'salePrice', 'maePrc', 'maeAmt', 'sucBidPrc', 'dspslPrc', 'bidAmt', 'nakchalAmt', 'nakchalPrc', 'scsBidPrc']) {
    const n = asInt(e?.[k]); if (n && n > 0) return n;
  }
  const s = eventResult(e);
  if (/매각|낙찰/.test(s)) {
    const n = [...s.matchAll(/([0-9][0-9,]{4,})\s*원?/g)].map(m => asInt(m[1])).filter(Boolean);
    if (n.length) return Math.max(...n);
  }
  return null;
};

const beforeRow = JSON.parse(JSON.stringify(subject));
const filled = JSON.parse(JSON.stringify(subject));
const events = soldResponse.data.dma_result.gdsDspslDxdyLst;
filled.events = events.map(e => ({
  event_date: normDate(e.dspslDxdyYmd),
  event_type: e.dspslDxdyDvsNm,
  amount: asInt(e.lwsDspslPrc),
  result_text: eventResult(e)
}));
filled.eventCount = filled.events.length;
filled.coverage = { ...(filled.coverage || {}), schedule: 1 };
for (const e of events) {
  const w = winningFrom(e);
  if (w) {
    filled.winningPrice = w;
    filled.winningDate = normDate(e.dspslDxdyYmd);
    filled.winningRatio = filled.appraisedPrice ? Math.round(w / filled.appraisedPrice * 10000) / 100 : null;
    filled.coverage.winning_price = 1;
    filled.status = '매각';
    const bc = bidderCountFrom(e);
    if (bc !== null) filled.bidderCount = bc;
  }
}
const lastEv = [...events].filter(e => normDate(e.dspslDxdyYmd)).sort((a, b) => normDate(a.dspslDxdyYmd).localeCompare(normDate(b.dspslDxdyYmd))).at(-1);
if (lastEv) filled.saleResult = eventResult(lastEv);

console.log('\n--- 2. what a 매각 response would fill in ---');
console.log(`subject: ${subject.caseNumber} (기일 ${subject.saleDate}, 감정가 ${subject.appraisedPrice})`);
console.log(`  winningPrice : ${beforeRow.winningPrice} -> ${filled.winningPrice}`);
console.log(`  winningDate  : ${beforeRow.winningDate} -> ${filled.winningDate}`);
console.log(`  winningRatio : ${beforeRow.winningRatio} -> ${filled.winningRatio}`);
console.log(`  bidderCount  : ${beforeRow.bidderCount ?? null} -> ${filled.bidderCount}`);
console.log(`  saleResult   : ${beforeRow.saleResult ?? null} -> ${filled.saleResult}`);
console.log(`  status       : ${beforeRow.status || '(empty)'} -> ${filled.status}`);
console.log(`  coverage.winning_price: ${beforeRow.coverage?.winning_price} -> ${filled.coverage.winning_price}`);

const patch = buildPatch(beforeRow, filled);
const patchKeys = Object.keys(patch?.set || {}).sort();
console.log(`  delta patch carries: ${patchKeys.join(', ')}`);
const roundTrip = applyPatch(JSON.parse(JSON.stringify(beforeRow)), patch);
const carried = ['winningPrice', 'winningDate', 'winningRatio', 'bidderCount', 'saleResult', 'status']
  .every(k => JSON.stringify(roundTrip[k]) === JSON.stringify(filled[k]));
console.log(`  survives delta -> canonical round trip: ${carried ? 'YES' : 'NO'}`);

// --- 3. expiry marking, and canonical stays whole --------------------------
const vanished = rows.filter(r => r.saleDate && r.saleDate < TODAY);
const afterRows = rows.map(r => (r.saleDate && r.saleDate < TODAY)
  ? { ...r, status: 'expired', expiredAt: r.expiredAt || new Date().toISOString() }
  : r);

console.log('\n--- 3. expiry marking ---');
console.log(`rows whose 기일 has passed (source has dropped them) = ${vanished.length}`);
console.log(`row count before/after = ${rows.length}/${afterRows.length}`);
console.log(`marked expired = ${afterRows.filter(r => r.status === 'expired').length}`);
console.log(`record-loss guard failures = ${evaluateRecordLoss(rows, afterRows).length} (must be 0)`);

const before = snapshot(rows), after = snapshot(afterRows);
console.log(`itemCount ${before.itemCount} -> ${after.itemCount}, documentCount ${before.documentCount} -> ${after.documentCount}`);

// The failure this rule prevents: deleting them instead of marking them.
const deletedInstead = rows.filter(r => !(r.saleDate && r.saleDate < TODAY));
const lossIfDeleted = evaluateRecordLoss(rows, deletedInstead);
console.log(`if they were deleted instead: guard failures = ${lossIfDeleted.length}, lost = ${vanished.length} rows`);

const ok = carried
  && evaluateRecordLoss(rows, afterRows).length === 0
  && lossIfDeleted.length === 1
  && filled.winningPrice > 0
  && newBatch.filter(r => expiringUncaptured(r, NOW)).length >= Math.min(BATCH, tier0.length);

console.log(`\n=== ${ok ? 'SIMULATION OK' : 'SIMULATION FOUND A PROBLEM'} — no court request was made ===`);
global.fetch = realFetch;
process.exitCode = ok ? 0 : 1;
