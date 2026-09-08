// Deliberate-failure tests for the cloud master merge guard.
//
// Builds a throwaway bare repo as a stand-in for GitHub, then runs the real
// cloud-master-once.js against it three ways:
//   1. a delta that shrinks coverage      -> guard MUST fail, nothing pushed
//   2. a delta that grows coverage        -> guard MUST pass, commit pushed
//   3. evaluateGuard() on a shrunk row set -> itemCount drop MUST be reported
//
// Run: node test-merge-guard.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { snapshot, evaluateGuard } = require('./merge-guard-lib');

const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-guard-test-'));
const ORIGIN = path.join(TMP, 'origin.git');
const SEED = path.join(TMP, 'seed');
const WORK = path.join(TMP, 'work');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  if (!ok) failures++;
};

const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout;
};

const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

function makeRow(i, saleStatement) {
  return {
    id: `C${i}|2025타경${1000 + i}|1`,
    caseNumber: `2025타경${1000 + i}`,
    itemNumber: '1',
    documentCount: saleStatement ? 2 : 0,
    photoCount: 0,
    eventCount: 0,
    winningPrice: null,
    documents: [],
    coverage: {
      base_info: 1, schedule: 0, winning_price: 0, photos: 0,
      status_report: saleStatement, sale_statement: saleStatement,
      appraisal_summary: saleStatement, appraisal_pdf: 0,
      transactions: 0, building_registry: 0, land_use: 0, rights: 0
    }
  };
}

// 40 rows, the first 20 already carry sale_statement coverage.
const ROWS = Array.from({ length: 40 }, (_, i) => makeRow(i, i < 20 ? 1 : 0));

function seedOrigin(deltaPatches) {
  fs.rmSync(ORIGIN, { recursive: true, force: true });
  fs.rmSync(SEED, { recursive: true, force: true });
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(ORIGIN, { recursive: true });
  sh('git', ['init', '--bare', '--initial-branch=main', '.'], ORIGIN);

  fs.mkdirSync(path.join(SEED, 'data', 'worker-deltas', 'laptop'), { recursive: true });
  sh('git', ['init', '--initial-branch=main', '.'], SEED);
  sh('git', ['config', 'user.name', 'seed'], SEED);
  sh('git', ['config', 'user.email', 'seed@example.com'], SEED);

  writeJson(path.join(SEED, 'data', 'auctions.json'), ROWS);
  writeJson(path.join(SEED, 'data', 'stats.json'), { coverage: { sale_statement: 0 } });
  writeJson(path.join(SEED, 'data', 'state.json'), {});
  writeJson(path.join(SEED, 'data', 'worker-deltas', 'laptop', 'delta-1.json'), {
    version: 1, worker: 'laptop', createdAt: new Date().toISOString(),
    batchSize: deltaPatches.length, exitCode: 0, patches: deltaPatches
  });

  sh('git', ['add', '-A'], SEED);
  sh('git', ['commit', '-m', 'seed'], SEED);
  sh('git', ['push', ORIGIN, 'HEAD:main'], SEED);
}

function runMaster() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cloud-master-once.js')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      REPO_URL: ORIGIN,
      REPO_BRANCH: 'main',
      CLOUD_WORK_DIR: WORK,
      CLOUD_SOURCE_DIR: ROOT,
      GITHUB_TOKEN: '',
      GH_PAT: '',
      GITHUB_TOKEN_FILE: ''
    }
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

const originRows = () => JSON.parse(sh('git', ['show', 'main:data/auctions.json'], ORIGIN));
const originStats = () => JSON.parse(sh('git', ['show', 'main:data/stats.json'], ORIGIN));
const originDeltaCount = () =>
  sh('git', ['ls-tree', '-r', '--name-only', 'main', '--', 'data/worker-deltas'], ORIGIN)
    .split('\n').filter(Boolean).length;
const originHead = () => sh('git', ['rev-parse', 'main'], ORIGIN).trim();

// ---------------------------------------------------------------------------
console.log('\n=== TEST 1 (deliberate failure): delta shrinks coverage ===\n');

// Wipe sale_statement/status_report/appraisal_summary off the 20 rows that had it.
seedOrigin(ROWS.slice(0, 20).map(r => ({
  id: r.id,
  set: { coverage: { sale_statement: 0, status_report: 0, appraisal_summary: 0 }, documentCount: 0 }
})));

const headBefore = originHead();
const t1 = runMaster();
console.log(t1.out);

check('test1 exit code is 3 (guard fail)', t1.status === 3, `got ${t1.status}`);
check('test1 logs MERGE GUARD FAILED', /MERGE GUARD FAILED/.test(t1.out));
check('test1 reports coverage.sale_statement drop 20 -> 0', /coverage\.sale_statement: 20 -> 0 \(-20\)/.test(t1.out));
check('test1 reports documentCount drop 40 -> 0', /documentCount: 40 -> 0 \(-40\)/.test(t1.out));
check('test1 pushed nothing (origin HEAD unchanged)', originHead() === headBefore);
check('test1 origin canonical intact (40 rows)', originRows().length === 40);
check('test1 origin delta file preserved', originDeltaCount() === 1);
check('test1 local checkout canonical restored',
  snapshot(JSON.parse(fs.readFileSync(path.join(WORK, 'data', 'auctions.json'), 'utf8'))).coverage.sale_statement === 20);
check('test1 local delta file restored on disk',
  fs.existsSync(path.join(WORK, 'data', 'worker-deltas', 'laptop', 'delta-1.json')));

// ---------------------------------------------------------------------------
console.log('\n=== TEST 2 (happy path): delta grows coverage ===\n');

// Give the 20 rows that lacked it full document coverage.
seedOrigin(ROWS.slice(20).map(r => ({
  id: r.id,
  set: { coverage: { sale_statement: 1, status_report: 1, appraisal_summary: 1 }, documentCount: 2 }
})));

const head2Before = originHead();
const t2 = runMaster();
console.log(t2.out);

check('test2 exit code is 0', t2.status === 0, `got ${t2.status}`);
check('test2 logs merge guard passed', /merge guard passed/.test(t2.out));
check('test2 pushed a new commit', originHead() !== head2Before);
check('test2 origin canonical still 40 rows', originRows().length === 40);
check('test2 origin worker-deltas emptied', originDeltaCount() === 0);

const s2 = originStats();
check('test2 stats.coverage.sale_statement 0 -> 40', s2.coverage.sale_statement === 40, JSON.stringify(s2.coverage));
check('test2 stats.documentCount recounted to 80', s2.documentCount === 80, String(s2.documentCount));

// ---------------------------------------------------------------------------
console.log('\n=== TEST 3 (deliberate failure): itemCount shrink is caught ===\n');

const full = snapshot(ROWS);
const shrunk = snapshot(ROWS.slice(0, 35));
const f3 = evaluateGuard(full, shrunk);
console.log(JSON.stringify(f3, null, 2));
check('test3 itemCount drop reported',
  f3.some(f => f.field === 'itemCount' && f.before === 40 && f.after === 35));
check('test3 no failures when unchanged', evaluateGuard(full, full).length === 0);

// ---------------------------------------------------------------------------
console.log(`\n=== ${failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED'} ===`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exitCode = failures ? 1 : 0;
