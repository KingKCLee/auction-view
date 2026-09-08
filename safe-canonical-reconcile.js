// Reconcile a collector snapshot with the freshly-pulled canonical database.
// This is deliberately additive: an ID present in either side must survive.
// It exists to prevent concurrent laptop/cloud/Actions publishers from silently
// discarding records discovered by another collector.

const fs = require('fs');
const path = require('path');
const { evaluateRecordLoss, snapshot, evaluateGuard, formatFailures, syncStatsCoverage } = require('./merge-guard-lib');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'auctions.json');
const STATS = path.join(ROOT, 'data', 'stats.json');
const STATE = path.join(ROOT, 'data', 'state.json');

const [localDataPath, localStatsPath, localStatePath] = process.argv.slice(2);
if (!localDataPath) throw new Error('usage: node safe-canonical-reconcile.js <collector-auctions.json> [collector-stats.json] [collector-state.json]');

const read = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const blank = v => v === null || v === undefined || v === '';
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

function unionArray(a, b) {
  const out = [], seen = new Set();
  for (const v of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    let k;
    try { k = JSON.stringify(v); } catch { k = String(v); }
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}

function mergeRow(remote, local) {
  if (!remote) return local;
  if (!local) return remote;
  // Local is the collector's fresher observation, but an empty local field may
  // never erase a value already preserved in canonical.
  const out = { ...remote, ...local };
  for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
    const a = remote[key], b = local[key];
    if (blank(b) && !blank(a)) out[key] = a;
    else if (Array.isArray(a) || Array.isArray(b)) out[key] = unionArray(a, b);
  }
  out.coverage = {};
  for (const k of new Set([...Object.keys(remote.coverage || {}), ...Object.keys(local.coverage || {})])) {
    out.coverage[k] = Math.max(Number(remote.coverage?.[k] || 0), Number(local.coverage?.[k] || 0));
  }
  for (const k of ['photoCount','documentCount','eventCount','failedCount','bidderCount']) {
    if (!blank(remote[k]) || !blank(local[k])) out[k] = Math.max(Number(remote[k] || 0), Number(local[k] || 0));
  }
  out.firstSeenAt = remote.firstSeenAt || local.firstSeenAt;
  out.lastSeenAt = local.lastSeenAt || remote.lastSeenAt || new Date().toISOString();
  return out;
}

function mergeState(remote, local) {
  if (!isObj(local)) return remote || {};
  const out = { ...(remote || {}), ...local };
  for (const k of new Set([...Object.keys(remote || {}), ...Object.keys(local || {})])) {
    if (Array.isArray(remote?.[k]) || Array.isArray(local?.[k])) out[k] = unionArray(remote?.[k], local?.[k]);
  }
  return out;
}

const remoteRows = read(DATA, []);
const localRows = read(localDataPath, []);
if (!Array.isArray(remoteRows) || !Array.isArray(localRows)) throw new Error('canonical or collector auctions is not an array');

const map = new Map(remoteRows.map(r => [r.id, r]));
for (const row of localRows) {
  if (!row || !row.id) continue;
  map.set(row.id, mergeRow(map.get(row.id), row));
}
const merged = [...map.values()].sort((a,b) => String(b.saleDate || '').localeCompare(String(a.saleDate || '')) || String(b.caseNumber || '').localeCompare(String(a.caseNumber || '')));

const failures = [
  ...evaluateRecordLoss(remoteRows, merged),
  ...evaluateRecordLoss(localRows, merged),
  ...evaluateGuard(snapshot(remoteRows), snapshot(merged)),
  ...evaluateGuard(snapshot(localRows), snapshot(merged))
];
if (failures.length) {
  console.error('[safe-reconcile] REFUSED: additive invariant failed');
  console.error(formatFailures(failures));
  process.exit(3);
}

const remoteStats = read(STATS, {});
const localStats = localStatsPath ? read(localStatsPath, {}) : {};
let stats = syncStatsCoverage({ ...remoteStats, ...localStats }, merged);
stats.safeReconcile = {
  remoteItems: remoteRows.length,
  collectorItems: localRows.length,
  mergedItems: merged.length,
  retainedRemoteIds: remoteRows.length,
  retainedCollectorIds: localRows.length,
  addedVsRemote: Math.max(0, merged.length - remoteRows.length),
  finishedAt: new Date().toISOString()
};

const remoteState = read(STATE, {});
const localState = localStatePath ? read(localStatePath, {}) : {};
const state = mergeState(remoteState, localState);

write(DATA, merged);
write(STATS, stats);
write(STATE, state);
console.log(JSON.stringify({ ok:true, ...stats.safeReconcile }, null, 2));
