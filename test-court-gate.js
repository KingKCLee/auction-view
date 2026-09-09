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
console.log('\n=== TEST 4 (deliberate failure): the browser path must not bypass the gate ===\n');

const GATE_JS = JSON.stringify(path.join(ROOT, 'court-gate.js'));
const ENFORCE_JS = JSON.stringify(path.join(ROOT, 'court-gate-enforce.js'));
const FALLBACK_JS = JSON.stringify(path.join(ROOT, 'court-browser-fallback.js'));
// The temp scripts live outside the repo, so the package is required by path.
const LIB_JS = JSON.stringify(path.join(ROOT, 'node_modules', 'court-auction-notice-search'));

// The library reaches the court two ways - an HTTP client and a Playwright
// client - and both funnel through postJson. Assert the enforcer gated both, and
// that a latched gate refuses the Playwright one before any browser starts.
const dir4 = gateDir('browser');
const libGated = runNode(`
const gate = require(${GATE_JS});
const lib = require(${LIB_JS});
const names = ['CourtAuctionHttpClient', 'CourtAuctionPlaywrightClient'];
const gated = names.filter(n => lib[n] && lib[n].prototype.__courtGated__);
console.log('gated clients: ' + gated.join(','));
if (gated.length !== 2) { console.error('NOT ALL CLIENTS GATED'); process.exit(1); }
gate.latch('test latch', 'test');
(async () => {
  const c = new lib.CourtAuctionPlaywrightClient({});
  try {
    await c.postJson('notices', {});
    console.log('PLAYWRIGHT POST WENT OUT - MUST NOT HAPPEN');
    process.exit(0);
  } catch (e) {
    console.error('playwright postJson refused: ' + e.code);
    process.exit(e.code === 'COURT_BLOCKED' ? 5 : 1);
  }
})();
`, { COURT_GATE_DIR: dir4, NODE_OPTIONS: '--require ' + ENFORCE_JS });

console.log(libGated.out.trim());
check('test4 both library clients are gated',
  /gated clients: CourtAuctionHttpClient,CourtAuctionPlaywrightClient/.test(libGated.out));
check('test4 playwright postJson refused while latched', libGated.status === 5, `got ${libGated.status}`);
check('test4 refusal is COURT_BLOCKED', /COURT_BLOCKED/.test(libGated.out));
check('test4 no browser request went out', !/WENT OUT/.test(libGated.out));

// Our own browser fallback client must take the gate too.
const dir5 = gateDir('browser-fallback');
const fallbackGated = runNode(`
const gate = require(${GATE_JS});
const { CourtBrowserFallbackClient } = require(${FALLBACK_JS});
gate.latch('test latch', 'test');
(async () => {
  const c = new CourtBrowserFallbackClient({ timeoutMs: 2000 });
  try {
    await c.postJson('notices', {});
    console.log('BROWSER FALLBACK WENT OUT - MUST NOT HAPPEN');
    process.exit(0);
  } catch (e) {
    console.error('browser fallback refused: ' + e.code);
    process.exit(e.code === 'COURT_BLOCKED' ? 5 : 1);
  }
})();
`, { COURT_GATE_DIR: dir5 });

console.log(fallbackGated.out.trim());
check('test4 browser fallback refused while latched', fallbackGated.status === 5, `got ${fallbackGated.status}`);
check('test4 fallback never launched a browser', !/WENT OUT/.test(fallbackGated.out));

// ---------------------------------------------------------------------------
console.log('\n=== TEST 5: nesting must pace, not deadlock ===\n');

const dir6 = gateDir('reentrant');
const nested = runNode(`
const gate = require(${GATE_JS});
(async () => {
  const t0 = Date.now();
  await gate.acquire('outer', async () => {
    await gate.acquire('inner', async () => { console.log('inner ran'); });
  });
  const ms = Date.now() - t0;
  console.log('elapsed=' + ms);
  process.exit(ms >= 3000 ? 0 : 3);
})();
`, { COURT_GATE_DIR: dir6 });

console.log(nested.out.trim());
check('test5 nested acquire did not deadlock', /inner ran/.test(nested.out));
check('test5 nested call still paced (>=3s)', nested.status === 0, nested.out.trim());

// ---------------------------------------------------------------------------
console.log('\n=== TEST 6 (deliberate failure): a local fault must never latch the gate ===\n');

const dir7 = gateDir('local-fault');
const localFault = runNode(`
const gate = require(${GATE_JS});
gate.latch('court gate held by pid 123 (detail-enrich:/pgj/x)', 'test');
console.log('after busy message: ' + JSON.stringify(gate.status().blocked));
if (gate.status().blocked) { console.error('LATCHED ON A LOCAL FAULT'); process.exit(1); }
gate.latch('ipcheck=false in court response', 'test');
if (!gate.status().blocked) { console.error('FAILED TO LATCH ON A REAL BLOCK'); process.exit(2); }
console.log('real block still latches: ' + gate.status().blocked.reason);
process.exit(0);
`, { COURT_GATE_DIR: dir7 });

console.log(localFault.out.trim());
check('test6 a COURT_BUSY message does not latch', localFault.status === 0, `got ${localFault.status}`);
check('test6 a real block still latches', /ipcheck=false in court response/.test(localFault.out));

// The recovery probe must do nothing while the gate is open, or it races the
// collector for the lock and reads losing that race as a block.
const dir8 = gateDir('recovery-noop');
const noop = spawnSync(process.execPath, [path.join(ROOT, 'court-recovery-watch.js')], {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, COURT_GATE_DIR: dir8 }
});
const noopOut = `${noop.stdout || ''}${noop.stderr || ''}`;
console.log(noopOut.trim());
check('test6 recovery watch is a no-op while the gate is open',
  /nothing to check/.test(noopOut), noopOut.trim().slice(0, 120));

// ---------------------------------------------------------------------------
console.log(`\n=== ${failures ? `${failures} CHECK(S) FAILED` : 'ALL CHECKS PASSED'} ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exitCode = failures ? 1 : 0;
