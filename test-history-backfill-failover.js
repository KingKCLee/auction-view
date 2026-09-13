const fs=require('fs');
const assert=require('assert');
const src=fs.readFileSync('sale-notice-history-worker.js','utf8');
assert(!src.includes('while(!err&&'), 'history backfill must not stop all courts on one recoverable error');
assert(src.includes('addDeferred(state,pk)'), 'recoverable court failures must enter the deferred retry queue');
assert(src.includes('state.saleNoticeDeferred.find(isProgressKey)'), 'deferred court/month work must be retried before normal cursor work');
assert(src.includes("opened.error?.code==='BLOCKED'||opened.transport==='blocked'"), 'hard court blocking must stop the run instead of bypassing it');
assert(src.includes('removeDeferred(state,pk)'), 'successful deferred work must leave the retry queue');
console.log('history backfill failover guard: ok');
