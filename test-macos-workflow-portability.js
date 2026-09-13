const fs=require('fs');
const p='.github/workflows/agent-current-court-sweep.yml';
const text=fs.readFileSync(p,'utf8');
const marker='  rescue-macos:';
const i=text.indexOf(marker);
if(i<0) throw new Error('rescue-macos job not found');
const rescue=text.slice(i);
if(/(^|\n)\s*run:\s*timeout\b/.test(rescue) || /(^|\n)\s*timeout\s/.test(rescue)) {
  throw new Error('macOS rescue workflow must not use GNU timeout; macOS hosted runners do not provide timeout by default');
}
if(!rescue.includes('node current-court-sweep.js')) throw new Error('macOS rescue current sweep command missing');
if(!rescue.includes('node sale-notice-history-worker.js')) throw new Error('macOS rescue history fallback missing');
if(!rescue.includes('node property-history-discovery-v2.js')) throw new Error('macOS rescue property fallback missing');
if(!rescue.includes('node sale-notice-discovery.js')) throw new Error('macOS rescue sale discovery fallback missing');
console.log('macOS rescue workflow portability guard: PASS');
