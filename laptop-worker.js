const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildPatch, applyPatch } = require('./dual-collector-lib');
const gate = require('./court-gate');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'auctions.json');
const STATS = path.join(ROOT, 'data', 'stats.json');
const STATE = path.join(ROOT, 'data', 'state.json');
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
  if (content == null) { try { fs.unlinkSync(file); } catch {} return; }
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
  let files = 0, patches = 0, additions = 0;
  for (const file of listDeltaFiles(DELTAS)) {
    let payload;
    try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { continue; }
    files++;
    for (const add of payload.additions || []) {
      if (!add?.id || map.has(add.id)) continue;
      const row={...add}; rows.push(row); map.set(row.id,row); additions++;
    }
    for (const patch of payload.patches || []) {
      if (patch?.id) seenIds.add(patch.id);
      const row = map.get(patch.id);
      if (!row) continue;
      applyPatch(row, patch);
      patches++;
    }
  }
  return { files, patches, additions, seenIds };
}

function recentlyChecked(row) {
  const t = Date.parse(row.detailCheckedAt || '');
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < RECENT_SKIP_HOURS * 3600000;
}

const KST_MS = 9 * 3600000;
const kstDay = ms => new Date(ms + KST_MS).toISOString().slice(0, 10);
const RECHECK_MIN_GAP_MS = Number(process.env.EXPIRING_RECHECK_MINUTES || 45) * 60000;

function expiringUncaptured(row) {
  const sd = String(row.saleDate || '');
  if (!sd) return false;
  const now = Date.now();
  return (sd === kstDay(now) || sd === kstDay(now + 86400000)) && !Number(row.winningPrice || 0);
}

function recheckedTooRecently(row) {
  const t = Date.parse(row.detailCheckedAt || '');
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < RECHECK_MIN_GAP_MS;
}

const SAFE_ADD_KEYS = [
  'id','courtCode','courtName','caseNumber','itemNumber','usage','address','regionSido','regionSigungu',
  'buildingName','appraisedPrice','minimumPrice','failedCount','saleDate','decisionDate','status',
  'winningPrice','winningDate','winningRatio','photoCount','documentCount','eventCount','coverage',
  'firstSeenAt','lastSeenAt','source'
];
function sanitizeAddition(row){
  const out={}; for(const k of SAFE_ADD_KEYS) if(row[k]!==undefined) out[k]=row[k];
  out.events=[]; out.components=[]; out.documents=[]; out.buildingList=[]; out.areaList=[]; out.landCategoryList=[];
  return out;
}
function safeDiscoveryStatePatch(state){
  const out={};
  for(const [k,v] of Object.entries(state||{})){
    if(k.startsWith('currentSweep') || k.startsWith('saleNoticeBackfill') || k.startsWith('saleNoticeCourt') || k.startsWith('saleNoticeFailures') || k.startsWith('saleNoticeDeferred') || k.startsWith('propertyHistory')) out[k]=v;
  }
  return out;
}
function mergePatches(list){
  const byId=new Map();
  for(const p of list.filter(Boolean)){
    const prev=byId.get(p.id)||{id:p.id,set:{}};
    prev.set={...prev.set,...(p.set||{})}; byId.set(p.id,prev);
  }
  return [...byId.values()].filter(p=>Object.keys(p.set).length);
}

function runDiscoveryWorker(script, effectiveRows, dataBackup, statsBackup, stateBackup, envPatch){
  const baseMap=new Map(effectiveRows.map(r=>[r.id,r]));
  writeJson(DATA,effectiveRows);
  const env={...process.env,...envPatch};
  const d=spawnSync(process.execPath,[script],{cwd:ROOT,stdio:'inherit',env,timeout:90000,killSignal:'SIGTERM'});
  const after=readJson(DATA)||effectiveRows;
  const afterState=readJson(STATE)||{};
  const additions=after.filter(r=>!baseMap.has(r.id)).map(sanitizeAddition);
  const patches=after.filter(r=>baseMap.has(r.id)).map(r=>buildPatch(baseMap.get(r.id),r)).filter(Boolean);
  const statePatch=safeDiscoveryStatePatch(afterState);
  const status=d.error?.code==='ETIMEDOUT'?'timeout':(d.status===0?'completed':`exit ${d.status}`);
  restore(DATA,dataBackup); restore(STATS,statsBackup); restore(STATE,stateBackup);
  return {after,additions,patches,statePatch,status};
}

