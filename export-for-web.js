// Turns canonical into the small payloads the web reads.
//
// The screens must never fetch data/auctions.json - it is 21MB and a phone will
// either stall or fail on it. Everything the UI needs comes from here:
//
//   index.json.gz   one gzipped, positional-array blob of every card row, so a
//                   list query is a single KV read and the filtering happens in
//                   the Function rather than across dozens of round trips
//   detail/<id>.json  one file per case, read only when a case is opened
//   stats.json      the admin numbers
//   manifest.json   what was written, with sizes
//
// Every object is checked against a hard size cap and the run fails rather than
// publishing something the UI cannot load.
//
//   node export-for-web.js
//   MAX_OBJECT_BYTES=512000 node export-for-web.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = process.env.EXPORT_ROOT || __dirname;
const DATA = path.join(ROOT, 'data', 'auctions.json');
const STATS = path.join(ROOT, 'data', 'stats.json');
const ALERT = path.join(ROOT, 'data', 'collection-alert.json');
/* 노트북 수집기의 실제 상태. stats.latestDetailRun 은 **호스티드(Actions) 상세 실행**이
   쓰는 자리라 노트북 상태가 아니다 - 그것을 노트북 것으로 내보내던 탓에 진도율 화면이
   09-10 에 멈춘 값을 보여 주고 있었다(2026-09-14 실측: 라이브 표시 "노트북 마지막 성공
   09-10 14:12 · 성공 0 · fetch failed", 같은 시각 실제 노트북은 checked 24 / success 24). */
const LAPTOP = path.join(ROOT, 'data', 'laptop-status.json');
const OUT = process.env.EXPORT_OUT || path.join(ROOT, 'data', 'export');

// The cap the order asks for: nothing the web reads may exceed this.
const MAX_OBJECT_BYTES = Number(process.env.MAX_OBJECT_BYTES || 512000);

const KST_MS = 9 * 3600000;
const kstDay = ms => new Date(ms + KST_MS).toISOString().slice(0, 10);
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const int = v => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };
const str = v => (v == null ? '' : String(v));

class PayloadTooLarge extends Error {
  constructor(name, bytes, cap) {
    super(`${name} is ${bytes} bytes, over the ${cap} byte cap for anything the web reads`);
    this.code = 'PAYLOAD_TOO_LARGE';
    this.name_ = name; this.bytes = bytes; this.cap = cap;
  }
}

// Card fields, positional so the blob stays small. The Function knows this order.
const CARD_FIELDS = [
  'id', 'caseNumber', 'courtName', 'address', 'sido', 'sigungu', 'usage',
  'appraisedPrice', 'minimumPrice', 'saleDate', 'failedCount',
  'hasWinning', 'photoCount', 'documentCount'
];

// Card addresses drop the "[상세내역] ..." building schedule the source appends.
// It averages 165 characters against 29 without it and is the single reason the
// whole-dataset blob blew past the cap; the full text stays on the detail record.
const CARD_ADDRESS_MAX = 120;
const cardAddress = v => str(v).split('[상세내역]')[0].trim().slice(0, CARD_ADDRESS_MAX);

const toCard = r => [
  str(r.id), str(r.caseNumber), str(r.courtName), cardAddress(r.address),
  str(r.regionSido), str(r.regionSigungu), str(r.usage),
  int(r.appraisedPrice), int(r.minimumPrice), str(r.saleDate), int(r.failedCount) || 0,
  Number(r.winningPrice || 0) > 0 ? 1 : 0,
  int(r.photoCount) || 0, int(r.documentCount) || 0
];

