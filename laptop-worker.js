const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildPatch, applyPatch } = require('./dual-collector-lib');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'auctions.json');
const STATS = path.join(ROOT, 'data', 'stats.json');
const DELTAS = path.join(ROOT, 'data', 'worker-deltas');
const OUTDIR = path.join(DELTAS, process.env.WORKER_ID || 'laptop');
const BATCH_SIZE = String(process.env.BATCH_SIZE || 12);

const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

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
  let files = 0, patches = 0;
  for (const file of listDeltaFiles(DELTAS)) {
    let payload;
    try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { continue; }
    files++;
    for (const patch of payload.patches || []) {
      const row = map.get(patch.id);
      if (!row) continue;
      applyPatch(row, patch);
      patches++;
    }
  }
  return { files, patches };
}

function main() {
  if (!fs.existsSync(DATA)) throw new Error('data/auctions.json not found');
  fs.mkdirSync(OUTDIR, { recursive: true });

  const dataBackup = fs.readFileSync(DATA);
  const statsBackup = fs.existsSync(STATS) ? fs.readFileSync(STATS) : null;

  // Build a temporary effective DB that already includes laptop patches waiting
  // for the cloud master. This prevents the same 12 rows being queried again
  // every cycle before those patches are merged into canonical auctions.json.
  const effectiveRows = JSON.parse(dataBackup.toString('utf8'));
  const pending = applyPendingDeltas(effectiveRows);
  if (pending.patches) {
    writeJson(DATA, effectiveRows);
    console.log(`[laptop-worker] pending deltas applied locally: files=${pending.files} patches=${pending.patches}`);
  }

  const beforeRows = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const before = new Map(beforeRows.map(r => [r.id, r]));

  const env = { ...process.env, BATCH_SIZE, SHARD_COUNT: '1', SHARD_INDEX: '0' };
  const run = spawnSync(process.execPath, ['retry-worker.js', 'details'], {
    cwd: ROOT,
    stdio: 'inherit',
    env
  });

  let patches = [];
  try {
    const afterRows = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    patches = afterRows.map(r => buildPatch(before.get(r.id) || {}, r)).filter(Boolean);
  } finally {
    restore(DATA, dataBackup);
    restore(STATS, statsBackup);
  }

  if (!patches.length) {
    console.log('[laptop-worker] patches=0; nothing to publish');
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
}

main();
