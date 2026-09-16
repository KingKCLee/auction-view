// GET /api/auction/list
//
// The only way anything reads the auction list. Nothing client-side ever touches
// data/auctions.json - it is 21MB and would stall or fail on a phone.
//
// Query: sido, sigungu, usage, minPrice, maxPrice (won, against 최저가),
//        saleDateFrom, saleDateTo, hasWinning=1|0, q (free text over 사건번호/소재지),
//        sort=saleDate|minimumPrice|appraisedPrice|failedCount, order=asc|desc,
//        page (1-based), size (default 20, max 100)
//
// Reads one gzipped blob from KV and filters in the worker, so a query is a
// single KV round trip regardless of how many filters are set.

import { json, badRequest, loadIndex, cardToObject, RESPONSE_CAP } from '../_lib.js';

const SORTS = {
  saleDate: 'saleDate',
  minimumPrice: 'minimumPrice',
  appraisedPrice: 'appraisedPrice',
  failedCount: 'failedCount'
};

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = url.searchParams;

  const page = Math.max(1, Number(q.get('page') || 1));
  const size = Math.min(100, Math.max(1, Number(q.get('size') || 20)));
  const sortKey = SORTS[q.get('sort') || 'saleDate'];
  if (!sortKey) return badRequest(`sort must be one of ${Object.keys(SORTS).join(', ')}`);
  const desc = (q.get('order') || 'asc').toLowerCase() === 'desc';

  const minPrice = q.get('minPrice') ? Number(q.get('minPrice')) : null;
  const maxPrice = q.get('maxPrice') ? Number(q.get('maxPrice')) : null;
  if ((minPrice !== null && !Number.isFinite(minPrice)) || (maxPrice !== null && !Number.isFinite(maxPrice))) {
    return badRequest('minPrice and maxPrice must be numbers (won)');
  }

  // [2026-09-14] 카드에 이미 실려 있는데 거를 수 없던 축들. 새 필드를 싣지 않으므로
  // index 블롭 크기는 그대로다(409KB / 500KB 상한 - 여유가 많지 않다).
  const minAppraised = q.get('minAppraised') ? Number(q.get('minAppraised')) : null;
  const maxAppraised = q.get('maxAppraised') ? Number(q.get('maxAppraised')) : null;
  if ((minAppraised !== null && !Number.isFinite(minAppraised)) || (maxAppraised !== null && !Number.isFinite(maxAppraised))) {
    return badRequest('minAppraised and maxAppraised must be numbers (won)');
  }
  const minFailed = q.get('minFailed') ? Number(q.get('minFailed')) : null;
  const maxFailed = q.get('maxFailed') ? Number(q.get('maxFailed')) : null;
  if ((minFailed !== null && !Number.isFinite(minFailed)) || (maxFailed !== null && !Number.isFinite(maxFailed))) {
    return badRequest('minFailed and maxFailed must be numbers');
  }

  let index;
  try {
    index = await loadIndex(env, q.get('sido'));
  } catch (e) {
    return json({ error: 'index unavailable', detail: String(e.message || e) }, 503);
  }

  const sido = q.get('sido');
  const sigungu = q.get('sigungu');
  // 물건종류는 여러 개를 한 번에 고를 수 있다(체크박스). 쉼표로 온다.
  // 한 개만 오면 전과 같이 동작하므로 기존 링크는 그대로 산다.
  const usageList = (q.get('usage') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const courtList = (q.get('court') || '').split(',').map((x) => x.trim()).filter(Boolean);
  const from = q.get('saleDateFrom');
  const to = q.get('saleDateTo');
  const hasWinning = q.get('hasWinning');
  const text = (q.get('q') || '').trim();

  const F = index.fields;
  const iSido = F.indexOf('sido'), iSigungu = F.indexOf('sigungu'), iUsage = F.indexOf('usage');
  const iMin = F.indexOf('minimumPrice'), iSale = F.indexOf('saleDate');
  const iWin = F.indexOf('hasWinning'), iCase = F.indexOf('caseNumber'), iAddr = F.indexOf('address');
  const iApr = F.indexOf('appraisedPrice'), iFail = F.indexOf('failedCount'), iCourt = F.indexOf('courtName');

  const matched = index.rows.filter(r => {
    if (sido && r[iSido] !== sido) return false;
    if (sigungu && r[iSigungu] !== sigungu) return false;
    if (usageList.length && usageList.indexOf(r[iUsage]) < 0) return false;
    if (courtList.length && courtList.indexOf(r[iCourt]) < 0) return false;
    if (minAppraised !== null && !(Number(r[iApr] || 0) >= minAppraised)) return false;
    if (maxAppraised !== null && !(Number(r[iApr] || 0) <= maxAppraised)) return false;
    if (minFailed !== null && !(Number(r[iFail] || 0) >= minFailed)) return false;
    if (maxFailed !== null && !(Number(r[iFail] || 0) <= maxFailed)) return false;
    if (minPrice !== null && !(Number(r[iMin] || 0) >= minPrice)) return false;
    if (maxPrice !== null && !(Number(r[iMin] || 0) <= maxPrice)) return false;
    if (from && String(r[iSale] || '') < from) return false;
    if (to && String(r[iSale] || '') > to) return false;
    if (hasWinning === '1' && r[iWin] !== 1) return false;
    if (hasWinning === '0' && r[iWin] === 1) return false;
    if (text && !`${r[iCase]} ${r[iAddr]}`.includes(text)) return false;
    return true;
  });

  const iSort = F.indexOf(sortKey);
  matched.sort((a, b) => {
    const x = a[iSort], y = b[iSort];
    const cmp = typeof x === 'number' || typeof y === 'number'
      ? Number(x || 0) - Number(y || 0)
      : String(x || '').localeCompare(String(y || ''));
    return desc ? -cmp : cmp;
  });

  const total = matched.length;
  const items = matched.slice((page - 1) * size, page * size).map(r => cardToObject(F, r));

  /*
   * [2026-09-16] 상태별 건수 - **이 페이지가 아니라 걸러진 전체**를 센다.
   * 화면 상단 요약 배너가 쓴다. 한 페이지(20건)만 세면 "검색결과 387건"과 배지 숫자가
   * 어긋나 사람이 둘 중 어느 쪽을 믿어야 할지 모르게 된다.
   * ★우리 canonical 에 실제로 있는 축만 센다(실측: status 는 76%가 빈값이고
   *   변경·취하·기각·정지 같은 값은 **존재하지 않는다**). 가를 수 있는 것은 셋뿐이다:
   *     낙찰   = 낙찰가가 있다
   *     유찰   = 낙찰가가 없고 유찰 횟수가 1 이상
   *     진행중 = 둘 다 아니다
   * 이미 필터를 통과한 행들만 도므로 비용은 한 번의 순회다.
   */
  let won = 0, failed = 0, ongoing = 0;
  for (const r of matched) {
    if (Number(r[iWin]) === 1) won++;
    else if (Number(r[iFail] || 0) > 0) failed++;
    else ongoing++;
  }

  const body = {
    generatedAt: index.generatedAt,
    page, size, total,
    totalPages: Math.max(1, Math.ceil(total / size)),
    statusCounts: { won, failed, ongoing },
    facets: index.facets || undefined,
    items
  };

  // A page of cards is small, but the cap is enforced rather than assumed.
  const encoded = JSON.stringify(body);
  if (encoded.length > RESPONSE_CAP) {
    return json({ error: 'response too large', bytes: encoded.length, cap: RESPONSE_CAP }, 500);
  }
  return json(body, 200, { 'cache-control': 'public, max-age=60' });
}
