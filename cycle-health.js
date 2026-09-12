'use strict';

function n(v){const x=Number(v||0);return Number.isFinite(x)?x:0}
function t(v){const x=Date.parse(v||'');return Number.isFinite(x)?x:0}
function added(run){
  if(!run||typeof run!=='object')return 0;
  if(run.newUniqueItems!==undefined)return n(run.newUniqueItems);
  if(run.items_saved!==undefined)return n(run.items_saved);
  return 0;
}
function finished(run){return t(run?.finishedAt||run?.finished_at)}
function freshAdded(run,pivot){return finished(run)>=pivot?added(run):0}

function collectorCycleHealth(stats={}){
  const c=stats.currentCourtSweep||{};
  const b=stats.saleNoticeBackfill||{};
  const h=stats.latestHistoryPropertyRun||{};
  const d=stats.latestRun||{};
  const pivot=finished(c);
  const current=added(c);
  const backfill=freshAdded(b,pivot);
  const property=freshAdded(h,pivot);
  const discovery=freshAdded(d,pivot);
  return {
    pivot,
    current,
    backfill,
    property,
    discovery,
    needsBackfill: current===0,
    needsProperty: current===0&&backfill===0,
    needsSaleDiscovery: current===0&&backfill===0&&property===0,
    needsRescue: current===0&&backfill===0&&property===0&&discovery===0
  };
}

if(require.main===module){
  const fs=require('fs');
  const mode=process.argv[2]||'json';
  const stats=JSON.parse(fs.readFileSync(process.argv[3]||'./data/stats.json','utf8'));
  const h=collectorCycleHealth(stats);
  if(mode==='json')process.stdout.write(JSON.stringify(h));
  else if(Object.prototype.hasOwnProperty.call(h,mode))process.stdout.write(String(h[mode]));
  else {console.error(`unknown health field: ${mode}`);process.exitCode=2}
}

module.exports={collectorCycleHealth};
