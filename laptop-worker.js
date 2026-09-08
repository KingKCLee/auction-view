const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildPatch, applyPatch } = require('./dual-collector-lib');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'auctions.json');
const STATS = path.join(ROOT, 'data', 'stats.json');
const STATUS = path.join(ROOT, 'data', 'laptop-status.json');
const DELTAS = path.join(ROOT, 'data', 'worker-deltas');
const OUTDIR = path.join(DELTAS, process.env.WORKER_ID || 'laptop');
const BATCH_SIZE = String(process.env.BATCH_SIZE || 12);
const RECENT_SKIP_HOURS = Number(process.env.DETAIL_RECHECK_HOURS || 12);
const VALID_CASE = /^\d{4}타경\d+$/;

const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
function setStatus(patch){
  const prev=readJson(STATUS)||{};
  writeJson(STATUS,{...prev,...patch,updatedAt:new Date().toISOString()});
}

function restore(file, content) {
  if (content == null) return;
  fs.writeFileSync(file, content);
}

function listDeltaFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...listDeltaFiles(p));
    else if (name.endsWith('.json')) out.push(p);
  }
  return out.sort();
}

function applyPendingDeltas(rows) {
  const map = new Map(rows.map(r => [r.id, r]));
  const seenIds = new Set();
  let files = 0, patches = 0;
  for (const file of listDeltaFiles(DELTAS)) {
    let payload;
    try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { continue; }
    files++;
    for (const patch of payload.patches || []) {
      if (patch?.id) seenIds.add(patch.id);
      const row = map.get(patch.id);
      if (!row) continue;
      applyPatch(row, patch);
      patches++;
    }
  }
  return { files, patches, seenIds };
}

function recentlyChecked(row) {
  const t = Date.parse(row.detailCheckedAt || '');
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < RECENT_SKIP_HOURS * 3600000;
}

// A case whose 기일 is today has no result to read in the morning - the auction
// has not happened yet - and it is gone from the source tomorrow. So it must stay
// re-checkable all day, which means neither the 12h recheck skip nor the
// pending-delta skip may exclude it until the winning price is actually in hand.
const KST_MS = 9 * 3600000;
const kstDay = ms => new Date(ms + KST_MS).toISOString().slice(0, 10);
const RECHECK_MIN_GAP_MS = Number(process.env.EXPIRING_RECHECK_MINUTES || 45) * 60000;

function expiringUncaptured(row) {
  const sd = String(row.saleDate || '');
  if (!sd) return false;
  const now = Date.now();
  return (sd === kstDay(now) || sd === kstDay(now + 86400000)) && !Number(row.winningPrice || 0);
}

// Still leave a gap, so one stubborn case cannot be hammered every cycle.
function recheckedTooRecently(row) {
  const t = Date.parse(row.detailCheckedAt || '');
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < RECHECK_MIN_GAP_MS;
}

function main() {
  const startedAt=new Date().toISOString();
  setStatus({phase:'preparing',message:'GitHub 최신 데이터와 대기 패치를 반영해 수집 후보를 고르는 중',startedAt,batchSize:Number(BATCH_SIZE),error:null});
  if (!fs.existsSync(DATA)) throw new Error('data/auctions.json not found');
  fs.mkdirSync(OUTDIR, { recursive: true });

  const dataBackup = fs.readFileSync(DATA);
  const statsBackup = fs.existsSync(STATS) ? fs.readFileSync(STATS) : null;

  const effectiveRows = JSON.parse(dataBackup.toString('utf8'));
  const pending = applyPendingDeltas(effectiveRows);
  if (pending.patches) {
    console.log(`[laptop-worker] pending deltas applied locally: files=${pending.files} patches=${pending.patches}`);
  }

  let invalid = 0, pendingSkipped = 0, recentSkipped = 0;
  let expiringKept = 0, expiredSkipped = 0;
  const candidates = effectiveRows.filter(row => {
    if (!VALID_CASE.test(String(row.caseNumber || '').trim())) { invalid++; return false; }
    // The source has already dropped these; asking again only burns the budget.
    if (row.status === 'expired') { expiredSkipped++; return false; }
    if (expiringUncaptured(row)) {
      if (recheckedTooRecently(row)) { recentSkipped++; return false; }
      expiringKept++;
      return true;
    }
    if (pending.seenIds.has(row.id)) { pendingSkipped++; return false; }
    if (recentlyChecked(row)) { recentSkipped++; return false; }
    return true;
  });
  writeJson(DATA, candidates);
  console.log(`[laptop-worker] candidates=${candidates.length} expiringKept=${expiringKept} expired=${expiredSkipped} skipped malformed=${invalid} pending=${pendingSkipped} recent=${recentSkipped}`);
  setStatus({phase:'collecting_details',message:`법원 상세정보 ${Math.min(Number(BATCH_SIZE),candidates.length)}건을 조회 중`,candidates:candidates.length,expiringKept,expiredSkipped,skippedMalformed:invalid,pendingSkipped,recentSkipped,pendingFiles:pending.files,pendingPatches:pending.patches});

  const beforeRows = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const before = new Map(beforeRows.map(r => [r.id, r]));

  const env = { ...process.env, BATCH_SIZE, SHARD_COUNT: '1', SHARD_INDEX: '0' };
  const run = spawnSync(process.execPath, ['retry-worker.js', 'details'], {
    cwd: ROOT,
    stdio: 'inherit',
    env
  });

  let patches = [];
  let lastRun = null;
  try {
    const afterRows = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    patches = afterRows.map(r => buildPatch(before.get(r.id) || {}, r)).filter(Boolean);
    lastRun = readJson(STATS)?.latestDetailRun || null;
  } finally {
    restore(DATA, dataBackup);
    restore(STATS, statsBackup);
  }

  const finishedAt=new Date().toISOString();
  if (!patches.length) {
    console.log('[laptop-worker] patches=0; nothing to publish');
    setStatus({phase:run.status?'error':'completed',message:run.status?'이번 회차 상세수집에서 오류 발생':'이번 회차 조회 완료 · 새로 바뀐 필드 없음',finishedAt,lastRun,lastPatchCount:0,error:run.status?`exit ${run.status}`:null});
    if (run.status) process.exitCode = run.status;
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    version: 1,
    worker: process.env.WORKER_ID || 'laptop',
    createdAt: new Date().toISOString(),
    batchSize: Number(BATCH_SIZE),
    exitCode: run.status ?? 0,
    patches
  };
  const out = path.join(OUTDIR, `${stamp}-${process.pid}.json`);
  writeJson(out, payload);
  console.log(`[laptop-worker] patches=${patches.length} file=${path.relative(ROOT, out)}`);
  setStatus({phase:run.status?'error':'completed',message:`이번 회차 완료 · ${patches.length}건 변경사항 생성`,finishedAt,lastRun,lastPatchCount:patches.length,lastPatchFile:path.relative(ROOT,out),error:run.status?`exit ${run.status}`:null});
}

try{main()}catch(e){setStatus({phase:'error',message:'노트북 수집기 실행 오류',error:String(e?.message||e),finishedAt:new Date().toISOString()});throw e;}
