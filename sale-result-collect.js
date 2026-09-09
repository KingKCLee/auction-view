// Collects winning prices from 매각결과검색, the only window that publishes them.
//
// The case-detail endpoint never carries a winning price: measured 2026-09-09, a
// 매각 event there has 최저매각가 and a result code but dspslAmt is null, and the
// case is gone the day after its 기일 anyway. 매각결과검색 is a different window -
// it answers for 기일 that have already passed, and its rows carry maeAmt as a
// real number:
//
//   2025타경1833   기일 20260908  감정 51,005,255,120  낙찰 26,627,100,000
//   2023타경111644 기일 20260903  감정    416,500,000  낙찰    431,000,000
//
// So a winning price is not a same-day race. It is a backfill over the last few
// days, which is what this does.
//
//   node sale-result-collect.js                 # every court, resuming
//   COURTS=B000210,B000240 node sale-result-collect.js
//   MAX_REQUESTS=60 node sale-result-collect.js
//
// Always run it under the gate enforcer:
//   NODE_OPTIONS=--require ./court-gate-enforce.js node sale-result-collect.js

const fs = require('fs');
const path = require('path');
const gate = require('./court-gate');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'auctions.json');
const STATE = path.join(ROOT, 'data', 'sale-result-state.json');
const OUTDIR = path.join(ROOT, 'data', 'worker-deltas', process.env.WORKER_ID || 'laptop');

const BASE = 'https://www.courtauction.go.kr';
const SEARCH = '/pgj/pgjsearch/selectDspslSchdRsltSrch.on';
const WARM = '/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ158M00.xml&pgjId=158M00';
// 40 is the server's limit; 100 comes back HTTP 400 with the generic
// "사용에 불편을 드려서 죄송합니다" message, which means bad parameters, not an outage.
const PAGE_SIZE = 40;
const MAX_REQUESTS = Number(process.env.MAX_REQUESTS || 400);
const MAX_PAGES_PER_COURT = Number(process.env.MAX_PAGES_PER_COURT || 12);

const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); };
const txt = v => (v == null ? '' : String(v).trim());
const int = v => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? Math.trunc(n) : null; };
const isoDate = v => { const s = String(v || '').replace(/[^0-9]/g, ''); return s.length >= 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null; };

let cookie = '';
let requests = 0;

async function warmup() {
  const { res } = await gate.request(BASE + WARM, {
    headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html,*/*', 'accept-language': 'ko-KR,ko;q=0.9' }
  }, { owner: 'sale-result:warmup', timeoutMs: 20000 });
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  if (sc.length) cookie = sc.map(x => x.split(';')[0]).join('; ');
  requests++;
  if (!res.ok) throw new Error(`warmup HTTP ${res.status}`);
}

async function searchPage(courtCode, pageNo) {
  if (!cookie) await warmup();
  const body = {
    dma_pageInfo: {
      pageNo: String(pageNo), pageSize: String(PAGE_SIZE),
      bfPageNo: '', startRowNo: '', totalCnt: '', totalYn: 'Y', groupTotalCount: ''
    },
    dma_srchGdsDtlSrchInfo: {
      statNum: '3', pgmId: 'PGJ158M02', cortStDvs: '1',
      cortOfcCd: courtCode, jdbnCd: '', csNo: '',
      rprsAdongSdCd: '', rprsAdongSggCd: '', rprsAdongEmdCd: '',
      rdnmSdCd: '', rdnmSggCd: '', rdnmNo: '',
      auctnGdsStatCd: '', lclDspslGdsLstUsgCd: '', mclDspslGdsLstUsgCd: '', sclDspslGdsLstUsgCd: '',
      dspslAmtMin: '', dspslAmtMax: '', aeeEvlAmtMin: '', aeeEvlAmtMax: '',
      flbdNcntMin: '', flbdNcntMax: ''
    }
  };
  const { res, text } = await gate.request(BASE + SEARCH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=UTF-8', accept: 'application/json,*/*',
      'user-agent': 'Mozilla/5.0', 'accept-language': 'ko-KR,ko;q=0.9',
      referer: BASE + WARM, cookie, 'sc-userid': 'SYSTEM', 'sc-pgmid': 'PGJ158M02'
    },
    body: JSON.stringify(body)
  }, { owner: `sale-result:${courtCode}`, timeoutMs: 25000 });
  requests++;

  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`non-json ${res.status}`); }
  if (j?.data?.ipcheck === false) throw new Error('BLOCKED by court site');
  if (!res.ok) {
    const msg = j?.errors?.errorMessage || `HTTP ${res.status}`;
    const e = new Error(`${courtCode} p${pageNo}: ${msg}`);
    e.badRequest = res.status === 400;
    throw e;
  }
  return {
    rows: j?.data?.dlt_srchResult || [],
    total: Number(j?.data?.dma_pageInfo?.totalCnt || 0)
  };
}

// One result row -> the fields canonical keeps. Only what the window actually gives.
function normalize(r) {
  const courtCode = txt(r.boCd);
  const caseNumber = txt(r.srnSaNo || r.printCsNo || r.saNo);
  const itemNumber = txt(r.maemulSer || r.mokmulSer || 1);
  if (!courtCode || !caseNumber) return null;
  const winningPrice = int(r.maeAmt);
  const appraisedPrice = int(r.gamevalAmt);
  return {
    id: `${courtCode}|${caseNumber}|${itemNumber}`,
    courtCode, courtName: txt(r.jiwonNm), caseNumber, itemNumber,
    winningPrice: winningPrice && winningPrice > 0 ? winningPrice : null,
    winningDate: isoDate(r.maeGiil),
    appraisedPrice, minimumPrice: int(r.minmaePrice),
    failedCount: int(r.yuchalCnt) || 0,
    saleDate: isoDate(r.maeGiil),
    address: txt(r.printSt || r.realSt || r.convAddr),
    usage: txt(r.dspslUsgNm),
    buildingName: txt(r.buldNm),
    status: txt(r.mulStatcd)
  };
}

