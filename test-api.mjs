// Exercises the Pages Functions against a KV stub built from a real export.
// No network, no wrangler: it calls the handlers the way Cloudflare does, so a
// pass means the code that will run at the edge works on real data.
//
//   npm run export:web && node test-api.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = process.env.EXPORT_OUT || path.join(ROOT, 'data', 'export');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  if (!ok) failures++;
};

if (!fs.existsSync(path.join(OUT, 'index.json.gz'))) {
  console.error(`no export at ${OUT}; run "npm run export:web" first`);
  process.exit(2);
}

// --- KV stub, loaded from the export on disk -------------------------------
const store = new Map();
store.set('index:v1', fs.readFileSync(path.join(OUT, 'index.json.gz')));
store.set('stats:v1', fs.readFileSync(path.join(OUT, 'stats.json')));
const index = JSON.parse(zlib.gunzipSync(store.get('index:v1')).toString('utf8'));
store.set('facets:v1', Buffer.from(JSON.stringify(index.facets), 'utf8'));

const regionDir = path.join(OUT, 'region');
if (fs.existsSync(regionDir)) {
  for (const f of fs.readdirSync(regionDir)) {
    store.set(`region:v1:${decodeURIComponent(f.replace(/\.json\.gz$/, ''))}`,
      fs.readFileSync(path.join(regionDir, f)));
  }
}
const detailDir = path.join(OUT, 'detail');
const detailFiles = fs.readdirSync(detailDir);
for (const f of detailFiles) {
  const buf = fs.readFileSync(path.join(detailDir, f));
  store.set(`detail:v1:${JSON.parse(buf.toString('utf8')).id}`, buf);
}

const env = {
  AUCTION_KV: {
    async get(key, type) {
      const buf = store.get(key);
      if (!buf) return null;
      if (type === 'arrayBuffer') return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      if (type === 'json') return JSON.parse(buf.toString('utf8'));
      return buf.toString('utf8');
    }
  }
};

const listMod = await import('./functions/api/auction/list.js');
const detailMod = await import('./functions/api/auction/[id].js');
const statsMod = await import('./functions/api/auction/stats.js');
const facetsMod = await import('./functions/api/auction/facets.js');

const get = (mod, url, params = {}) =>
  mod.onRequestGet({ request: new Request(`https://example.test${url}`), env, params });
const body = async res => ({ status: res.status, json: JSON.parse(await res.text()) });

console.log(`\n=== KV stub: ${store.size} keys, ${index.count} rows ===\n`);

// --- stats ------------------------------------------------------------------
{
  const { status, json } = await body(await get(statsMod, '/api/auction/stats'));
  check('stats returns 200', status === 200, String(status));
  check('stats carries itemCount', Number(json.itemCount) > 0, String(json.itemCount));
  check('stats carries the risk numbers',
    'atRiskToday' in json && 'permanentlyLost' in json && 'winningPriceCaptured' in json,
    `atRisk=${json.atRiskToday} lost=${json.permanentlyLost} won=${json.winningPriceCaptured}`);
  check('stats carries coverage percentages', typeof json.coverage?.base_info?.percent === 'number',
    `base_info ${json.coverage?.base_info?.percent}%`);
}

// --- facets -----------------------------------------------------------------
let firstSido, firstUsage;
{
  const { status, json } = await body(await get(facetsMod, '/api/auction/facets'));
  firstSido = json.sido?.[0];
  firstUsage = json.usage?.find(Boolean);
  check('facets returns 200', status === 200, String(status));
  check('facets list 시/도', Array.isArray(json.sido) && json.sido.length > 0, `${json.sido?.length} 개`);
  check('facets map 시군구 per 시/도', Object.keys(json.sigungu || {}).length > 0,
    `${Object.keys(json.sigungu || {}).length} 개`);
}

