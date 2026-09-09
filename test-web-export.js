// Deliberate-failure tests for the web export size cap. No network, no KV.
//
//   1. an oversized list blob      -> export MUST fail, nothing written
//   2. an oversized detail record  -> export MUST fail, nothing written
//   3. a shrunken canonical        -> export MUST refuse to publish it
//   4. a normal set                -> export MUST succeed and stay under the cap
//   5. the uploader                -> MUST refuse an over-cap value
//
//   node test-web-export.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'web-export-test-'));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  if (!ok) failures++;
};

const cov = () => ({
  base_info: 1, schedule: 0, winning_price: 0, photos: 0, status_report: 0,
  sale_statement: 0, appraisal_summary: 0, appraisal_pdf: 0, transactions: 0,
  building_registry: 0, land_use: 0, rights: 0
});

function makeRow(i, { addressLen = 40, summaryLen = 0 } = {}) {
  return {
    id: `B0002${String(i).padStart(2, '0')}|2026타경${1000 + i}|1`,
    caseNumber: `2026타경${1000 + i}`, itemNumber: '1',
    courtCode: 'B000210', courtName: '서울중앙지방법원',
    address: '서울특별시 관악구 신림동 '.padEnd(addressLen, '가'),
    regionSido: '서울특별시', regionSigungu: '관악구', usage: '아파트',
    appraisedPrice: 100000000 + i, minimumPrice: 70000000 + i,
    saleDate: '2026-09-22', failedCount: 1, winningPrice: null,
    photoCount: 0, documentCount: 2, documents: [], events: [], components: [],
    appraisalSummary: summaryLen ? '내용'.repeat(summaryLen) : null,
    coverage: cov()
  };
}

function runExport(dir, env = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'export-for-web.js')], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, EXPORT_ROOT: dir, EXPORT_OUT: path.join(dir, 'export'), ...env }
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function seed(name, rows) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'auctions.json'), JSON.stringify(rows));
  fs.writeFileSync(path.join(dir, 'data', 'stats.json'), JSON.stringify({ coverage: { base_info: rows.length } }));
  return dir;
}

// ---------------------------------------------------------------------------
console.log('\n=== TEST 1 (deliberate failure): an oversized list blob must fail the export ===\n');

// Long, high-entropy addresses so gzip cannot rescue the blob.
const fat = Array.from({ length: 4000 }, (_, i) => {
  const r = makeRow(i);
  r.address = `${i}-` + Math.random().toString(36).repeat(20);
  return r;
});
const dir1 = seed('fat-index', fat);
const t1 = runExport(dir1, { MAX_OBJECT_BYTES: '60000' });
console.log(t1.out.trim().split('\n').slice(-2).join('\n'));

check('test1 export exited 7 (payload too large)', t1.status === 7, `got ${t1.status}`);
check('test1 names the offending object', /index\.json\.gz is \d+ bytes, over the 60000 byte cap/.test(t1.out));
check('test1 wrote no index', !fs.existsSync(path.join(dir1, 'export', 'index.json.gz')));

// ---------------------------------------------------------------------------
console.log('\n=== TEST 2 (deliberate failure): an oversized detail record must fail the export ===\n');

const withGiant = [makeRow(1), makeRow(2, { summaryLen: 40000 }), makeRow(3)];
const dir2 = seed('fat-detail', withGiant);
const t2 = runExport(dir2, { MAX_OBJECT_BYTES: '100000' });
console.log(t2.out.trim().split('\n').slice(-1)[0]);

check('test2 export exited 7', t2.status === 7, `got ${t2.status}`);
check('test2 names the detail file', /detail\/.*\.json is \d+ bytes, over the 100000 byte cap/.test(t2.out));

// ---------------------------------------------------------------------------
console.log('\n=== TEST 3 (deliberate failure): a shrunken canonical must not be published ===\n');

const full = Array.from({ length: 200 }, (_, i) => makeRow(i));
const dir3 = seed('shrink', full);
const ok3 = runExport(dir3);
check('test3 the full set exports cleanly', ok3.status === 0, `got ${ok3.status}`);

// Now write a truncated canonical, as laptop-worker does mid-cycle.
fs.writeFileSync(path.join(dir3, 'data', 'auctions.json'), JSON.stringify(full.slice(0, 100)));
const t3 = runExport(dir3);
console.log(t3.out.trim().split('\n').slice(-1)[0]);
check('test3 export exited 8 (canonical incomplete)', t3.status === 8, `got ${t3.status}`);
check('test3 says why', /looks mid-cycle: 100 rows against 200 last export/.test(t3.out));

const manifest3 = JSON.parse(fs.readFileSync(path.join(dir3, 'export', 'manifest.json'), 'utf8'));
check('test3 the previous export is untouched', manifest3.itemCount === 200, String(manifest3.itemCount));

// ---------------------------------------------------------------------------
console.log('\n=== TEST 4: a normal set exports under the cap ===\n');

const dir4 = seed('normal', Array.from({ length: 500 }, (_, i) => makeRow(i)));
const t4 = runExport(dir4);
check('test4 export succeeded', t4.status === 0, `got ${t4.status}`);
const m4 = JSON.parse(fs.readFileSync(path.join(dir4, 'export', 'manifest.json'), 'utf8'));
console.log(`index ${m4.objects['index.json.gz']}B, ${m4.objects.detailFiles} detail files, largest ${m4.objects.largestDetail.bytes}B, cap ${m4.maxObjectBytes}B`);
check('test4 index is under the cap', m4.objects['index.json.gz'] < m4.maxObjectBytes);
check('test4 every detail is under the cap', m4.objects.largestDetail.bytes < m4.maxObjectBytes);
check('test4 all rows exported', m4.itemCount === 500, String(m4.itemCount));

// ---------------------------------------------------------------------------
console.log('\n=== TEST 5 (deliberate failure): the uploader must refuse an over-cap value ===\n');

const t5 = spawnSync(process.execPath, ['-e', `
process.env.EXPORT_OUT = ${JSON.stringify(path.join(dir4, 'export'))};
process.env.MAX_OBJECT_BYTES = '1000';
const { collect } = require(${JSON.stringify(path.join(ROOT, 'upload-web-export.js'))});
try { collect(); console.log('COLLECTED WITHOUT COMPLAINT - MUST NOT HAPPEN'); process.exit(0); }
catch (e) { console.error(e.code + ': ' + e.message); process.exit(e.code === 'PAYLOAD_TOO_LARGE' ? 7 : 1); }
`], { cwd: ROOT, encoding: 'utf8' });
console.log(`${t5.stdout || ''}${t5.stderr || ''}`.trim());
check('test5 uploader exited 7', t5.status === 7, `got ${t5.status}`);
check('test5 uploader refused before sending', !/MUST NOT HAPPEN/.test(`${t5.stdout}${t5.stderr}`));

// ---------------------------------------------------------------------------
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log(`\n=== ${failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED'} ===`);
process.exitCode = failures ? 1 : 0;
