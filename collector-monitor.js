const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.MONITOR_PORT || 8787);
const STATUS = path.join(ROOT, 'data', 'laptop-status.json');
const STATS = path.join(ROOT, 'data', 'stats.json');
const DELTAS = path.join(ROOT, 'data', 'worker-deltas');

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
function listJson(dir){
  if(!fs.existsSync(dir)) return [];
  let out=[];
  for(const n of fs.readdirSync(dir)){
    const p=path.join(dir,n); const s=fs.statSync(p);
    if(s.isDirectory()) out=out.concat(listJson(p)); else if(n.endsWith('.json')) out.push(p);
  }
  return out;
}
function deltaSummary(){
  const files=listJson(DELTAS); let patches=0; let newest=null;
  for(const f of files){
    const j=readJson(f); patches += Number(j?.patches?.length||0);
    const t=Date.parse(j?.createdAt||''); if(Number.isFinite(t)&&(!newest||t>newest)) newest=t;
  }
  return {files:files.length, patches, newest:newest?new Date(newest).toISOString():null};
}
function snapshot(){
  const status=readJson(STATUS)||{}; const stats=readJson(STATS)||{}; const delta=deltaSummary();
  return {now:new Date().toISOString(), status, delta, canonical:{itemCount:Number(stats.itemCount||0), winningCount:Number(stats.winningCount||0), documentCount:Number(stats.documentCount||0), coverage:stats.coverage||{}, generatedAt:stats.generatedAt||null}};
}
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>법원경매 노트북 수집기</title><style>
:root{font-family:Arial,'Noto Sans KR',sans-serif;color:#eaf0f6;background:#07111f}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#07111f,#0c1727);min-height:100vh}.wrap{max-width:1100px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;gap:16px;align-items:center}.brand{font-size:25px;font-weight:800}.live{padding:9px 14px;border-radius:999px;background:#123126;color:#7ff2a7;font-weight:800}.live.off{background:#341c22;color:#ff9da8}.hero{margin-top:22px;padding:26px;border:1px solid #24344b;border-radius:20px;background:#0e1b2d}.phase{font-size:13px;color:#91a5bd}.task{font-size:30px;font-weight:850;margin-top:8px}.sub{color:#9fb0c4;margin-top:8px}.current{margin-top:16px;padding:20px;border-radius:16px;background:#11243a;border:1px solid #2b4562}.current-top{display:flex;justify-content:space-between;gap:16px;align-items:center}.current-progress{font-size:14px;color:#7fd3ff;font-weight:800}.current-case{font-size:26px;font-weight:900;margin-top:7px}.current-court{margin-top:6px;font-size:16px;color:#c9d6e4}.current-address{margin-top:7px;color:#8fa4bd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px}.card{padding:18px;border-radius:16px;background:#101f32;border:1px solid #22354d}.card span{display:block;color:#8fa4bd;font-size:13px}.card b{display:block;font-size:26px;margin-top:7px}.section{margin-top:18px;padding:20px;border-radius:18px;background:#0d1a2b;border:1px solid #21344c}.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #1c2c40}.row:last-child{border-bottom:0}.ok{color:#76efa0}.bad{color:#ff9da8}.warn{color:#ffca7a}.muted{color:#8fa4bd}.recent-item{padding:12px 0;border-bottom:1px solid #1c2c40}.recent-item:last-child{border-bottom:0}.recent-line{display:flex;justify-content:space-between;gap:14px}.recent-case{font-weight:800}.recent-meta{font-size:12px;color:#8fa4bd;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}@media(max-width:800px){.grid{grid-template-columns:repeat(2,1fr)}.task{font-size:23px}.current-case{font-size:21px}}</style></head><body><div class="wrap"><div class="top"><div class="brand">집현전 · 법원경매 수집 모니터</div><div id="live" class="live">확인 중</div></div><div class="hero"><div id="phase" class="phase">상태 확인 중</div><div id="task" class="task">노트북 수집기 상태를 불러오는 중입니다</div><div id="sub" class="sub"></div><div class="current"><div class="current-top"><span>현재 처리 중인 사건</span><b id="currentProgress" class="current-progress">-</b></div><div id="currentCase" class="current-case">회차 준비 중</div><div id="currentCourt" class="current-court"></div><div id="currentAddress" class="current-address"></div></div></div><div class="grid"><div class="card"><span>이번 회차 진행</span><b id="checked">-</b></div><div class="card"><span>이번 회차 성공</span><b id="success">-</b></div><div class="card"><span>이번 회차 실패</span><b id="failed">-</b></div><div class="card"><span>직전 회차 문서</span><b id="docs">-</b></div><div class="card"><span>이번 회차 패치</span><b id="patches">-</b></div><div class="card"><span>수집 후보</span><b id="candidates">-</b></div><div class="card"><span>잘못된 사건번호 제외</span><b id="malformed">-</b></div><div class="card"><span>대기 패치</span><b id="pending">-</b></div><div class="card"><span>전체 사건 DB</span><b id="total">-</b></div></div><div class="section"><div class="row"><span>현재 단계</span><b id="stage">-</b></div><div class="row"><span>회차 시작</span><b id="started">-</b></div><div class="row"><span>마지막 완료</span><b id="finished">-</b></div><div class="row"><span>최근 오류</span><b id="error">없음</b></div><div class="row"><span>GitHub에 아직 병합 대기 중</span><b id="delta">-</b></div></div><div class="section"><div class="row"><span><b>최근 처리 사건</b></span><span class="muted">최신순</span></div><div id="recent"></div></div></div><script>
const $=id=>document.getElementById(id); const fmt=n=>Number(n||0).toLocaleString('ko-KR'); const dt=v=>v?new Date(v).toLocaleString('ko-KR'):'-';
function esc(v){return String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))}
function taskText(p){return ({preparing:'수집 후보를 정리하고 있습니다',collecting_details:'법원 사건 상세정보를 조회하고 있습니다',completed:'이번 회차 수집을 완료했습니다',idle:'다음 회차를 기다리고 있습니다',error:'수집 중 오류가 발생했습니다'})[p]||'노트북 수집기 상태 확인 중';}
async function load(){try{const r=await fetch('/api/status?'+Date.now());const d=await r.json();const s=d.status||{};const age=Date.now()-Date.parse(s.updatedAt||0);const alive=Number.isFinite(age)&&age<15*60*1000;$('live').textContent=alive?'● 수집기 정상':'● 상태 오래됨';$('live').className='live'+(alive?'':' off');$('phase').textContent='자동 새로고침 3초 · '+dt(d.now);$('task').textContent=taskText(s.phase);$('sub').textContent=s.message||'';const total=Number(s.totalInBatch||s.lastRun?.checked||0),idx=Number(s.currentIndex||0);$('checked').textContent=total?idx+'/'+total:fmt(s.lastRun?.checked);$('success').textContent=fmt(s.batchSuccess??s.lastRun?.success);$('failed').textContent=fmt(s.batchFailed??Math.max(0,Number(s.lastRun?.checked||0)-Number(s.lastRun?.success||0)));$('docs').textContent=fmt(s.lastRun?.docsAdded);$('patches').textContent=fmt(s.lastPatchCount);$('candidates').textContent=fmt(s.candidates);$('malformed').textContent=fmt(s.skippedMalformed);$('pending').textContent=fmt(s.pendingSkipped);$('total').textContent=fmt(d.canonical?.itemCount);$('stage').textContent=s.phase||'-';$('started').textContent=dt(s.startedAt);$('finished').textContent=dt(s.finishedAt);$('error').textContent=s.lastItemError||s.lastRun?.error||s.error||'없음';$('delta').textContent=fmt(d.delta?.files)+'개 파일 / '+fmt(d.delta?.patches)+'건 패치';$('currentProgress').textContent=total?idx+' / '+total:'-';if(s.currentCaseNumber){$('currentCase').textContent=s.currentCaseNumber;$('currentCourt').textContent=s.currentCourtName||'';$('currentAddress').textContent=s.currentAddress||'';}else{$('currentCase').textContent=s.phase==='completed'?'이번 회차 완료':'현재 사건 선택 중';$('currentCourt').textContent='';$('currentAddress').textContent='';}const recent=Array.isArray(s.recentItems)?s.recentItems:[];$('recent').innerHTML=recent.length?recent.map(x=>'<div class="recent-item"><div class="recent-line"><span class="recent-case">'+esc(x.caseNumber)+' · '+esc(x.courtName)+'</span><b class="'+(x.ok?'ok':'bad')+'">'+(x.ok?'성공':'실패')+'</b></div><div class="recent-meta">'+esc(dt(x.at))+(x.address?' · '+esc(x.address):'')+(x.error?' · '+esc(x.error):'')+'</div></div>').join(''):'<div class="recent-item muted">아직 처리 기록이 없습니다.</div>';}catch(e){$('live').textContent='● 모니터 연결 실패';$('live').className='live off';}}load();setInterval(load,3000);
</script></body></html>`;

const server=http.createServer((req,res)=>{
  if(req.url.startsWith('/api/status')){res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});return res.end(JSON.stringify(snapshot()));}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(html);
});
server.on('error',e=>{if(e.code==='EADDRINUSE'){console.log(`[monitor] already running on http://localhost:${PORT}`);process.exit(0);}throw e;});
server.listen(PORT,'127.0.0.1',()=>console.log(`[monitor] http://localhost:${PORT}`));
