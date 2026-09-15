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
const { gradeRights } = require('./rights-grade');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = process.env.EXPORT_ROOT || __dirname;
/* 입력 자리를 바꿀 수 있게 둔다(detail-enrich·photo-enrich 와 같은 규약).
   노트북에서 창고 판 canonical 로 웹 내보내기를 돌릴 때 쓴다 - 작업본 canonical 은
   수집기가 쥐고 쓰는 중이라 중간 상태일 수 있어 그것으로 화면을 만들면 안 된다. */
const DATA = process.env.AUCTIONS_FILE || path.join(ROOT, 'data', 'auctions.json');
const STATS = process.env.STATS_FILE || path.join(ROOT, 'data', 'stats.json');
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
  'hasWinning', 'photoCount', 'documentCount',
  /* [2026-09-15] 목록 카드의 썸네일 한 장. 사진 URL 을 통째로 싣지 않고 **뒤 두 조각**만
     싣는다(`<물건번호>/<파일명>`) - 앞부분은 사건번호라 카드가 이미 들고 있다.
     실측: gzip 433.1KB → 439.0KB (상한 500KB). 사진 있는 사건은 434건뿐이라 나머지는 빈 칸. */
  'thumb'
];

// Card addresses drop the "[상세내역] ..." building schedule the source appends.
// It averages 165 characters against 29 without it and is the single reason the
// whole-dataset blob blew past the cap; the full text stays on the detail record.
const CARD_ADDRESS_MAX = 120;
const cardAddress = v => str(v).split('[상세내역]')[0].trim().slice(0, CARD_ADDRESS_MAX);

/**
 * 목록 썸네일 - 첫 사진의 경로에서 `photos/` 접두어만 뗀 것.
 *
 * 사건번호 조각을 빼고 화면이 합쳐 복원하는 방법도 재 봤다(gzip 438.0KB vs 440.0KB).
 * 2KB 를 아끼자고 복원 로직을 두지 않는다 - 사건번호가 "…(중복)" 처럼 공백을 품는 경우가
 * 실제로 있고(전체 968건), 그때 복원이 조용히 어긋난다. 지금은 그런 사건에 사진이 0건이라
 * 안 드러날 뿐이다. 상한(500KB)까지 60KB 가 남아 있으므로 안전한 쪽을 고른다.
 */
const cardThumb = (r) => {
  const u = (Array.isArray(r.photoUrls) ? r.photoUrls : [])[0];
  return u ? String(u).replace(/^photos\//, '') : '';
};

const toCard = r => [
  str(r.id), str(r.caseNumber), str(r.courtName), cardAddress(r.address),
  str(r.regionSido), str(r.regionSigungu), str(r.usage),
  int(r.appraisedPrice), int(r.minimumPrice), str(r.saleDate), int(r.failedCount) || 0,
  Number(r.winningPrice || 0) > 0 ? 1 : 0,
  int(r.photoCount) || 0, int(r.documentCount) || 0,
  cardThumb(r)
];

// Detail keeps everything a case page shows, minus the bulk we never render.
/**
 * 관련사건 - 같은 물건에 걸린 다른 사건번호.
 *
 * 법원은 중복·병합 사건을 **사건번호 칸 안에** 나열해서 준다:
 *   "2026타경140 2026타경133 2026타경138 (병합)"
 * 별도 필드가 없으므로 그 표기에서 꺼낸다(실측 968건 = 중복 753 · 병합 325).
 * 회생·파산 같은 다른 계열 연계는 우리 원천에 오지 않는다 - 만들지 않는다.
 */
const RELATED_RE = /\(\s*(중복|병합)\s*\)/;
function relatedCases(caseNumber) {
  const raw = str(caseNumber);
  const kind = raw.match(RELATED_RE);
  if (!kind) return [];
  const nums = raw.replace(/\([^)]*\)/g, ' ').split(/\s+/).filter((x) => /타경/.test(x));
  if (nums.length < 2) return [];
  const self = nums[0];
  return nums.slice(1).filter((n) => n !== self).map((n) => ({ caseNumber: n, relation: kind[1] }));
}