// --- list -------------------------------------------------------------------
let sampleId;
{
  const { status, json } = await body(await get(listMod, '/api/auction/list?size=5'));
  sampleId = json.items?.[0]?.id;
  check('list returns 200', status === 200, String(status));
  check('list honours size', json.items.length === 5, String(json.items.length));
  check('list reports the full total', json.total === index.count, `${json.total} vs ${index.count}`);
  check('list items are objects, not arrays', typeof json.items[0] === 'object' && !Array.isArray(json.items[0]));
  check('list card has the fields a card needs',
    ['id', 'caseNumber', 'address', 'appraisedPrice', 'minimumPrice', 'saleDate', 'failedCount']
      .every(k => k in json.items[0]));
  const size = JSON.stringify(json).length;
  check('list page is far under the 500KB cap', size < 512000, `${(size / 1024).toFixed(1)}KB`);
}

{
  const { json } = await body(await get(listMod, `/api/auction/list?sido=${encodeURIComponent(firstSido)}&size=3`));
  check('list filters by 시/도', json.items.every(i => i.sido === firstSido),
    `${json.total} in ${firstSido}`);
}
{
  const { json } = await body(await get(listMod, '/api/auction/list?minPrice=100000000&maxPrice=200000000&size=5'));
  check('list filters by price band',
    json.items.every(i => i.minimumPrice >= 100000000 && i.minimumPrice <= 200000000),
    `${json.total} between 1억 and 2억`);
}
{
  const { json } = await body(await get(listMod, '/api/auction/list?sort=minimumPrice&order=desc&size=5'));
  const prices = json.items.map(i => Number(i.minimumPrice || 0));
  check('list sorts descending', prices.every((p, i) => i === 0 || prices[i - 1] >= p), prices.join(' > '));
}
{
  const a = await body(await get(listMod, '/api/auction/list?page=1&size=10'));
  const b = await body(await get(listMod, '/api/auction/list?page=2&size=10'));
  check('list pages do not overlap',
    !a.json.items.some(x => b.json.items.some(y => y.id === x.id)));
}
{
  const { status } = await body(await get(listMod, '/api/auction/list?sort=nonsense'));
  check('list rejects an unknown sort with 400', status === 400, String(status));
}
{
  const { status } = await body(await get(listMod, '/api/auction/list?minPrice=abc'));
  check('list rejects a non-numeric price with 400', status === 400, String(status));
}

// --- detail -----------------------------------------------------------------
{
  const { status, json } = await body(await get(detailMod, `/api/auction/${encodeURIComponent(sampleId)}`,
    { id: encodeURIComponent(sampleId) }));
  check('detail returns 200', status === 200, String(status));
  check('detail is the case asked for', json.id === sampleId, json.id);
  check('detail carries the full address (not the card version)',
    typeof json.address === 'string' && json.address.length > 0);
  check('detail carries events and coverage', Array.isArray(json.events) && typeof json.coverage === 'object');
  const size = JSON.stringify(json).length;
  check('detail is under the cap', size < 512000, `${(size / 1024).toFixed(1)}KB`);
}
{
  const { status, json } = await body(await get(detailMod, '/api/auction/nope', { id: 'nope' }));
  check('detail 404s an unknown id', status === 404, `${status} ${json.error}`);
}

// A merged/duplicate case: the composite 사건번호 that broke filename-based keys.
{
  const merged = [...store.keys()].find(k => k.startsWith('detail:v1:') && /\(중복\)|\(병합\)/.test(k));
  if (merged) {
    const id = merged.replace('detail:v1:', '');
    const { status, json } = await body(await get(detailMod,
      `/api/auction/${encodeURIComponent(id)}`, { id: encodeURIComponent(id) }));
    check('detail serves a merged/duplicate case', status === 200 && json.id === id,
      `${status} ${id.slice(0, 60)}…`);
  } else {
    check('detail serves a merged/duplicate case', true, 'none present in this export');
  }
}

// --- a missing binding must not 500 blindly ---------------------------------
{
  const res = await statsMod.onRequestGet({ env: {} });
  check('a missing KV binding answers 503, not a crash', res.status === 503, String(res.status));
}

console.log(`\n=== ${failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED'} ===`);
process.exitCode = failures ? 1 : 0;
