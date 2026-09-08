// Measures how much of 대한민국 법원경매정보 is publicly readable at a given moment.
//
// The order that prompted this expected to bisect 2025 -> 2020 -> 2015 -> 2010 for
// the oldest published case. Measurement showed there is nothing to bisect: the
// site publishes a case only while its 기일 is still pending, and drops it the day
// after. So this script measures the actual boundary instead of a year ladder:
//
//   1. 매각공고 (searchSaleNotices) for previous / current / next month
//   2. 사건상세 (selectAuctnCsSrchRslt) for sale dates around today
//   3. the forward window and its volume, from canonical
//
// Read-only. Same pacing as the collectors. Any block signal aborts the run - no
// retry, no rotation, no bypass.
//
//   node measure-public-window.js
//   PROBE_COURTS=B000210,B000240 node measure-public-window.js

const fs = require('fs');
const path = require('path');
const lib = require('court-auction-notice-search');

const BASE = 'https://www.courtauction.go.kr';
const DATA = path.join(__dirname, 'data', 'auctions.json');
const OUT = process.env.WINDOW_OUT || path.join(__dirname, 'public-window-report.json');
const PROBE_COURTS = String(process.env.PROBE_COURTS || 'B000210,B000240').split(',').filter(Boolean);
const DAY_OFFSETS = String(process.env.DAY_OFFSETS || '-2,-1,0,1,2,7')
  .split(',').map(Number).filter(Number.isFinite);
const PER_DAY = Number(process.env.CASES_PER_DAY || 2);
const MIN_DELAY = Number(process.env.PROBE_MIN_DELAY || 3400);
const VALID_CASE = /^\d{4}타경\d+$/;
const BLOCK = /BLOCKED|ipcheck\s*=\s*false|captcha|access denied|접근이 차단/i;

let cookie = '', lastCall = 0, blocked = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const dayStr = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const shift = (base, days) => dayStr(new Date(Date.parse(base) + days * 86400000));
// The court's calendar is KST, so "today" must be KST - a UTC date is a day behind
// for most of the Korean working day and shifts the whole boundary by one.
const todayKst = () => dayStr(new Date(Date.now() + 9 * 3600000));

async function throttle() {
  const w = Math.max(0, MIN_DELAY - (Date.now() - lastCall)) + Math.floor(Math.random() * 700);
  if (w) await sleep(w);
  lastCall = Date.now();
}
async function tf(url, opts = {}, ms = 18000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); } finally { clearTimeout(t); }
}
async function warmup() {
  await throttle();
  const r = await tf(`${BASE}/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml&pgjId=151F00`, {
    headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html,*/*', 'accept-language': 'ko-KR,ko;q=0.9' }
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  if (sc.length) cookie = sc.map(x => x.split(';')[0]).join('; ');
  if (!r.ok) throw new Error('warmup HTTP ' + r.status);
}
async function post(url, body) {
  if (!cookie) await warmup();
  await throttle();
  const r = await tf(BASE + url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=UTF-8', accept: 'application/json,*/*',
      'user-agent': 'Mozilla/5.0', 'accept-language': 'ko-KR,ko;q=0.9',
      referer: `${BASE}/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml`,
      cookie, 'sc-userid': 'SYSTEM', 'sc-pgmid': 'PGJ151F01'
    },
    body: JSON.stringify(body)
  });
  const raw = await r.text();
  let j; try { j = JSON.parse(raw); } catch { throw new Error('non-json ' + r.status); }
  if (j?.data?.ipcheck === false) throw new Error('BLOCKED by court site');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return j;
}
const caseDetail = row => post('/pgj/pgj15B/selectAuctnCsSrchRslt.on', {
  dma_srchGdsDtlSrch: {
    csNo: String(row.caseNumber), cortOfcCd: String(row.courtCode || ''),
    dspslGdsSeq: Number(row.itemNumber || 1), pgmId: 'PGJ151F01'
  }
});

function checkBlock(where, msg) {
  if (BLOCK.test(msg)) { blocked = { where, detail: msg, at: new Date().toISOString() }; return true; }
  return false;
}

async function probeNotices(monthKey, courtCode) {
  const client = new lib.CourtAuctionHttpClient({
    timeoutMs: 35000, minDelayMs: 3000, jitterMs: 1200, maxCallsPerSession: 6
  });
  try {
    const r = await lib.searchSaleNotices({ date: monthKey, courtCode, bidType: 'date', client, includeRaw: true });
    const items = r?.items || [];
    return { month: monthKey, courtCode, count: items.length, saleDates: [...new Set(items.map(x => x.saleDate))].sort() };
  } catch (e) {
    const msg = `${e?.code || ''}:${e?.message || e}`;
    checkBlock(`notices ${monthKey} ${courtCode}`, msg);
    return { month: monthKey, courtCode, error: msg };
  } finally {
    if (typeof client.close === 'function') { try { await client.close(); } catch {} }
    await sleep(1500);
  }
}