function main() {
  const startedAt=new Date().toISOString();
  setStatus({phase:'preparing',message:'GitHub 최신 데이터와 대기 패치를 반영해 수집 후보를 고르는 중',startedAt,batchSize:Number(BATCH_SIZE),error:null});
  if (!fs.existsSync(DATA)) throw new Error('data/auctions.json not found');
  fs.mkdirSync(OUTDIR, { recursive: true });

  const dataBackup = fs.readFileSync(DATA);
  const statsBackup = fs.existsSync(STATS) ? fs.readFileSync(STATS) : null;
  const stateBackup = fs.existsSync(STATE) ? fs.readFileSync(STATE) : null;
  const statsBefore = readJson(STATS)||{};

  let effectiveRows = JSON.parse(dataBackup.toString('utf8'));
  const pending = applyPendingDeltas(effectiveRows);
  if (pending.patches || pending.additions) {
    console.log(`[laptop-worker] pending deltas applied locally: files=${pending.files} patches=${pending.patches} additions=${pending.additions}`);
  }

  let discoveryAdditions=[], discoveryPatches=[], statePatch={}, discoveryStatus='skipped';
  // Unique discovery is the success signal. A notice request can succeed while returning only duplicates,
  // so successfulNotices must never suppress stall recovery.
  const hostedStalled = Number(statsBefore?.lastCollectorCycle?.newUniqueItems||0)===0;
  if (hostedStalled && !gate.status().blocked) {
    setStatus({phase:'discovering',message:'클라우드 신규수집 정체 감지 · 공식 매각공고를 노트북 경로에서 소량 재시도'});
    const current=runDiscoveryWorker('current-court-sweep.js',effectiveRows,dataBackup,statsBackup,stateBackup,{CURRENT_SWEEP_COURTS:'2',CURRENT_SWEEP_NOTICES:'1'});
    effectiveRows=current.after;
    discoveryAdditions.push(...current.additions);
    discoveryPatches.push(...current.patches);
    statePatch={...statePatch,...current.statePatch};
    discoveryStatus=`current:${current.status}`;
    console.log(`[laptop-worker] current discovery=${current.status} additions=${current.additions.length} patches=${current.patches.length}`);

    // Always advance historical sale notices after a duplicate-only current sweep. This route is
    // independent of property-search health and is the safest first fallback for unique discovery.
    if (current.additions.length===0) {
      setStatus({phase:'discovering_history',message:'최신 공고에서 신규 0건 · 공식 과거 매각공고를 노트북 경로로 소량 백필'});
      const history=runDiscoveryWorker('sale-notice-history-worker.js',effectiveRows,dataBackup,statsBackup,stateBackup,{HISTORY_COURTS_PER_RUN:'2',HISTORY_NOTICES_PER_COURT:'1'});
      effectiveRows=history.after;
      discoveryAdditions.push(...history.additions);
      discoveryPatches.push(...history.patches);
      statePatch={...statePatch,...history.statePatch};
      discoveryStatus+=`|history:${history.status}`;
      console.log(`[laptop-worker] history discovery=${history.status} additions=${history.additions.length} patches=${history.patches.length}`);

      // If both notice routes produce no unique rows, try the official property-search route once.
      // No CAPTCHA handling or block evasion is attempted; normal court-gate rules still apply.
      if (history.additions.length===0) {
        setStatus({phase:'discovering_property',message:'매각공고 경로 신규 0건 · 공식 물건검색 과거 경로를 1회 시도'});
        const property=runDiscoveryWorker('property-history-discovery-v2.js',effectiveRows,dataBackup,statsBackup,stateBackup,{HISTORY_COURT_CODE:process.env.HISTORY_COURT_CODE||'B000240'});
        effectiveRows=property.after;
        discoveryAdditions.push(...property.additions);
        discoveryPatches.push(...property.patches);
        statePatch={...statePatch,...property.statePatch};
        discoveryStatus+=`|property:${property.status}`;
        console.log(`[laptop-worker] property discovery=${property.status} additions=${property.additions.length} patches=${property.patches.length}`);
      }
    }
  } else if (hostedStalled) {
    discoveryStatus='court-gate-blocked';
  }

  let invalid = 0, pendingSkipped = 0, recentSkipped = 0;
  let expiringKept = 0, expiredSkipped = 0;
  const candidates = effectiveRows.filter(row => {
    if (!VALID_CASE.test(String(row.caseNumber || '').trim())) { invalid++; return false; }
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
  setStatus({phase:'collecting_details',message:`법원 상세정보 ${Math.min(Number(BATCH_SIZE),candidates.length)}건을 조회 중`,candidates:candidates.length,expiringKept,expiredSkipped,skippedMalformed:invalid,pendingSkipped,recentSkipped,pendingFiles:pending.files,pendingPatches:pending.patches,discoveryStatus,discoveryAdditions:discoveryAdditions.length});

  const beforeRows = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const before = new Map(beforeRows.map(r => [r.id, r]));
  const env = { ...process.env, BATCH_SIZE, SHARD_COUNT: '1', SHARD_INDEX: '0' };
  const run = spawnSync(process.execPath, ['retry-worker.js', 'details'], { cwd: ROOT, stdio: 'inherit', env });

  let detailPatches = [];
  let lastRun = null;
  try {
    const afterRows = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    detailPatches = afterRows.map(r => buildPatch(before.get(r.id) || {}, r)).filter(Boolean);
    lastRun = readJson(STATS)?.latestDetailRun || null;
  } finally {
    restore(DATA, dataBackup); restore(STATS, statsBackup); restore(STATE, stateBackup);
  }

  const patches=mergePatches([...discoveryPatches,...detailPatches]);
  const uniqueAdditions=[...new Map(discoveryAdditions.filter(x=>x?.id).map(x=>[x.id,x])).values()];
  const finishedAt=new Date().toISOString();
  if (!patches.length && !uniqueAdditions.length) {
    console.log('[laptop-worker] no additions or patches; nothing to publish');
    setStatus({phase:run.status?'error':'completed',message:run.status?'이번 회차 상세수집에서 오류 발생':'이번 회차 조회 완료 · 새로 바뀐 필드 없음',finishedAt,lastRun,lastPatchCount:0,discoveryStatus,error:run.status?`exit ${run.status}`:null});
    if (run.status) process.exitCode = run.status;
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const payload = {
    version: 2,
    worker: process.env.WORKER_ID || 'laptop',
    createdAt: new Date().toISOString(),
    batchSize: Number(BATCH_SIZE),
    exitCode: run.status ?? 0,
    discoveryStatus,
    additions: uniqueAdditions,
    patches,
    statePatch
  };
  const out = path.join(OUTDIR, `${stamp}-${process.pid}.json`);
  writeJson(out, payload);
  console.log(`[laptop-worker] additions=${uniqueAdditions.length} patches=${patches.length} file=${path.relative(ROOT, out)}`);
  setStatus({phase:run.status?'error':'completed',message:`이번 회차 완료 · 신규 ${uniqueAdditions.length}건 · 변경 ${patches.length}건`,finishedAt,lastRun,lastPatchCount:patches.length,lastAdditionCount:uniqueAdditions.length,lastPatchFile:path.relative(ROOT,out),discoveryStatus,error:run.status?`exit ${run.status}`:null});
}

try{main()}catch(e){setStatus({phase:'error',message:'노트북 수집기 실행 오류',error:String(e?.message||e),finishedAt:new Date().toISOString()});throw e;}
