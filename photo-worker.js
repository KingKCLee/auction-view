// One photo pass that never writes canonical.
//
// photo-enrich.js edits data/auctions.json in place. That is safe when it is the
// only writer and unsafe here: the laptop detail collector owns that file for the
// length of its own cycle, and two processes rewriting a 27MB array will lose
// each other's work. So this runs photo-enrich against a scratch copy holding
// only the rows we want photographed, diffs the result, and publishes a worker
// delta - the same contract laptop-worker.js uses for details.
//
// Images are written straight into the real photos/ directory: they are new
// files, never edits, so there is nothing to race over.
//
//   NODE_OPTIONS=--require ./court-gate-enforce.js node photo-worker.js
//   PHOTO_BATCH=8 node photo-worker.js
//
// Exit 0 published or nothing to do, 12 the gate stopped us, 1 broken.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const gate = require('./court-gate');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'auctions.json');
const OUTDIR = path.join(ROOT, 'data', 'worker-deltas', process.env.WORKER_ID || 'laptop');
const STATUS = path.join(ROOT, 'data', 'photo-status.json');
const BATCH = Math.max(1, Number(process.env.PHOTO_BATCH || 8));

// The photo fields dual-collector-lib does not carry - it was written for detail
// enrichment and its key set stops at coverage.
const PHOTO_KEYS = ['photoUrls', 'photoCount', 'photoSource', 'photoCheckedAt'];

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Same ordering photo-enrich uses, applied here so the scratch copy is already
// the shortlist: least-covered court first, then nearest 기일, never a row we
// looked at in the last six hours.
function candidates(rows) {
  const now = Date.now();
  const perCourt = new Map();
  for (const r of rows) {
    const c = String(r.courtCode || '');
    if (!c) continue;
    perCourt.set(c, (perCourt.get(c) || 0) + ((r.photoUrls?.length || 0) > 0 ? 1 : 0));
  }
  const recent = r => {
    const t = Date.parse(r.photoCheckedAt || '');
    return Number.isFinite(t) && now - t < 6 * 3600 * 1000;
  };
  // Measured 2026-09-10, the whole reason coverage sat at 0.5%: the inherited
  // ordering was "least-covered court, then nearest 기일", and a plain string
  // sort puts the OLDEST dates first. Those cases are gone - the source drops a
  // case the day after its 기일 and answers 200 with an empty dma_result, so the
  // pass spent its requests on rows that can never return a photo. Probed side
  // by side: an expired case came back with no csPicLst at all, a case with a
  // future 기일 came back with 28 photos. Only ask for what the source still has.
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  return rows
    .filter(r => (r.photoUrls?.length || 0) === 0)
    .filter(r => r.status !== 'expired')
    .filter(r => String(r.saleDate || '') >= today)
    .filter(r => !recent(r))
    .sort((a, b) => {
      const ca = Number(perCourt.get(String(a.courtCode || '')) || 0);
      const cb = Number(perCourt.get(String(b.courtCode || '')) || 0);
      if (ca !== cb) return ca - cb;
      return String(a.saleDate || '').localeCompare(String(b.saleDate || ''));
    })
    .slice(0, BATCH);
}

function main() {
  const startedAt = new Date().toISOString();

  if (gate.status().blocked) {
    writeJson(STATUS, { at: startedAt, phase: 'skipped', why: 'court gate is latched' });
    console.error('[photo-worker] court gate is latched; not starting a pass');
    process.exitCode = 12;
    return;
  }

  const rows = readJson(DATA, null);
  if (!Array.isArray(rows)) throw new Error('data/auctions.json missing or not an array');

  const shortlist = candidates(rows);
  if (!shortlist.length) {
    writeJson(STATUS, { at: startedAt, phase: 'idle', why: 'no row needs photos right now' });
    console.log(JSON.stringify({ ok: true, checked: 0, note: 'nothing to do' }, null, 2));
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-worker-'));
  const scratchData = path.join(scratch, 'auctions.json');
  const scratchStats = path.join(scratch, 'stats.json');
  const before = new Map(shortlist.map(r => [r.id, JSON.parse(JSON.stringify(r))]));

  writeJson(scratchData, shortlist);
  writeJson(scratchStats, {});

  const env = {
    ...process.env,
    AUCTIONS_FILE: scratchData,
    STATS_FILE: scratchStats,
    PHOTO_ROOT: path.join(ROOT, 'photos'),
    BATCH_SIZE: String(shortlist.length),
    SHARD_COUNT: '1',
    SHARD_INDEX: '0',
    // The detail collector holds the gate lock through its own pacing wait, so a
    // fail-fast photo pass would only ever see COURT_BUSY. Wait for a turn.
    COURT_LOCK_WAIT_MS: process.env.COURT_LOCK_WAIT_MS || '180000'
  };

  const run = spawnSync(process.execPath, [path.join(ROOT, 'photo-enrich.js')], { cwd: ROOT, stdio: 'inherit', env });

  const after = readJson(scratchData, []);
  const stats = readJson(scratchStats, {});
  const lastRun = stats.latestPhotoRun || null;

  const patches = [];
  for (const row of after) {
    const prev = before.get(row.id);
    if (!prev) continue;
    const set = {};
    for (const key of PHOTO_KEYS) if (!same(prev[key], row[key])) set[key] = row[key] ?? null;
    if (row.coverage && !same(prev.coverage, row.coverage)) set.coverage = row.coverage;
    if (Object.keys(set).length) patches.push({ id: row.id, set });
  }

  fs.rmSync(scratch, { recursive: true, force: true });

  const withPhotos = after.filter(r => (r.photoUrls?.length || 0) > 0).length;
  const finishedAt = new Date().toISOString();
  const status = {
    at: finishedAt,
    phase: run.status === 0 ? 'completed' : `exit ${run.status}`,
    checked: shortlist.length,
    rowsWithPhotos: withPhotos,
    patches: patches.length,
    lastRun,
    gate: gate.status().blocked ? 'latched' : 'open'
  };

  if (!patches.length) {
    writeJson(STATUS, { ...status, published: null });
    console.log(JSON.stringify({ ok: run.status === 0, ...status, published: null }, null, 2));
    if (gate.status().blocked) process.exitCode = 12;
    return;
  }

  fs.mkdirSync(OUTDIR, { recursive: true });
  const file = path.join(OUTDIR, `${finishedAt.replace(/[:.]/g, '-')}-photos-${patches.length}.json`);
  writeJson(file, {
    version: 1,
    worker: 'laptop:photos',
    createdAt: finishedAt,
    source: '대한민국 법원경매정보',
    patches,
    additions: []
  });

  writeJson(STATUS, { ...status, published: path.relative(ROOT, file) });
  console.log(JSON.stringify({ ok: run.status === 0, ...status, published: path.relative(ROOT, file) }, null, 2));
  if (gate.status().blocked) process.exitCode = 12;
}

try {
  main();
} catch (e) {
  console.error(e?.stack || e?.message || String(e));
  process.exitCode = process.exitCode || 1;
}
