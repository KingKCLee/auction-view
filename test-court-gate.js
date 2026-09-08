// Deliberate-failure tests for the court gate. Makes no network calls at all.
//
//   1. two processes hold the gate at once  -> the second MUST be refused
//   2. a court response with ipcheck=false  -> the gate MUST latch and stay shut
//   3. an ungated fetch to the court host   -> MUST be refused by the enforcer
//
//   node test-court-gate.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'court-gate-test-'));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  if (!ok) failures++;
};

// Each case gets a clean gate directory so tests never touch the real data/.
function gateDir(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const runNode = (code, env) => {
  const file = path.join(TMP, `run-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, code);
  const r = spawnSync(process.execPath, [file], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// ---------------------------------------------------------------------------
console.log('\n=== TEST 1 (deliberate failure): a second holder must be refused ===\n');

const dir1 = gateDir('concurrent');

// Holder A takes the gate and sits on it while holder B tries to take it too.
const holder = `
const gate = require(${JSON.stringify(path.join(ROOT, 'court-gate.js'))});
gate.acquire('holder-A', async () => {
  require('fs').writeFileSync(process.env.READY_FILE, 'held');
  await new Promise(r => setTimeout(r, 6000));
  console.log('holder-A finished');
});
`;
const readyFile = path.join(dir1, 'ready');
const holderFile = path.join(TMP, 'holder.js');
fs.writeFileSync(holderFile, holder);
const { spawn } = require('child_process');
const child = spawn(process.execPath, [holderFile], {
  cwd: ROOT, env: { ...process.env, COURT_GATE_DIR: dir1, READY_FILE: readyFile },
  stdio: 'pipe'
});

const waitFor = (file, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file)) return true;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},120)']); // ~120ms nap
  }
  return false;
};

const heldInTime = waitFor(readyFile, 15000);
check('test1 holder A actually took the gate', heldInTime);

const contender = runNode(`
const gate = require(${JSON.stringify(path.join(ROOT, 'court-gate.js'))});
gate.acquire('holder-B', async () => { console.log('B RAN - THIS MUST NOT HAPPEN'); })
  .then(() => { console.log('B resolved'); process.exit(0); })
  .catch(e => { console.error('B refused: ' + e.code + ' :: ' + e.message); process.exit(7); });
`, { COURT_GATE_DIR: dir1 });

console.log(contender.out.trim());
check('test1 holder B exited 7 (refused)', contender.status === 7, `got ${contender.status}`);
check('test1 refusal is COURT_BUSY', /COURT_BUSY/.test(contender.out));
check('test1 refusal names the holder', /holder-A/.test(contender.out));
check('test1 holder B never ran the body', !/B RAN/.test(contender.out));

child.kill();

// ---------------------------------------------------------------------------
console.log('\n=== TEST 2 (deliberate failure): ipcheck=false must latch the gate ===\n');

const dir2 = gateDir('latch');
const latchRun = runNode(`
const gate = require(${JSON.stringify(path.join(ROOT, 'court-gate.js'))});
(async () => {
  // A 200 response that carries the court's block marker.
  const body = JSON.stringify({ data: { ipcheck: false, msg: 'nope' } });
  gate.inspect(body, '/pgj/pgj15B/selectAuctnCsSrchRslt.on');
  console.log('status after inspect: ' + JSON.stringify(gate.status().blocked));
  try {
    await gate.acquire('after-block', async () => { console.log('RAN AFTER BLOCK - MUST NOT HAPPEN'); });
    console.log('acquire resolved - MUST NOT HAPPEN');
    process.exit(0);
  } catch (e) {
    console.error('acquire refused: ' + e.code + ' :: ' + e.message);
    process.exit(8);
  }
})();
`, { COURT_GATE_DIR: dir2 });

console.log(latchRun.out.trim());
check('test2 exited 8 (gate refused after latch)', latchRun.status === 8, `got ${latchRun.status}`);
check('test2 logged LATCHED', /LATCHED/.test(latchRun.out));
check('test2 latch reason is ipcheck=false', /ipcheck=false/.test(latchRun.out));
check('test2 refusal is COURT_BLOCKED', /COURT_BLOCKED/.test(latchRun.out));
check('test2 nothing ran after the block', !/MUST NOT HAPPEN/.test(latchRun.out));

const latched = JSON.parse(fs.readFileSync(path.join(dir2, 'court-gate.json'), 'utf8'));
check('test2 latch persisted to court-gate.json', !!latched.blocked, JSON.stringify(latched.blocked));

// The latch must survive a fresh process - it is not in-memory state.
const stillShut = runNode(`
const gate = require(${JSON.stringify(path.join(ROOT, 'court-gate.js'))});
gate.acquire('fresh-process', async () => { console.log('RAN - MUST NOT HAPPEN'); })
  .then(() => process.exit(0))
  .catch(e => { console.error('still refused: ' + e.code); process.exit(8); });
`, { COURT_GATE_DIR: dir2 });
check('test2 a brand new process is still refused', stillShut.status === 8, stillShut.out.trim());

// ---------------------------------------------------------------------------
console.log('\n=== TEST 3 (deliberate failure): an ungated court fetch must be refused ===\n');

const dir3 = gateDir('enforce');
const ungated = runNode(`
(async () => {
  try {
    await fetch('https://www.courtauction.go.kr/pgj/index.on');
    console.log('FETCH WENT OUT - MUST NOT HAPPEN');
    process.exit(0);
  } catch (e) {
    console.error('refused: ' + e.code + ' :: ' + String(e.message).split('\\n')[0]);
    process.exit(6);
  }
})();
`, { COURT_GATE_DIR: dir3, NODE_OPTIONS: `--require ${JSON.stringify(path.join(ROOT, 'court-gate-enforce.js'))}` });

console.log(ungated.out.trim());
check('test3 exited 6 (ungated fetch refused)', ungated.status === 6, `got ${ungated.status}`);
check('test3 refusal is COURT_UNGATED', /COURT_UNGATED/.test(ungated.out));
check('test3 request never went out', !/FETCH WENT OUT/.test(ungated.out));

// A non-court host must still work normally through the patched fetch.
const passthrough = runNode(`
const gate = require(${JSON.stringify(path.join(ROOT, 'court-gate.js'))});
// No network: just prove the patch does not throw for a non-court URL shape.
const patched = global.fetch;
console.log('patched=' + (patched.name === 'gatedFetch'));
process.exit(patched.name === 'gatedFetch' ? 0 : 1);
`, { COURT_GATE_DIR: dir3, NODE_OPTIONS: `--require ${JSON.stringify(path.join(ROOT, 'court-gate-enforce.js'))}` });
check('test3 enforcer installed the gated fetch', passthrough.status === 0, passthrough.out.trim());

// ---------------------------------------------------------------------------
console.log(`\n=== ${failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED'} ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failures ? 1 : 0;
