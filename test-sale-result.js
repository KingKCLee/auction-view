// Tests the 매각결과 mapping against real response rows. No network.
//
// The rows below are verbatim shapes returned by selectDspslSchdRsltSrch.on on
// 2026-09-09, including the two that carried an actual winning price.
//
//   node test-sale-result.js

const { normalize, buildPatch, buildAddition } = require('./sale-result-collect');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  if (!ok) failures++;
};

// Sold: 감정 416,500,000 -> 낙찰 431,000,000
const SOLD = {
  boCd: 'B000210', jiwonNm: '서울중앙지방법원', srnSaNo: '2023타경111644',
  maemulSer: '1', maeGiil: '20260903', gamevalAmt: 416500000,
  minmaePrice: 416500000, maeAmt: 431000000, yuchalCnt: 1,
  printSt: '서울특별시 중구 ...', dspslUsgNm: '아파트', mulStatcd: '03'
};
// Not sold: maeAmt is 0, the row still describes the 기일
const UNSOLD = {
  boCd: 'B000210', jiwonNm: '서울중앙지방법원', srnSaNo: '2008타경25092',
  maemulSer: '2', maeGiil: '20260903', gamevalAmt: 197000000,
  minmaePrice: 126080000, maeAmt: 0, yuchalCnt: 4, mulStatcd: '03'
};

const cov = () => ({
  base_info: 1, schedule: 0, winning_price: 0, photos: 0, status_report: 0,
  sale_statement: 0, appraisal_summary: 0, appraisal_pdf: 0,
  transactions: 0, building_registry: 0, land_use: 0, rights: 0
});

// ---------------------------------------------------------------------------
console.log('\n=== TEST 1: a sold row maps to a winning price ===\n');

const sold = normalize(SOLD);
console.log(JSON.stringify(sold, null, 1));
check('test1 id is built from court|case|item', sold.id === 'B000210|2023타경111644|1', sold.id);
check('test1 winningPrice comes from maeAmt', sold.winningPrice === 431000000, String(sold.winningPrice));
check('test1 winningDate comes from maeGiil', sold.winningDate === '2026-09-03', sold.winningDate);
check('test1 appraisedPrice carried', sold.appraisedPrice === 416500000);
check('test1 failedCount carried', sold.failedCount === 1);

// ---------------------------------------------------------------------------
console.log('\n=== TEST 2: an unsold row must not invent a price ===\n');

const unsold = normalize(UNSOLD);
check('test2 winningPrice is null, not 0', unsold.winningPrice === null, String(unsold.winningPrice));
check('test2 the 기일 is still recorded', unsold.saleDate === '2026-09-03');
check('test2 no addition is made for an unsold row', buildAddition(unsold) === null);

// ---------------------------------------------------------------------------
console.log('\n=== TEST 3: patching an existing case ===\n');

const existing = {
  id: sold.id, caseNumber: '2023타경111644', courtCode: 'B000210',
  appraisedPrice: 416500000, minimumPrice: 416500000,
  winningPrice: null, winningDate: null, failedCount: 1, coverage: cov()
};
const patch = buildPatch(existing, sold);
console.log(JSON.stringify(patch, null, 1));
check('test3 patch carries the winning price', patch.set.winningPrice === 431000000);
check('test3 ratio is computed against 감정가', patch.set.winningRatio === 103.48,
  String(patch.set.winningRatio));
check('test3 status becomes 매각', patch.set.status === '매각');
check('test3 coverage.winning_price is set', patch.set.coverage.winning_price === 1);
check('test3 coverage keeps what was there', patch.set.coverage.base_info === 1);

// ---------------------------------------------------------------------------
console.log('\n=== TEST 4 (deliberate failure): a patch must never clear a held field ===\n');

const rich = {
  id: sold.id, caseNumber: '2023타경111644', courtCode: 'B000210',
  appraisedPrice: 416500000, minimumPrice: 416500000,
  winningPrice: 431000000, winningDate: '2026-09-03', failedCount: 9,
  address: '서울특별시 중구 상세주소', documents: [{ type: '매각물건명세서' }],
  documentCount: 1, coverage: { ...cov(), winning_price: 1, sale_statement: 1 }
};
const noop = buildPatch(rich, sold);
console.log('patch for an already-complete row:', JSON.stringify(noop));
check('test4 no patch when the price is already held', noop === null || !('winningPrice' in (noop.set || {})),
  JSON.stringify(noop));
check('test4 a lower failedCount does not overwrite a higher one',
  !noop || noop.set.failedCount === undefined, JSON.stringify(noop && noop.set));

// A row the source reports with no appraised value must not produce NaN.
const noAppraisal = normalize({ ...SOLD, gamevalAmt: null });
const p2 = buildPatch({ ...existing, appraisedPrice: null }, noAppraisal);
check('test4 missing 감정가 gives a null ratio, not NaN', p2.set.winningRatio === null,
  String(p2.set.winningRatio));

// ---------------------------------------------------------------------------
console.log('\n=== TEST 5: a case canonical has never seen becomes an addition ===\n');

const addition = buildAddition(sold);
check('test5 addition is created for a sold unknown case', !!addition);
check('test5 addition has the id apply-worker-deltas needs',
  addition.id && addition.courtCode && addition.caseNumber);
check('test5 addition carries the price and ratio',
  addition.winningPrice === 431000000 && addition.winningRatio === 103.48,
  `${addition.winningPrice} / ${addition.winningRatio}`);
check('test5 addition is marked with its source',
  addition.source === '대한민국 법원경매정보 매각결과검색');
check('test5 addition coverage records the winning price', addition.coverage.winning_price === 1);

console.log(`\n=== ${failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED'} ===`);
process.exitCode = failures ? 1 : 0;
