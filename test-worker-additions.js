const assert=require('assert');
const {applyPayload}=require('./apply-worker-deltas');
const rows=[{id:'B0001|2026타경1|1',courtCode:'B0001',caseNumber:'2026타경1',address:'기존'}];
const state={keep:'yes'};
const payload={
  createdAt:'2026-09-09T00:00:00.000Z',
  additions:[{id:'B0002|2026타경2|1',courtCode:'B0002',caseNumber:'2026타경2',address:'신규'}],
  patches:[{id:'B0002|2026타경2|1',set:{minimumPrice:123}}],
  statePatch:{
    currentSweepCourtIndex:7,
    saleNoticeBackfillYear:2026,
    saleNoticeBackfillMonth:8,
    saleNoticeBackfillCourtIndex:4,
    saleNoticeCourtOffsets:{'2026-08|B0002':1},
    saleNoticeFailures:{'search|2026-08|B0002':0},
    saleNoticeDeferred:[],
    propertyHistoryYear:2026,
    propertyHistoryMonth:7,
    propertyHistoryPage:2,
    unsafeSecret:'must-not-copy'
  }
};
const r=applyPayload(rows,state,payload);
assert.strictEqual(r.additions,1,'new worker record must be added');
assert.strictEqual(rows.length,2,'canonical row count must grow');
const added=rows.find(x=>x.id==='B0002|2026타경2|1');
assert(added,'new row must exist');
assert.strictEqual(added.minimumPrice,123,'patch must apply after addition in same delta');
assert.strictEqual(state.currentSweepCourtIndex,7,'safe current discovery cursor must advance');
assert.strictEqual(state.saleNoticeBackfillCourtIndex,4,'safe history court cursor must advance');
assert.strictEqual(state.saleNoticeCourtOffsets['2026-08|B0002'],1,'safe history notice offset must advance');
assert.strictEqual(state.propertyHistoryYear,2026,'safe property-history year must advance');
assert.strictEqual(state.propertyHistoryMonth,7,'safe property-history month must advance');
assert.strictEqual(state.propertyHistoryPage,2,'safe property-history page must advance');
assert.strictEqual(state.unsafeSecret,undefined,'unsafe state must never be copied');
assert.strictEqual(state.keep,'yes','existing state must survive');
const r2=applyPayload(rows,state,payload);
assert.strictEqual(r2.additions,0,'duplicate discovery must not add another row');
assert.strictEqual(r2.duplicateAdditions,1,'duplicate must be counted');
assert.strictEqual(rows.length,2,'duplicate replay must preserve row count');
console.log('worker discovery/history/property cursor guard: PASS');
