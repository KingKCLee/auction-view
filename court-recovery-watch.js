// Checks once whether the court block has lifted. Not a bypass, not a retry loop.
//
// It probes the exact endpoint the collector needs, because the block is
// endpoint-specific. Measured 2026-09-09 during the live block: the warmup HTML
// answered 200 (2478 bytes) and getCourtCodes returned all 60 courts, while
// selectAuctnCsSrchRslt.on returned ipcheck=false. Both of the cheaper probes
// therefore reported "recovered" mid-block. Only a real case-detail call counts.
//
// Run hourly via scripts/recovery-watch.ps1. On recovery it starts the collector
// directly at its pre-block rate; it never speeds anything up.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const gate = require('./court-gate');
const BASE = 'https://www.courtauction.go.kr';
const DETAIL_PATH = '/pgj/pgj15B/selectAuctnCsSrchRslt.on';
const DATA = path.join(__dirname, 'data', 'auctions.json');
const VALID_CASE = /^\d{4}타경\d+$/;
const KST_MS = 9 * 3600000;
const kstDay = ms => new Date(ms + KST_MS).toISOString().slice(0, 10);

const LOG = process.env.RECOVERY_LOG || path.join(__dirname, 'data', 'court-recovery.json');
const AUTO_RESUME = /^(1|true|yes)$/i.test(process.env.AUTO_RESUME || '');
const COLLECTOR = path.join(__dirname, 'scripts', 'laptop-collector.ps1');

const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); };

function collectorRunning() {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe' OR Name='node.exe'\" | Where-Object { $_.CommandLine -match 'laptop-collector\\.ps1|laptop-worker|detail-enrich' }).Count"],
    { encoding: 'utf8' });
  return Number(String(r.stdout || '0').trim()) > 0;
}

function resumeCollector() {
  if (collectorRunning()) return { started: false, why: 'a collector is already running' };
  // Start it directly rather than through the scheduled task: enabling a task
  // from inside a task needs rights this process does not have (0x80070005).
  const child = spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', COLLECTOR],
    { cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { started: true, pid: child.pid };
}

async function main() {
  const startedAt = new Date().toISOString();
  const history = readJson(LOG, { checks: [] });
  const latchedBefore = gate.status().blocked;

  // Only meaningful while the gate is shut. Probing a healthy system just competes
  // with the collector for the lock, and on 2026-09-09 the resulting COURT_BUSY was
  // mistaken for a block and latched the gate mid-morning - stopping collection on
  // the one day those winning prices were there to take.
  if (!latchedBefore) {
    console.log(JSON.stringify({ at: startedAt, skipped: 'gate is open; nothing to check' }, null, 2));
    return;
  }

  // Lift the latch only for this one probe, so the gate's own refusal cannot make
  // recovery undetectable. It goes straight back on unless the probe truly passes.
  gate.clearLatch();

  let entry;
  try {
    // Pick a case whose 기일 is today or later: while the source still carries it,
    // a healthy response has a populated dma_result. An empty one means either a
    // block or that the case has aged out, so we also check the block marker.
    const rows = readJson(DATA, []);
    const subject = rows.find(r => VALID_CASE.test(String(r.caseNumber || '').trim())
      && r.saleDate >= kstDay(Date.now()));
    if (!subject) throw new Error('no live case in canonical to probe with');

    const { res, text } = await gate.request(BASE + DETAIL_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json;charset=UTF-8',
        accept: 'application/json,*/*',
        'user-agent': 'Mozilla/5.0',
        'accept-language': 'ko-KR,ko;q=0.9',
        referer: BASE + '/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml',
        'sc-userid': 'SYSTEM',
        'sc-pgmid': 'PGJ151F01'
      },
      body: JSON.stringify({
        dma_srchGdsDtlSrch: {
          csNo: String(subject.caseNumber),
          cortOfcCd: String(subject.courtCode || ''),
          dspslGdsSeq: Number(subject.itemNumber || 1),
          pgmId: 'PGJ151F01'
        }
      })
    }, { owner: 'court-recovery-watch', timeoutMs: 20000 });

    let keys = 0, blockedBody = false;
    try {
      const j = JSON.parse(text);
      blockedBody = j?.data?.ipcheck === false;
      keys = Object.keys(j?.data?.dma_result || {}).length;
    } catch {}

    const nowBlocked = gate.status().blocked;
    const ok = res.ok && !blockedBody && !nowBlocked && keys > 0;
    entry = {
      at: startedAt,
      probe: DETAIL_PATH,
      probedCase: subject.caseNumber,
      httpStatus: res.status,
      resultKeys: keys,
      ipcheckFalse: blockedBody,
      recovered: ok,
      stillBlocked: !!nowBlocked || blockedBody,
      note: ok ? 'case detail came back populated' : 'case detail still refused or empty'
    };
    // Only ever restore the latch that was already there. This probe never
    // invents a new reason to shut the gate.
    if (!ok && !gate.status().blocked) gate.latch(latchedBefore.reason, 'court-recovery-watch');
  } catch (e) {
    // COURT_BUSY / COURT_UNGATED are our own plumbing, not the court refusing.
    const localFault = e.code === 'COURT_BUSY' || e.code === 'COURT_UNGATED';
    entry = {
      at: startedAt,
      probe: DETAIL_PATH,
      recovered: false,
      inconclusive: localFault || undefined,
      error: `${e.code || ''}:${e.message || e}`.slice(0, 300),
      note: localFault ? 'could not test - the gate was in use' : 'case detail still refused'
    };
    if (!gate.status().blocked) gate.latch(latchedBefore.reason, 'court-recovery-watch');
  }

  if (entry.recovered && AUTO_RESUME) {
    const resumed = resumeCollector();
    entry.resume = resumed;
    console.log(`[recovery] auto-resume: ${JSON.stringify(resumed)} (BATCH_SIZE=24, no idle wait; the gate paces every request)`);
  } else if (entry.recovered) {
    entry.resume = { started: false, why: 'AUTO_RESUME is off' };
  }

  history.checks = [entry, ...(history.checks || [])].slice(0, 200);
  history.lastCheckAt = entry.at;
  history.recovered = entry.recovered;
  writeJson(LOG, history);

  console.log(JSON.stringify({ ...entry, gate: gate.status().blocked ? 'latched' : 'open' }, null, 2));
  if (entry.recovered) console.log('\n[recovery] COURT IS ANSWERING AGAIN.');
  process.exitCode = entry.recovered ? 0 : 10;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
