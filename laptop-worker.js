const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'auctions.json');
const STATS = path.join(ROOT, 'data', 'stats.json');
const OUTDIR = path.join(ROOT, 'data', 'worker-deltas', process.env.WORKER_ID || 'laptop');
const BATCH_SIZE = String(process.env.BATCH_SIZE || 12);
const MEANINGFUL = new Set([
  'caseType','usage','buildingName','events','eventCount','minimumPrice','saleDate','failedCount',
  'winningPrice','winningDate','winningRatio','status','coverage','appraisalSummary','appraisalDate',
  'appraisalAgency','claimAmount','components','address','landArea','buildingArea','saleStatementAvailable',
  'statusReportAvailable','documents','documentCount'
]);

const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function diffRow(before, after) {
  const set = {};
  for (const key of MEANINGFUL) {
    if (!same(before?.[key], after?.[key])) set[key] = after?.[key] ?? null;
  }
  return Object.keys(set).length ? { id: after.id, set } : null;
}

function restore(file, content) {
  if (content == null) return;
  fs.writeFileSync(file, content);
}

function main() {
  if (!fs.existsSync(DATA)) throw new Error('data/auctions.json not found');
  fs.mkdirSync(OUTDIR, { recursive: true });

  const dataBackup = fs.readFileSync(DATA);
  const statsBackup = fs.existsSync(STATS) ? fs.readFileSync(STATS) : null;
  const beforeRows = JSON.parse(dataBackup.toString('utf8'));
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
    patches = afterRows.map(r => diffRow(before.get(r.id) || {}, r)).filter(Boolean);
  } finally {
    restore(DATA, dataBackup);
    restore(STATS, statsBackup);
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
  if (run.status && patches.length === 0) process.exitCode = run.status;
}

main();
