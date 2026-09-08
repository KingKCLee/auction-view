// The single door to courtauction.go.kr.
//
// Today's block happened because two things were querying the court at once. A
// per-process delay cannot prevent that - the pacing has to be shared. So this
// module holds machine-wide state in files under data/:
//
//   data/court-gate.lock    exclusive holder (O_EXCL create), one at a time
//   data/court-gate.json    last call timestamp + block latch, shared by all
//
// Every court request must go through acquire()/request(). Requiring
// court-gate-enforce.js additionally makes any un-gated request to the court
// host throw, so a script that forgets the gate cannot reach the court at all.
//
// On BLOCKED / ipcheck=false the gate latches: every later acquire refuses until
// a human clears it with `node court-gate.js --clear`. Nothing retries past a
// block, because retrying through a block extends it.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.COURT_GATE_DIR || path.join(__dirname, 'data');
const LOCK = path.join(DATA_DIR, 'court-gate.lock');
const STATE = path.join(DATA_DIR, 'court-gate.json');

const MIN_INTERVAL_MS = Number(process.env.COURT_MIN_INTERVAL_MS || 3400);
const JITTER_MS = Number(process.env.COURT_JITTER_MS || 700);
const LOCK_WAIT_MS = Number(process.env.COURT_LOCK_WAIT_MS || 0); // 0 = fail fast
const LOCK_STALE_MS = Number(process.env.COURT_LOCK_STALE_MS || 120000);

const COURT_HOST = 'courtauction.go.kr';
const BLOCK_PATTERN = /BLOCKED|ipcheck\s*=\s*false|captcha|access denied|접근이 차단|비정상적인 접근/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));

class CourtBlockedError extends Error {
  constructor(reason) { super(`court gate is latched: ${reason}`); this.code = 'COURT_BLOCKED'; }
}
class CourtBusyError extends Error {
  constructor(holder) {
    super(`court gate held by pid ${holder?.pid} (${holder?.owner}) since ${holder?.at}`);
    this.code = 'COURT_BUSY';
    this.holder = holder;
  }
}

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
};

const readState = () => readJson(STATE, { lastCallAt: 0, blocked: null, calls: 0 });

function status() {
  const s = readState();
  const holder = readJson(LOCK, null);
  return { ...s, lockHeldBy: holder, lockPath: LOCK, statePath: STATE };
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function latch(reason, where) {
  const s = readState();
  s.blocked = { reason: String(reason).slice(0, 500), where: where || null, at: new Date().toISOString() };
  writeJson(STATE, s);
  console.error(`[court-gate] LATCHED: ${s.blocked.reason} (${s.blocked.where || 'unknown'})`);
  return s.blocked;
}

function clearLatch() {
  const s = readState();
  const was = s.blocked;
  s.blocked = null;
  s.clearedAt = new Date().toISOString();
  writeJson(STATE, s);
  return was;
}

function assertNotBlocked() {
  const s = readState();
  if (s.blocked) throw new CourtBlockedError(`${s.blocked.reason} at ${s.blocked.at}`);
}

// Exclusive, machine-wide. O_EXCL create is atomic, so two processes racing here
// cannot both win - the loser gets EEXIST and is told who holds it.
function tryTakeLock(owner) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, owner, at: new Date().toISOString() });
  try {
    const fd = fs.openSync(LOCK, 'wx');
    fs.writeSync(fd, payload);
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const holder = readJson(LOCK, null);
    const stale = !holder
      || (!alive(holder.pid) )
      || (Date.now() - Date.parse(holder.at || 0) > LOCK_STALE_MS);
    if (stale) {
      console.error(`[court-gate] clearing stale lock from pid ${holder?.pid}`);
      try { fs.unlinkSync(LOCK); } catch {}
      return tryTakeLock(owner);
    }
    return false;
  }
}

function releaseLock() {
  const holder = readJson(LOCK, null);
  if (holder && holder.pid !== process.pid) return; // never drop someone else's lock
  try { fs.unlinkSync(LOCK); } catch {}
}

// Shared pacing: the interval is measured against the last call by ANY process.
async function waitForSlot() {
  for (;;) {
    const s = readState();
    const wait = Number(s.lastCallAt || 0) + MIN_INTERVAL_MS - Date.now();
    if (wait <= 0) break;
    await sleep(Math.min(wait, 1000));
  }
  await sleep(Math.floor(Math.random() * JITTER_MS));
}

function noteCall() {
  const s = readState();
  s.lastCallAt = Date.now();
  s.calls = Number(s.calls || 0) + 1;
  s.lastOwner = process.env.COURT_GATE_OWNER || path.basename(process.argv[1] || 'unknown');
  writeJson(STATE, s);
}

// Runs fn while holding the gate. Refuses if latched or if another holder exists.
async function acquire(owner, fn) {
  assertNotBlocked();
  const label = owner || path.basename(process.argv[1] || 'unknown');
  const deadline = Date.now() + LOCK_WAIT_MS;
  let got = tryTakeLock(label);
  while (!got && Date.now() < deadline) {
    await sleep(500);
    assertNotBlocked();
    got = tryTakeLock(label);
  }
  if (!got) throw new CourtBusyError(readJson(LOCK, null));

  try {
    assertNotBlocked();
    await waitForSlot();
    noteCall();
    global.__COURT_GATE_OPEN__ = (global.__COURT_GATE_OPEN__ || 0) + 1;
    try {
      return await fn();
    } finally {
      global.__COURT_GATE_OPEN__--;
    }
  } catch (e) {
    if (e.code !== 'COURT_BLOCKED' && BLOCK_PATTERN.test(String(e?.message || e))) {
      latch(String(e.message || e), label);
    }
    throw e;
  } finally {
    releaseLock();
  }
}

// Convenience wrapper: fetch through the gate, with block detection on the body.
async function request(url, init = {}, { owner, timeoutMs = 18000 } = {}) {
  return acquire(owner, async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await (global.__COURT_GATE_RAW_FETCH__ || fetch)(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    inspect(text, url);
    return { res, text, json: () => JSON.parse(text) };
  });
}

// Any caller that reads a court response itself should hand it here so a block
// latches even when the HTTP status is 200.
function inspect(payload, where) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  let ipcheckFalse = false;
  try {
    const j = typeof payload === 'string' ? JSON.parse(payload) : payload;
    ipcheckFalse = j?.data?.ipcheck === false;
  } catch {}
  if (ipcheckFalse) return latch('ipcheck=false in court response', where);
  if (BLOCK_PATTERN.test(text.slice(0, 4000))) return latch('block phrase in court response', where);
  return null;
}

module.exports = {
  acquire, request, inspect, status, latch, clearLatch, assertNotBlocked,
  CourtBlockedError, CourtBusyError, COURT_HOST, BLOCK_PATTERN,
  LOCK, STATE, MIN_INTERVAL_MS
};

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--clear') {
    const was = clearLatch();
    console.log(JSON.stringify({ cleared: was || 'nothing was latched' }, null, 2));
  } else if (arg === '--latch') {
    console.log(JSON.stringify(latch(process.argv[3] || 'manual latch', 'cli'), null, 2));
  } else if (arg === '--unlock') {
    try { fs.unlinkSync(LOCK); console.log('lock removed'); } catch (e) { console.log('no lock: ' + e.code); }
  } else {
    console.log(JSON.stringify(status(), null, 2));
  }
}
