const fs = require('fs');
const path = require('path');
const { applyPatch } = require('./dual-collector-lib');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'auctions.json');
const STATE = path.join(ROOT, 'data', 'state.json');
const DELTAS = path.join(ROOT, 'data', 'worker-deltas');

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

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

function validAddition(row) {
  return row && typeof row === 'object' && typeof row.id === 'string' && row.id &&
    typeof row.courtCode === 'string' && row.courtCode &&
    typeof row.caseNumber === 'string' && row.caseNumber;
}

function mergeCurrentSweepState(target, patch) {
  if (!patch || typeof patch !== 'object') return 0;
  let changed = 0;
  for (const [key, value] of Object.entries(patch)) {
    if (!key.startsWith('currentSweep')) continue;
    target[key] = value;
    changed++;
  }
  return changed;
}

function applyPayload(rows, state, payload) {
  const map = new Map(rows.map(r => [r.id, r]));
  let appliedPatches = 0, additions = 0, duplicateAdditions = 0, missing = 0;
  for (const row of payload.additions || []) {
    if (!validAddition(row)) { missing++; continue; }
    if (map.has(row.id)) { duplicateAdditions++; continue; }
    const clean = { ...row, firstSeenAt: row.firstSeenAt || payload.createdAt || new Date().toISOString(), lastSeenAt: row.lastSeenAt || payload.createdAt || new Date().toISOString() };
    rows.push(clean); map.set(clean.id, clean); additions++;
  }
  for (const patch of payload.patches || []) {
    const row = map.get(patch.id);
    if (!row) { missing++; continue; }
    applyPatch(row, patch);
    row.detailCheckedAt = payload.createdAt || row.detailCheckedAt || new Date().toISOString();
    appliedPatches++;
  }
  const stateKeys = mergeCurrentSweepState(state, payload.statePatch);
  return { appliedPatches, additions, duplicateAdditions, missing, stateKeys };
}

function main() {
  if (!fs.existsSync(DATA)) throw new Error('data/auctions.json not found');
  const rows = readJson(DATA);
  const state = fs.existsSync(STATE) ? readJson(STATE) : {};
  const files = listDeltaFiles(DELTAS);
  let appliedFiles = 0, appliedPatches = 0, additions = 0, duplicateAdditions = 0, missing = 0, stateKeys = 0;

  for (const file of files) {
    let payload;
    try { payload = readJson(file); }
    catch (e) { console.error(`[apply-deltas] invalid ${file}: ${e.message}`); continue; }
    const result = applyPayload(rows, state, payload);
    appliedPatches += result.appliedPatches; additions += result.additions;
    duplicateAdditions += result.duplicateAdditions; missing += result.missing; stateKeys += result.stateKeys;
    fs.unlinkSync(file); appliedFiles++;
  }

  if (appliedPatches || additions) {
    rows.sort((a,b)=>String(b.saleDate||'').localeCompare(String(a.saleDate||''))||String(b.caseNumber||'').localeCompare(String(a.caseNumber||'')));
    writeJson(DATA, rows);
  }
  if (stateKeys) writeJson(STATE, state);
  console.log(JSON.stringify({ appliedFiles, appliedPatches, additions, duplicateAdditions, missing, stateKeys }, null, 2));
}

if (require.main === module) main();
module.exports = { validAddition, mergeCurrentSweepState, applyPayload };
