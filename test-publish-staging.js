const fs=require('fs');
const p='.github/workflows/agent-current-court-sweep.yml';
const s=fs.readFileSync(p,'utf8');
const good='git add -A -- data docs';
const count=s.split(good).length-1;
if(count!==2){
  console.error(`publish staging guard failed: expected 2 safe staging commands, found ${count}`);
  process.exit(1);
}
if(/git add -A data\/auctions\.json data\/stats\.json data\/state\.json data\/property-history-cursor\.json docs data\/worker-deltas/.test(s)){
  console.error('publish staging guard failed: optional-path staging bug reintroduced');
  process.exit(1);
}
console.log('publish staging optional-path guard: PASS');