async function probeDetailForDay(rows, saleDate) {
  const picks = rows.filter(r => r.saleDate === saleDate && VALID_CASE.test(String(r.caseNumber || '').trim()))
    .slice(0, PER_DAY);
  const results = [];
  for (const row of picks) {
    if (blocked) break;
    try {
      const j = await caseDetail(row);
      const res = j?.data?.dma_result || {};
      const events = res.gdsDspslDxdyLst || res.dspslDxdyLst || [];
      results.push({
        caseNumber: row.caseNumber,
        resultKeys: Object.keys(res).length,
        events: events.length,
        appraisalItems: (res.aeeWevlMnpntLst || []).length,
        objectItems: (res.gdsDspslObjctLst || []).length,
        published: Object.keys(res).length > 0
      });
    } catch (e) {
      const msg = String(e.message || e);
      results.push({ caseNumber: row.caseNumber, error: msg });
      if (checkBlock(`detail ${saleDate}`, msg)) break;
      cookie = '';
    }
  }
  const answered = results.filter(r => !r.error);
  return {
    saleDate,
    probed: results.length,
    published: answered.filter(r => r.published).length,
    purged: answered.filter(r => !r.published).length,
    results
  };
}

function canonicalWindow(rows, today) {
  const byDate = {};
  for (const r of rows) if (r.saleDate) byDate[r.saleDate] = (byDate[r.saleDate] || 0) + 1;
  const dates = Object.keys(byDate).sort();
  const live = rows.filter(r => r.saleDate >= today);
  const forwardDays = dates.length
    ? Math.round((Date.parse(dates[dates.length - 1]) - Date.parse(today)) / 86400000) + 1
    : 0;
  const perDay = forwardDays > 0 ? live.length / forwardDays : 0;
  return {
    canonicalRows: rows.length,
    byDate,
    stillPublished: live.length,
    alreadyPurged: rows.length - live.length,
    forwardWindowDays: forwardDays,
    lastSaleDate: dates[dates.length - 1] || null,
    itemsPerDay: Math.round(perDay),
    annualThroughputEstimate: Math.round(perDay * 250),
    estimateBasis: '250 business days; single 13-day forward window, no seasonality modelled'
  };
}

async function main() {
  const today = todayKst();
  const rows = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const report = {
    startedAt: new Date().toISOString(), today,
    notices: [], detailByDay: [], canonical: canonicalWindow(rows, today),
    boundary: null, blocked: null
  };

  const thisMonth = today.slice(0, 7);
  const prevMonth = shift(`${thisMonth}-01`, -1).slice(0, 7);
  const nextMonth = shift(`${thisMonth}-28`, 10).slice(0, 7);
  for (const court of PROBE_COURTS) {
    for (const mk of [prevMonth, thisMonth, nextMonth]) {
      if (blocked) break;
      const r = await probeNotices(mk, court);
      report.notices.push(r);
      console.log(`[notices] ${court} ${mk} count=${r.count ?? r.error}`);
    }
  }

  for (const off of DAY_OFFSETS) {
    if (blocked) break;
    const d = shift(today, off);
    const r = await probeDetailForDay(rows, d);
    report.detailByDay.push({ offset: off, ...r });
    console.log(`[detail] ${d} (오늘${off >= 0 ? '+' : ''}${off}) probed=${r.probed} published=${r.published} purged=${r.purged}`);
  }

  const answered = report.detailByDay.filter(d => d.probed > 0);
  const firstPublished = answered.find(d => d.published > 0);
  const lastPurged = [...answered].reverse().find(d => d.purged > 0 && d.published === 0);
  report.boundary = {
    oldestStillPublished: firstPublished ? firstPublished.saleDate : null,
    newestAlreadyPurged: lastPurged ? lastPurged.saleDate : null,
    rule: firstPublished && firstPublished.saleDate === today
      ? 'a case is readable only while its 기일 is today or later'
      : 'see detailByDay'
  };

  report.blocked = blocked;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n[window] boundary=${JSON.stringify(report.boundary)}`);
  console.log(`[window] stillPublished=${report.canonical.stillPublished} alreadyPurged=${report.canonical.alreadyPurged} forwardDays=${report.canonical.forwardWindowDays}`);
  console.log(`[window] out=${path.relative(__dirname, OUT)}`);
  if (blocked) {
    console.error('[window] STOPPED: court signalled blocking.');
    console.error(JSON.stringify(blocked, null, 2));
    process.exitCode = 9;
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
