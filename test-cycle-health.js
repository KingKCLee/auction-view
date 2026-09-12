'use strict';
const assert=require('assert');
const {collectorCycleHealth}=require('./cycle-health');

const pivot='2026-09-13T00:00:00Z';
const stale={
  currentCourtSweep:{finishedAt:pivot,newUniqueItems:0},
  saleNoticeBackfill:{finishedAt:'2026-09-12T23:00:00Z',newUniqueItems:50},
  latestHistoryPropertyRun:{finishedAt:'2026-09-12T22:00:00Z',newUniqueItems:50},
  latestRun:{finished_at:'2026-09-12T21:00:00Z',newUniqueItems:50}
};
let h=collectorCycleHealth(stale);
assert.equal(h.needsBackfill,true);
assert.equal(h.needsProperty,true);
assert.equal(h.needsSaleDiscovery,true);
assert.equal(h.needsRescue,true);

h=collectorCycleHealth({...stale,saleNoticeBackfill:{finishedAt:'2026-09-13T00:01:00Z',newUniqueItems:3}});
assert.equal(h.needsProperty,false);
assert.equal(h.needsSaleDiscovery,false);
assert.equal(h.needsRescue,false);

h=collectorCycleHealth({...stale,latestHistoryPropertyRun:{finishedAt:'2026-09-13T00:02:00Z',newUniqueItems:2}});
assert.equal(h.needsSaleDiscovery,false);
assert.equal(h.needsRescue,false);

h=collectorCycleHealth({...stale,latestRun:{finished_at:'2026-09-13T00:03:00Z',items_saved:4}});
assert.equal(h.needsRescue,false);

h=collectorCycleHealth({...stale,currentCourtSweep:{finishedAt:pivot,newUniqueItems:1}});
assert.equal(h.needsBackfill,false);
assert.equal(h.needsProperty,false);
assert.equal(h.needsSaleDiscovery,false);
assert.equal(h.needsRescue,false);

console.log('cycle-health guard OK');