// A patch only ever adds a winning price and the numbers that come with it. It
// never clears a field canonical already holds.
function buildPatch(existing, found) {
  const set = {};
  if (found.winningPrice && Number(existing.winningPrice || 0) !== found.winningPrice) {
    set.winningPrice = found.winningPrice;
    set.winningDate = found.winningDate;
    const appraised = Number(existing.appraisedPrice || found.appraisedPrice || 0);
    set.winningRatio = appraised ? Math.round((found.winningPrice / appraised) * 10000) / 100 : null;
    set.status = '매각';
    set.coverage = { ...(existing.coverage || {}), winning_price: 1 };
  }
  if (found.failedCount > Number(existing.failedCount || 0)) set.failedCount = found.failedCount;
  if (!existing.appraisedPrice && found.appraisedPrice) set.appraisedPrice = found.appraisedPrice;
  if (found.minimumPrice && Number(existing.minimumPrice || 0) !== found.minimumPrice) set.minimumPrice = found.minimumPrice;
  return Object.keys(set).length ? { id: found.id, set } : null;
}

// A case the source shows a result for but canonical has never seen. Worth keeping:
// once this window closes, nowhere else publishes it.
function buildAddition(found) {
  if (!found.winningPrice) return null;
  const now = new Date().toISOString();
  return {
    ...found,
    winningRatio: found.appraisedPrice ? Math.round((found.winningPrice / found.appraisedPrice) * 10000) / 100 : null,
    status: '매각',
    regionSido: '', regionSigungu: '', propertyDescription: '',
    eventCount: 0, photoCount: 0, documentCount: 0,
    events: [], components: [], documents: [],
    coverage: {
      base_info: 1, schedule: 0, winning_price: 1, photos: 0, status_report: 0,
      sale_statement: 0, appraisal_summary: 0, appraisal_pdf: 0,
      transactions: 0, building_registry: 0, land_use: 0, rights: 0
    },
    firstSeenAt: now, lastSeenAt: now,
    source: '대한민국 법원경매정보 매각결과검색'
  };
}

async function main() {
  const rows = readJson(DATA, []);
  if (!Array.isArray(rows) || !rows.length) throw new Error('canonical data/auctions.json missing or empty');
  const byId = new Map(rows.map(r => [r.id, r]));

  const courts = (process.env.COURTS
    ? process.env.COURTS.split(',').map(s => s.trim()).filter(Boolean)
    : [...new Set(rows.map(r => txt(r.courtCode)).filter(Boolean))]).sort();

  const state = readJson(STATE, { cursor: 0, lastRun: null });
  const patches = [];
  const additions = [];
  const seen = new Set();
  let scanned = 0, sold = 0, courtsDone = 0, lastError = null;

  const started = new Date().toISOString();
  let i = Number(state.cursor || 0) % courts.length;

  while (courtsDone < courts.length && requests < MAX_REQUESTS) {
    const courtCode = courts[i];
    i = (i + 1) % courts.length;
    courtsDone++;

    for (let page = 1; page <= MAX_PAGES_PER_COURT; page++) {
      if (requests >= MAX_REQUESTS) break;
      let res;
      try {
        res = await searchPage(courtCode, page);
      } catch (e) {
        lastError = `${courtCode} p${page}: ${e.message}`;
        console.error('[sale-result] ' + lastError);
        if (/BLOCKED/.test(e.message) || e.code === 'COURT_BLOCKED') throw e;
        cookie = '';
        break;
      }
      for (const raw of res.rows) {
        const found = normalize(raw);
        if (!found || seen.has(found.id)) continue;
        seen.add(found.id);
        scanned++;
        if (found.winningPrice) sold++;
        const existing = byId.get(found.id);
        if (existing) {
          const p = buildPatch(existing, found);
          if (p) patches.push(p);
        } else {
          const a = buildAddition(found);
          if (a) additions.push(a);
        }
      }
      if (res.rows.length < PAGE_SIZE || page * PAGE_SIZE >= res.total) break;
    }
    state.cursor = i;
  }

  const summary = {
    startedAt: started, finishedAt: new Date().toISOString(),
    courts: courts.length, courtsScanned: courtsDone,
    requests, scannedRows: scanned, soldRows: sold,
    patches: patches.length, additions: additions.length,
    lastError
  };

  if (patches.length || additions.length) {
    fs.mkdirSync(OUTDIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(OUTDIR, `${stamp}-saleresult-${process.pid}.json`);
    writeJson(file, {
      version: 1, worker: `${process.env.WORKER_ID || 'laptop'}:sale-result`,
      createdAt: new Date().toISOString(), source: 'selectDspslSchdRsltSrch',
      patches, additions
    });
    summary.deltaFile = path.relative(ROOT, file);
  }

  state.lastRun = summary;
  writeJson(STATE, state);
  console.log(JSON.stringify(summary, null, 2));
}

module.exports = { normalize, buildPatch, buildAddition };

if (require.main === module) {
  main().catch(e => {
    console.error(`[sale-result] ${e.code || ''} ${e.message || e}`);
    process.exitCode = /BLOCKED/.test(String(e.message)) || e.code === 'COURT_BLOCKED' ? 9 : 1;
  });
}
