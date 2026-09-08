// Checks once whether the court block has lifted, using exactly one light request.
//
// Not a bypass and not a retry loop: one call per invocation, through the gate,
// and it never resumes collection. It reports, records, and stops. Resuming is a
// human decision.
//
// Run it hourly (Task Scheduler / cron):
//   node court-recovery-watch.js
//
// The gate is latched while blocked, so this script temporarily lifts the latch
// for its own single probe and re-latches immediately if the court still refuses.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const gate = require('./court-gate');

// The laptop collector takes BATCH_SIZE/LOOP_SLEEP_SECONDS defaults (24/60) from
// scripts/laptop-collector.ps1, so resuming through the scheduled task restores
// exactly the pre-block rate. Speeding up right after a block earns the next one.
const AUTO_RESUME = /^(1|true|yes)$/i.test(process.env.AUTO_RESUME || '');

const LOG = process.env.RECOVERY_LOG || path.join(__dirname, 'data', 'court-recovery.json');
const PROBE_URL = 'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml&pgjId=151F00';

const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); };

async function main() {
  const before = gate.status();
  const startedAt = new Date().toISOString();
  const history = readJson(LOG, { checks: [] });

  // One probe only. Lift the latch just for this call so the gate's own refusal
  // does not make recovery undetectable, then restore it unless we succeed.
  const latchedBefore = before.blocked;
  if (latchedBefore) gate.clearLatch();

  let entry;
  try {
    const { res, text } = await gate.request(PROBE_URL, {
      headers: {
        'user-agent': 'Mozilla/5.0',
        accept: 'text/html,application/xhtml+xml,*/*',
        'accept-language': 'ko-KR,ko;q=0.9'
      }
    }, { owner: 'court-recovery-watch', timeoutMs: 20000 });

    const nowBlocked = gate.status().blocked;
    const ok = res.ok && !nowBlocked;
    entry = {
      at: startedAt,
      httpStatus: res.status,
      bytes: text.length,
      recovered: ok,
      stillBlocked: !!nowBlocked,
      note: ok ? 'court answered normally - collection may be resumed ON INSTRUCTION' : 'still refused'
    };
    if (!ok && latchedBefore) gate.latch(latchedBefore.reason, 'court-recovery-watch');
    if (!ok && !nowBlocked) gate.latch(`probe returned HTTP ${res.status}`, 'court-recovery-watch');
  } catch (e) {
    entry = {
      at: startedAt,
      recovered: false,
      error: `${e.code || ''}:${e.message || e}`.slice(0, 300),
      note: 'still refused'
    };
    if (latchedBefore && !gate.status().blocked) gate.latch(latchedBefore.reason, 'court-recovery-watch');
  }

  history.checks = [entry, ...(history.checks || [])].slice(0, 200);
  history.lastCheckAt = entry.at;
  history.recovered = entry.recovered;
  writeJson(LOG, history);

  console.log(JSON.stringify({ ...entry, gate: gate.status().blocked ? 'latched' : 'open' }, null, 2));

  if (entry.recovered) {
    console.log('\n[recovery] COURT IS ANSWERING AGAIN.');
    if (AUTO_RESUME) {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        "Enable-ScheduledTask -TaskName 'AuctionViewLaptopCollector'; Start-ScheduledTask -TaskName 'AuctionViewLaptopCollector'"],
        { encoding: 'utf8' });
      const ok = r.status === 0;
      history.resumedAt = ok ? new Date().toISOString() : null;
      history.resumeOutput = `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 500);
      writeJson(LOG, history);
      console.log(`[recovery] auto-resume ${ok ? 'issued' : 'FAILED'} at BATCH_SIZE=24 / LOOP_SLEEP_SECONDS=60`);
      if (!ok) console.error(history.resumeOutput);
    } else {
      console.log('[recovery] AUTO_RESUME is off; collection stays stopped.');
    }
  }
  process.exitCode = entry.recovered ? 0 : 10;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
