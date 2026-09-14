// 기일 임박 사건을 다시 훑어 **새로 저장하기로 한 필드**를 채운다.
//
// 왜 필요한가: 2026-09-14 에 상세 응답에서 꺼내 쓰기로 한 항목들(접수일·개시결정일·
// 배당요구종기·권리관계·감정 요항·점유/임차인현황)은 전에는 버리고 있었다. 원문을
// 어디에도 저장하지 않으므로 **소급 재추출이 불가능하고 재수집만이 방법**이다.
//
// ★canonical 을 쓰지 않는다. photo-worker.js 와 같은 규약으로, 스크래치 사본에 대고
//   detail-enrich 를 돌린 뒤 차이만 델타로 발행한다 - 상세 수집기가 canonical 을 쥐고
//   있는 동안에도 안전하다.
// ★관문을 공유한다. 상세 수집기·사진 수집기와 같은 속도 안에서 순번을 받는다.
//
//   NODE_OPTIONS=--require ./court-gate-enforce.js node refresh-worker.js
//   REFRESH_DAYS=7 REFRESH_BATCH=12 node refresh-worker.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const gate = require('./court-gate');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'auctions.json');
const OUTDIR = path.join(ROOT, 'data', 'worker-deltas', process.env.WORKER_ID || 'laptop');
const STATUS = path.join(ROOT, 'data', 'refresh-status.json');
const DAYS = Math.max(1, Number(process.env.REFRESH_DAYS || 7));
const BATCH = Math.max(1, Number(process.env.REFRESH_BATCH || 12));

/* 이번에 새로 채우기로 한 필드. 이 중 하나라도 비어 있으면 아직 안 훑은 사건이다. */
const NEW_KEYS = [
  'caseReceivedDate', 'caseStartDate', 'distributionDeadline', 'courtDept', 'courtDeptTel',
  'caseSuspendCode', 'caseSuspendReason', 'rights', 'appraisalPoints', 'minimumPriceRounds',
  'bidPeriodFrom', 'bidPeriodTo', 'salePlace', 'decisionPlace', 'depositRate',
  'occupancy', 'lessees', 'lesseeCount',
];

const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const kstDay = (ms) => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);

/**
 * 아직 새 필드를 못 받은 사건 중, 기일이 가까운 순.
 *
 * ★"훑었는가"의 판정은 detailCheckedAt 이 아니라 **새 필드가 들어왔는가**로 한다.
 *   그 전에 훑은 사건은 detailCheckedAt 이 최근이어도 새 필드가 없다.
 */
function candidates(rows) {
  const today = kstDay(Date.now());
  const until = kstDay(Date.now() + DAYS * 86400000);
  const filled = (r) => NEW_KEYS.some((k) => {
    const v = r[k];
    return Array.isArray(v) ? v.length > 0 : (v !== undefined && v !== null && v !== '');
  });
  return rows
    .filter((r) => r.status !== 'expired')
    .filter((r) => { const d = String(r.saleDate || ''); return d >= today && d <= until; })
    .filter((r) => !filled(r))
    .sort((a, b) => String(a.saleDate).localeCompare(String(b.saleDate)))
    .slice(0, BATCH);
}

