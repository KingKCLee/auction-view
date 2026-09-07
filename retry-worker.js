const fs=require('fs');
const {spawnSync}=require('child_process');

const mode=process.argv[2];
const cfg={
  collect:{script:'sale-notice-discovery.js',check:s=>s?.latestRun?.error_text},
  details:{script:'detail-enrich.js',check:s=>s?.latestDetailRun?.error&&Number(s?.latestDetailRun?.success||0)===0},
  photos:{script:'photo-enrich.js',check:s=>s?.latestPhotoRun?.error&&Number(s?.latestPhotoRun?.success||0)===0}
}[mode];
if(!cfg)throw new Error('mode must be collect/details/photos');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const readStats=()=>{try{return JSON.parse(fs.readFileSync('data/stats.json','utf8'))}catch{return{}}};

(async()=>{
  const maxAttempts=3;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    console.log(`[retry-worker] ${mode} attempt ${attempt}/${maxAttempts}`);
    const r=spawnSync(process.execPath,[cfg.script],{stdio:'inherit',env:process.env});
    const stats=readStats();
    const retry=Boolean(cfg.check(stats));
    if(r.status!==0&&!retry){process.exitCode=r.status||1;return}
    if(!retry){console.log(`[retry-worker] ${mode} completed without retryable network failure`);return}
    if(attempt<maxAttempts){const wait=12000+attempt*8000+Math.floor(Math.random()*5000);console.log(`[retry-worker] transient failure; retrying in ${Math.round(wait/1000)}s`);await sleep(wait)}
  }
  console.log(`[retry-worker] ${mode} exhausted retries; next scheduled agent will continue automatically`);
})();
