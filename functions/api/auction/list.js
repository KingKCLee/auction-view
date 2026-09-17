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

  let index;
  try {
    index = await loadIndex(env, q.get('sido'));
  } catch (e) {
    return json({ error: 'index unavailable', detail: String(e.message || e) }, 503);
  }

  const sido = q.get('sido');
  const sigungu = q.get('sigungu');
  const usage = q.get('usage');
  const from = q.get('saleDateFrom');
  const to = q.get('saleDateTo');
  const hasWinning = q.get('hasWinning');
  const text = (q.get('q') || '').trim();

  const F = index.fields;
  const iSido = F.indexOf('sido'), iSigungu = F.indexOf('sigungu'), iUsage = F.indexOf('usage');
  const iMin = F.indexOf('minimumPrice'), iSale = F.indexOf('saleDate');
  const iWin = F.indexOf('hasWinning'), iCase = F.indexOf('caseNumber'), iAddr = F.indexOf('address');

  const matched = index.rows.filter(r => {
    if (sido && r[iSido] !== sido) return false;
    if (sigungu && r[iSigungu] !== sigungu) return false;
    if (usage && r[iUsage] !== usage) return false;
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

  const body = {
    generatedAt: index.generatedAt,
    page, size, total,
    totalPages: Math.max(1, Math.ceil(total / size)),
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