function main() {
  const startedAt = new Date().toISOString();

  if (gate.status().blocked) {
    writeJson(STATUS, { at: startedAt, phase: 'skipped', why: 'court gate is latched' });
    console.error('[refresh] court gate is latched; not starting');
    process.exitCode = 12;
    return;
  }

  const rows = readJson(DATA, null);
  if (!Array.isArray(rows)) throw new Error('data/auctions.json missing or not an array');

  const shortlist = candidates(rows);
  const today = kstDay(Date.now());
  const until = kstDay(Date.now() + DAYS * 86400000);
  const scope = rows.filter((r) => r.status !== 'expired')
    .filter((r) => { const d = String(r.saleDate || ''); return d >= today && d <= until; }).length;

  if (!shortlist.length) {
    writeJson(STATUS, { at: startedAt, phase: 'idle', why: 'nothing left in window', windowDays: DAYS, scope });
    console.log(JSON.stringify({ ok: true, checked: 0, scope, note: 'window fully refreshed' }, null, 2));
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-worker-'));
  const scratchData = path.join(scratch, 'auctions.json');
  const scratchStats = path.join(scratch, 'stats.json');
  const before = new Map(shortlist.map((r) => [r.id, JSON.parse(JSON.stringify(r))]));

  /* detailCheckedAt 을 지워 보낸다 - detail-enrich 의 "최근에 봤으면 건너뛴다" 규칙에
     걸려 한 건도 안 훑고 끝나는 것을 막는다. 원본 canonical 은 건드리지 않는다. */
  writeJson(scratchData, shortlist.map((r) => { const c = { ...r }; delete c.detailCheckedAt; return c; }));
  writeJson(scratchStats, {});

  const env = {
    ...process.env,
    AUCTIONS_FILE: scratchData,
    STATS_FILE: scratchStats,
    BATCH_SIZE: String(shortlist.length),
    SHARD_COUNT: '1',
    SHARD_INDEX: '0',
    COURT_LOCK_WAIT_MS: process.env.COURT_LOCK_WAIT_MS || '300000',
  };
  const run = spawnSync(process.execPath, [path.join(ROOT, 'detail-enrich.js')], { cwd: ROOT, stdio: 'inherit', env });

  const after = readJson(scratchData, []);
  const stats = readJson(scratchStats, {});

  /* dual-collector-lib 의 키 목록은 상세 수집용이라 이번 필드들을 모른다 - 여기서 명시한다. */
  const CARRY = NEW_KEYS.concat(['coverage', 'events', 'eventCount', 'documents', 'documentCount',
    'appraisalSummary', 'appraisalDate', 'appraisalAgency', 'claimAmount', 'components',
    'landArea', 'buildingArea', 'minimumPrice', 'failedCount', 'status', 'caseType',
    'winningPrice', 'winningDate', 'winningRatio', 'bidderCount', 'saleResult',
    'goodsStatusCode', 'decisionDate', 'caseProgressCode', 'caseClosedDivision', 'caseClosedDate',
    'saleStatementAvailable', 'statusReportAvailable', 'detailCheckedAt', 'expiredAt']);

  const patches = [];
  for (const row of after) {
    const prev = before.get(row.id);
    if (!prev) continue;
    const set = {};
    for (const k of CARRY) if (!same(prev[k], row[k])) set[k] = row[k] ?? null;
    if (Object.keys(set).length) patches.push({ id: row.id, set });
  }

  fs.rmSync(scratch, { recursive: true, force: true });

  const gained = after.filter((r) => r.rights || r.occupancy || (r.appraisalPoints || []).length).length;
  const finishedAt = new Date().toISOString();
  const status = {
    at: finishedAt, phase: run.status === 0 ? 'completed' : `exit ${run.status}`,
    windowDays: DAYS, scope, checked: shortlist.length, withNewFields: gained,
    patches: patches.length, lastRun: stats.latestDetailRun || null,
    gate: gate.status().blocked ? 'latched' : 'open',
  };

  if (!patches.length) {
    writeJson(STATUS, { ...status, published: null });
    console.log(JSON.stringify({ ok: run.status === 0, ...status, published: null }, null, 2));
    if (gate.status().blocked) process.exitCode = 12;
    return;
  }

  fs.mkdirSync(OUTDIR, { recursive: true });
  const file = path.join(OUTDIR, `${finishedAt.replace(/[:.]/g, '-')}-refresh-${patches.length}.json`);
  writeJson(file, {
    version: 1, worker: 'laptop:refresh', createdAt: finishedAt,
    source: '대한민국 법원경매정보', patches, additions: [],
  });

  writeJson(STATUS, { ...status, published: path.relative(ROOT, file) });
  console.log(JSON.stringify({ ok: run.status === 0, ...status, published: path.relative(ROOT, file) }, null, 2));
  if (gate.status().blocked) process.exitCode = 12;
}

try { main(); } catch (e) {
  console.error(e?.stack || e?.message || String(e));
  process.exitCode = process.exitCode || 1;
}