// Detail keeps everything a case page shows, minus the bulk we never render.
const toDetail = r => ({
  id: r.id, caseNumber: r.caseNumber, itemNumber: r.itemNumber,
  courtCode: r.courtCode, courtName: r.courtName,
  address: r.address, regionSido: r.regionSido, regionSigungu: r.regionSigungu,
  usage: r.usage, caseType: r.caseType || null, buildingName: r.buildingName || null,
  propertyDescription: r.propertyDescription || null,
  appraisedPrice: int(r.appraisedPrice), minimumPrice: int(r.minimumPrice),
  claimAmount: int(r.claimAmount),
  saleDate: r.saleDate, failedCount: int(r.failedCount) || 0,
  status: r.status || null,
  winningPrice: int(r.winningPrice), winningDate: r.winningDate || null,
  winningRatio: r.winningRatio ?? null, bidderCount: int(r.bidderCount),
  saleResult: r.saleResult || null,
  caseClosedDate: r.caseClosedDate || null, expiredAt: r.expiredAt || null,
  appraisalSummary: r.appraisalSummary || null,
  appraisalDate: r.appraisalDate || null, appraisalAgency: r.appraisalAgency || null,
  landArea: r.landArea ?? null, buildingArea: r.buildingArea ?? null,
  events: Array.isArray(r.events) ? r.events : [],
  components: Array.isArray(r.components) ? r.components.slice(0, 40) : [],
  documents: Array.isArray(r.documents) ? r.documents : [],
  documentCount: int(r.documentCount) || 0,
  photoCount: int(r.photoCount) || 0,
  photos: Array.isArray(r.photoUrls) ? r.photoUrls.slice(0, 20) : [],
  coverage: r.coverage || {},
  /* [2026-09-15] 상세 화면 2·3·4·5·6 섹션이 쓰는 축. 여기 없으면 canonical 에
     들어와 있어도 화면까지 못 간다 - 실제로 그랬다(재수집으로 356건을 채워 놓고도
     상세가 빈 채였다). 값이 없는 사건은 null/빈배열로 나가고 화면이 자리를 정한다. */
  caseReceivedDate: r.caseReceivedDate || null,
  caseStartDate: r.caseStartDate || null,
  distributionDeadline: r.distributionDeadline || null,
  courtDept: r.courtDept || null, courtDeptTel: r.courtDeptTel || null,
  caseSuspendCode: r.caseSuspendCode || null, caseSuspendReason: r.caseSuspendReason || null,
  rights: r.rights || null,
  appraisalPoints: Array.isArray(r.appraisalPoints) ? r.appraisalPoints : [],
  minimumPriceRounds: Array.isArray(r.minimumPriceRounds) ? r.minimumPriceRounds : [],
  bidPeriodFrom: r.bidPeriodFrom || null, bidPeriodTo: r.bidPeriodTo || null,
  salePlace: r.salePlace || null, decisionPlace: r.decisionPlace || null,
  decisionDate: r.decisionDate || null, depositRate: r.depositRate ?? null,
  occupancy: r.occupancy || null,
  /* 임차인은 이름을 가린 채로만 나간다(detail-enrich 가 가려서 저장한다).
     주민등록번호 계열(enrrno)은 애초에 저장하지 않으므로 여기 올 수 없다. */
  lessees: Array.isArray(r.lessees) ? r.lessees : [],
  lesseeCount: r.lesseeCount ?? null,
  detailCheckedAt: r.detailCheckedAt || null,
  source: r.source || null
});

function writeChecked(file, buf, name, cap = MAX_OBJECT_BYTES) {
  if (buf.length > cap) throw new PayloadTooLarge(name, buf.length, cap);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf.length;
}

