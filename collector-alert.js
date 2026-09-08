// The machine check for the leak this pipeline exists to stop.
//
// A case is readable only while its 기일 is today or later, and its winning price
// is decided on the day. So a case whose 기일 has passed while winningPrice is
// still empty is a permanent loss. This counts them and records the ones that
// crossed over since the last run, so the number is visible instead of silent.
//
//   node collector-alert.js            # report, exit 11 if new losses appeared
//   node collector-alert.js --quiet    # record only, always exit 0

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data', 'auctions.json');
const OUT = process.env.ALERT_OUT || path.join(__dirname, 'data', 'collection-alert.json');
const QUIET = process.argv.includes('--quiet');
const KST_MS = 9 * 3600000;
const kstDay = ms => new Date(ms + KST_MS).toISOString().slice(0, 10);

const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)); };

function main() {
  const rows = readJson(DATA, []);
  const today = kstDay(Date.now());
  const prev = readJson(OUT, { lostIds: [], history: [] });
  const prevLost = new Set(prev.lostIds || []);

  const captured = rows.filter(r => Number(r.winningPrice || 0) > 0);
  // 기일 already passed and we still have no result: the source cannot give it back.
  const lost = rows.filter(r => r.saleDate && r.saleDate < today && !Number(r.winningPrice || 0));
  const atRisk = rows.filter(r => r.saleDate === today && !Number(r.winningPrice || 0));
  const newlyLost = lost.filter(r => !prevLost.has(r.id));

  const report = {
    at: new Date().toISOString(),
    today,
    canonicalRows: rows.length,
    winningPriceCaptured: captured.length,
    permanentlyLost: lost.length,
    newlyLostSinceLastRun: newlyLost.length,
    atRiskToday: atRisk.length,
    expiredMarked: rows.filter(r => r.status === 'expired').length,
    newlyLostSample: newlyLost.slice(0, 10).map(r => ({ id: r.id, caseNumber: r.caseNumber, saleDate: r.saleDate }))
  };

  writeJson(OUT, {
    ...report,
    lostIds: lost.map(r => r.id),
    history: [report, ...(prev.history || [])].slice(0, 60)
  });

  console.log(JSON.stringify(report, null, 2));
  if (newlyLost.length) {
    console.error(`\n[alert] ${newlyLost.length} case(s) crossed their 기일 with no winning price. The source cannot return these.`);
  }
  if (atRisk.length) {
    console.error(`[alert] ${atRisk.length} case(s) have their 기일 TODAY and no winning price yet - collect them before midnight KST.`);
  }
  if (!QUIET && newlyLost.length) process.exitCode = 11;
}

main();
