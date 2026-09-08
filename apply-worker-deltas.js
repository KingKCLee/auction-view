const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'auctions.json');
const DELTAS = path.join(ROOT, 'data', 'worker-deltas');

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

function mergeValue(key, current, incoming) {
  if (key === 'coverage' && current && incoming && typeof current === 'object' && typeof incoming === 'object') {
    return { ...current, ...incoming };
  }
  return incoming;
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

function main() {
  if (!fs.existsSync(DATA)) throw new Error('data/auctions.json not found');
  const rows = readJson(DATA);
  const map = new Map(rows.map(r => [r.id, r]));
  const files = listDeltaFiles(DELTAS);
  let appliedFiles = 0, appliedPatches = 0, missing = 0;

  for (const file of files) {
    let payload;
    try { payload = readJson(file); }
    catch (e) { console.error(`[apply-deltas] invalid ${file}: ${e.message}`); continue; }
    for (const patch of payload.patches || []) {
      const row = map.get(patch.id);
      if (!row) { missing++; continue; }
      for (const [key, value] of Object.entries(patch.set || {})) {
        row[key] = mergeValue(key, row[key], value);
      }
      row.detailCheckedAt = payload.createdAt || new Date().toISOString();
      appliedPatches++;
    }
    fs.unlinkSync(file);
    appliedFiles++;
  }

  if (appliedPatches) writeJson(DATA, rows);
  console.log(JSON.stringify({ appliedFiles, appliedPatches, missing }, null, 2));
}

main();