function buildStats(rows, stats, alert, laptop) {
  const today = kstDay(Date.now());
  const cov = stats?.coverage || {};
  const total = rows.length;
  const pct = n => (total ? Math.round((Number(n || 0) / total) * 1000) / 10 : 0);
  const captured = rows.filter(r => Number(r.winningPrice || 0) > 0).length;
  const atRisk = rows.filter(r => r.saleDate === today && !Number(r.winningPrice || 0)).length;
  const lost = rows.filter(r => r.saleDate && r.saleDate < today && !Number(r.winningPrice || 0)).length;
  /* 상위 stats.coverage 를 쓰지 않고 여기서 센다 - 마스터가 그 키를 아직 안 낼 수도 있고,
     "몇 건에 실제로 들어 있나"는 canonical 이 답이다. */
  const rights = rows.filter(r => r.rights).length;
  const occupancy = rows.filter(r => r.occupancy).length;
  return {
    generatedAt: new Date().toISOString(),
    today,
    itemCount: total,
    expiredMarked: rows.filter(r => r.status === 'expired').length,
    coverage: {
      base_info: { count: cov.base_info || 0, percent: pct(cov.base_info) },
      sale_statement: { count: cov.sale_statement || 0, percent: pct(cov.sale_statement) },
      status_report: { count: cov.status_report || 0, percent: pct(cov.status_report) },
      appraisal_summary: { count: cov.appraisal_summary || 0, percent: pct(cov.appraisal_summary) },
      photos: { count: cov.photos || 0, percent: pct(cov.photos) },
      winning_price: { count: captured, percent: pct(captured) },
      /* [2026-09-15] 재수집으로 새로 채우는 축. 소급 재추출이 불가능해 재수집만이
         방법이므로, 얼마나 찼는지 화면에서 보여야 진도를 볼 수 있다. */
      rights: { count: rights, percent: pct(rights) },
      occupancy: { count: occupancy, percent: pct(occupancy) }
    },
    documentCount: Number(stats?.documentCount || 0),
    winningPriceCaptured: captured,
    atRiskToday: atRisk,
    permanentlyLost: lost,
    lastCloudMergeAt: stats?.generatedAt || null,
    /* 노트북은 델타로 발행하므로 stats 에 자기 회차를 남기지 않는다 - 자기 상태 파일을 읽는다.
       없으면 옛 자리로 떨어지되, 그 값이 호스티드 실행 것임을 아는 채로 쓴다. */
    lastLaptopRunAt: laptop?.lastRun?.finishedAt || laptop?.updatedAt || stats?.latestDetailRun?.finishedAt || null,
    lastLaptopRun: laptop?.lastRun || stats?.latestDetailRun || null,
    lastLaptopPhase: laptop?.phase || null,
    alert: alert ? { at: alert.at, newlyLostSinceLastRun: alert.newlyLostSinceLastRun ?? null } : null
  };
}