/**
 * 인근 낙찰 통계 - 우리 canonical 만으로 계산한다(외부 원천 없음).
 *
 * 시군구×용도로 3건이 안 모이면 시도×용도, 그것도 안 되면 전국×용도로 넓힌다.
 * ★어느 범위로 잰 값인지 반드시 함께 낸다 - "강서구 다세대 66%"와 "전국 다세대
 *   66%"는 다른 말이고, 범위를 감추면 화면이 과장하게 된다.
 * 표본 3건 미만인 칸은 아예 만들지 않는다(실측: 3단계까지 가면 99.98% 가 잡힌다).
 */
const MIN_SAMPLES = 3;
function buildSaleIndex(rows) {
  const idx = new Map();
  const put = (k, r) => { if (!idx.has(k)) idx.set(k, []); idx.get(k).push(r); };
  for (const r of rows) {
    const w = Number(r.winningPrice || 0), a = Number(r.appraisedPrice || 0);
    if (!(w > 0 && a > 0)) continue;
    const u = str(r.usage) || '?';
    if (r.regionSido && r.regionSigungu) put(`시군구|${r.regionSido} ${r.regionSigungu}|${u}`, r);
    if (r.regionSido) put(`시도|${r.regionSido}|${u}`, r);
    put(`전국|전국|${u}`, r);
  }
  return idx;
}
function neighborhoodStats(idx, r) {
  const u = str(r.usage) || '?';
  const tries = [];
  if (r.regionSido && r.regionSigungu) tries.push(['시군구', `${r.regionSido} ${r.regionSigungu}`]);
  if (r.regionSido) tries.push(['시도', str(r.regionSido)]);
  tries.push(['전국', '전국']);
  for (const [level, scope] of tries) {
    const g = idx.get(`${level}|${scope}|${u}`) || [];
    if (g.length < MIN_SAMPLES) continue;
    const ratios = g.map((x) => x.winningPrice / x.appraisedPrice).sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    const avg = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    /* 표본은 최근 낙찰 3건만. 사건 파일 하나가 커지면 KV 상한에 닿는다. */
    const samples = g.slice().sort((a, b) => str(b.winningDate).localeCompare(str(a.winningDate))).slice(0, 3)
      .map((x) => ({
        caseNumber: str(x.caseNumber), address: str(x.address).split('[상세내역]')[0].trim().slice(0, 60),
        usage: str(x.usage), appraisedPrice: int(x.appraisedPrice), winningPrice: int(x.winningPrice),
        winningDate: x.winningDate || null,
        ratio: Math.round((x.winningPrice / x.appraisedPrice) * 1000) / 10,
      }));
    return {
      level, scope, usage: u, count: g.length,
      medianRatio: Math.round(median * 1000) / 10,
      averageRatio: Math.round(avg * 1000) / 10,
      samples,
    };
  }
  return null;
}

const toDetail = (r, ctx) => ({
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
  /* [2026-09-15] 우리가 이미 가진 것인데 화면에 못 내던 두 가지.
     둘 다 canonical 만으로 만든다 - 새 원천을 붙이지 않았다. */
  relatedCases: relatedCases(r.caseNumber),
  /* [2026-09-16] 권리관계 3등급 자동 판정. 명세서가 없으면 null - 등급을 만들지 않는다.
     ★판단을 대신하지 않는다: 등급과 함께 **근거 문장 원문**과 「법률자문 아님」 고지,
       그리고 문서로 가릴 수 없는 항목(유치권 진위·점유·명도)을 함께 내보낸다. */
  rightsGrade: gradeRights(r),
  neighborhoodStats: ctx && ctx.saleIndex ? neighborhoodStats(ctx.saleIndex, r) : null,
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
  /* 낙찰 비교군 색인은 한 번만 만든다 - 사건마다 12,000건을 다시 훑을 일이 아니다. */
  const saleIndex = buildSaleIndex(rows);
  for (const r of rows) {
    const detail = toDetail(r, { saleIndex });
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
