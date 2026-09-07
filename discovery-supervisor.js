const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const STATE = path.join(__dirname, 'data', 'state.json');
const STATS = path.join(__dirname, 'data', 'stats.json');
const MAX_STEPS = Number(process.env.DISCOVERY_STEPS || 3);
const FAILS_BEFORE_DEFER = Number(process.env.FAILS_BEFORE_DEFER || 2);
const FROM_YEAR = 1990;

const read = (p, fallback = {}) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
function prevMonth(y, m) { const d = new Date(Date.UTC(y, m - 2, 1)); return [d.getUTCFullYear(), d.getUTCMonth() + 1]; }

function runOnce() {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'sale-notice-discovery.js')], {
    stdio: 'inherit', env: process.env, encoding: 'utf8'
  });
  return r.status ?? 1;
}

function patchProgress() {
  const state = read(STATE, {});
  const stats = read(STATS, {});
  const deferred = Array.isArray(state.deferredHistoryMonths) ? state.deferredHistoryMonths : [];
  stats.history = stats.history || {};
  stats.history.deferredMonths = deferred;
  stats.history.deferredCount = deferred.length;
  const rawCompleted = Number(stats.history.completedMonths || 0);
  stats.history.completedMonths = Math.max(0, rawCompleted - deferred.length);
  const total = Math.max(1, Number(stats.history.totalMonths || 1));
  stats.history.percent = Math.round(stats.history.completedMonths / total * 10000) / 100;
  stats.discoverySupervisor = {
    mode: 'non-blocking-history',
    maxSteps: MAX_STEPS,
    failsBeforeDefer: FAILS_BEFORE_DEFER,
    deferredCount: deferred.length,
    updatedAt: new Date().toISOString()
  };
  write(STATS, stats);
}

async function main() {
  for (let step = 1; step <= MAX_STEPS; step++) {
    const before = read(STATE, {});
    const y = Number(before.noticeHistoryYear || new Date().getUTCFullYear());
    const m = Number(before.noticeHistoryMonth || (new Date().getUTCMonth() + 1));
    const key = ym(y, m);
    console.log(`[supervisor] step ${step}/${MAX_STEPS}, history=${key}, offset=${before.noticeHistoryOffset || 0}`);

    runOnce();

    const state = read(STATE, {});
    const stats = read(STATS, {});
    const err = String(stats?.latestRun?.error_text || state.lastError || '');
    const historyFailed = err.includes(`history notice ${key}`);
    state.historyFailureCounts = state.historyFailureCounts || {};
    state.deferredHistoryMonths = Array.isArray(state.deferredHistoryMonths) ? state.deferredHistoryMonths : [];

    if (historyFailed) {
      state.historyFailureCounts[key] = Number(state.historyFailureCounts[key] || 0) + 1;
      console.error(`[supervisor] ${key} failed ${state.historyFailureCounts[key]} time(s)`);
      if (state.historyFailureCounts[key] >= FAILS_BEFORE_DEFER) {
        if (!state.deferredHistoryMonths.includes(key)) state.deferredHistoryMonths.push(key);
        const [py, pm] = prevMonth(y, m);
        if (py >= FROM_YEAR) {
          state.noticeHistoryYear = py;
          state.noticeHistoryMonth = pm;
          state.noticeHistoryOffset = 0;
          console.error(`[supervisor] defer ${key}; continue with ${ym(py, pm)}`);
        }
      }
      write(STATE, state);
    } else {
      state.historyFailureCounts[key] = 0;
      write(STATE, state);
      const saved = Number(stats?.latestRun?.items_saved || 0);
      console.log(`[supervisor] ${key} completed/advanced; items_saved=${saved}`);
    }

    if (step < MAX_STEPS) await sleep(12000 + Math.floor(Math.random() * 5000));
  }
  patchProgress();
}

main().catch(e => { console.error(e); process.exitCode = 1; });