function main() {
  const rows = readJson(DATA, null);
  if (!Array.isArray(rows)) throw new Error('canonical data/auctions.json missing or not an array');
  const stats = readJson(STATS, {});
  const alert = readJson(ALERT, null);
  const laptop = readJson(LAPTOP, null);

  // laptop-worker truncates canonical to its candidate subset for the duration of
  // a cycle. Exporting then would publish a shrunken database to the live site.
  const prev = readJson(path.join(OUT, 'manifest.json'), null);
  const prevCount = Number(prev?.itemCount || 0);
  if (prevCount && rows.length < prevCount * 0.9) {
    const e = new Error(`canonical looks mid-cycle: ${rows.length} rows against ${prevCount} last export`);
    e.code = 'CANONICAL_INCOMPLETE';
    throw e;
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'detail'), { recursive: true });

  // --- the one blob every list query reads -------------------------------
  const cards = rows.map(toCard);
  const sidos = [...new Set(rows.map(r => str(r.regionSido)).filter(Boolean))].sort();
  const usages = [...new Set(rows.map(r => str(r.usage)).filter(Boolean))].sort();
  /* [2026-09-14] 법원 선택지. 카드에 courtName 이 이미 실려 있어 거를 수는 있었는데
     화면이 고를 목록을 받을 곳이 없었다 - 값 목록만 더한다(행 크기는 그대로다). */
  const courts = [...new Set(rows.map(r => str(r.courtName)).filter(Boolean))].sort();
  const sigungu = {};
  for (const r of rows) {
    const s = str(r.regionSido), g = str(r.regionSigungu);
    if (!s || !g) continue;
    (sigungu[s] = sigungu[s] || new Set()).add(g);
  }
  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    fields: CARD_FIELDS,
    count: cards.length,
    facets: {
      sido: sidos,
      sigungu: Object.fromEntries(Object.entries(sigungu).map(([k, v]) => [k, [...v].sort()])),
      usage: usages,
      court: courts
    },
    rows: cards
  };
  const indexGz = zlib.gzipSync(Buffer.from(JSON.stringify(index), 'utf8'), { level: 9 });
  const indexBytes = writeChecked(path.join(OUT, 'index.json.gz'), indexGz, 'index.json.gz');

  // Per-region shards too. The Function prefers the whole-set blob, but a region
  // shard keeps a single query serviceable if the set ever outgrows the cap.
  const shardBytes = {};
  for (const sido of sidos) {
    const subset = cards.filter(c => c[CARD_FIELDS.indexOf('sido')] === sido);
    const buf = zlib.gzipSync(Buffer.from(JSON.stringify({
      version: 1, generatedAt: index.generatedAt, fields: CARD_FIELDS, sido,
      count: subset.length, rows: subset
    }), 'utf8'), { level: 9 });
    shardBytes[sido] = writeChecked(
      path.join(OUT, 'region', `${encodeURIComponent(sido)}.json.gz`), buf, `region/${sido}.json.gz`);
  }

  // --- stats ---------------------------------------------------------------
  const statsPayload = buildStats(rows, stats, alert, laptop);
  const statsBytes = writeChecked(
    path.join(OUT, 'stats.json'),
    Buffer.from(JSON.stringify(statsPayload), 'utf8'), 'stats.json');

  // --- one file per case ---------------------------------------------------
  // Filenames are a hash of the id, not the id itself. Merged/duplicate cases carry
  // composite 사건번호 ("...31597 (중복) ... (병합)") whose percent-encoded form runs
  // past the Windows path limit. The real id travels inside the file, and the
  // uploader reads it back to build the KV key - KV keys have no such limit.
  let detailBytes = 0, biggest = { name: null, bytes: 0 };
  for (const r of rows) {
    const detail = toDetail(r);
    const buf = Buffer.from(JSON.stringify(detail), 'utf8');
    const file = `${crypto.createHash('sha1').update(String(r.id)).digest('hex')}.json`;
    detailBytes += writeChecked(path.join(OUT, 'detail', file), buf, `detail/${file}`);
    if (buf.length > biggest.bytes) biggest = { name: `detail/${file}`, id: r.id, bytes: buf.length };
  }

  const manifest = {
    generatedAt: index.generatedAt,
    maxObjectBytes: MAX_OBJECT_BYTES,
    itemCount: rows.length,
    objects: {
      'index.json.gz': indexBytes,
      'stats.json': statsBytes,
      regionShards: shardBytes,
      detailFiles: rows.length,
      detailTotalBytes: detailBytes,
      largestDetail: biggest
    }
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(JSON.stringify(manifest, null, 2));
  console.log(`\n[export] index ${(indexBytes / 1024).toFixed(1)}KB of a ${(MAX_OBJECT_BYTES / 1024).toFixed(0)}KB cap; ${rows.length} detail files, largest ${(biggest.bytes / 1024).toFixed(1)}KB`);
}

module.exports = { toCard, toDetail, buildStats, writeChecked, PayloadTooLarge, CARD_FIELDS, MAX_OBJECT_BYTES };

if (require.main === module) {
  try { main(); }
  catch (e) {
    console.error(`[export] FAILED: ${e.message}`);
    process.exitCode = e.code === 'PAYLOAD_TOO_LARGE' ? 7 : e.code === 'CANONICAL_INCOMPLETE' ? 8 : 1;
  }
}
