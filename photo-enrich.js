const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

const BASE='https://www.courtauction.go.kr';
const DATA=path.join(__dirname,'data','auctions.json');
const STATS=path.join(__dirname,'data','stats.json');
const PHOTO_ROOT=path.join(__dirname,'photos');
const MAX_ITEMS=Number(process.env.BATCH_SIZE||6);
const SHARD_COUNT=Math.max(1,Number(process.env.SHARD_COUNT||1));
const SHARD_INDEX=Math.max(0,Math.min(SHARD_COUNT-1,Number(process.env.SHARD_INDEX||0)));
const MIN_DELAY=3400;
const RECENT_CHECK_MS=6*60*60*1000;
let cookie='';
let lastCall=0;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const safe=s=>String(s||'x').replace(/[\\/:*?"<>|\s]+/g,'_').slice(0,120);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return null}};
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2));
function shardOf(row){const s=String(row.id||`${row.courtCode}|${row.caseNumber}|${row.itemNumber}`);let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return (h>>>0)%SHARD_COUNT}
function ymd(d){return d.toISOString().slice(0,10).replace(/-/g,'')}
function searchWindow(row){const t=Date.parse(row.saleDate||'');const base=Number.isFinite(t)?new Date(t):new Date();const a=new Date(base.getTime()-14*86400000),b=new Date(base.getTime()+14*86400000);return{bidBgngYmd:ymd(a),bidEndYmd:ymd(b),sideDvsCd:'2',menuNm:'물건상세검색'}}

async function throttle(){const wait=Math.max(0,MIN_DELAY-(Date.now()-lastCall))+Math.floor(Math.random()*700);if(wait)await sleep(wait);lastCall=Date.now();}
async function fetchWithTimeout(url,opts={},ms=22000){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{return await fetch(url,{...opts,signal:c.signal})}finally{clearTimeout(t)}}
async function warmup(){await throttle();const r=await fetchWithTimeout(BASE+'/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml',{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/133.0.0.0 Safari/537.36','accept':'text/html,application/xhtml+xml,*/*','accept-language':'ko-KR,ko;q=0.9'}},18000);const sc=r.headers.getSetCookie?r.headers.getSetCookie():[r.headers.get('set-cookie')].filter(Boolean);if(sc.length)cookie=sc.map(x=>x.split(';')[0]).join('; ');if(!r.ok)throw new Error('warmup HTTP '+r.status);}
async function postDetail(body){
  let warmupError=null;
  if(!cookie){try{await warmup()}catch(e){warmupError=e;cookie=''}}
  await throttle();
  const headers={
    'content-type':'application/json;charset=UTF-8',
    'accept':'application/json',
    'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/133.0.0.0 Safari/537.36',
    'accept-language':'ko-KR,ko;q=0.9',
    'origin':BASE,
    'referer':BASE+'/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml',
    'sc-userid':'NONUSER',
    'sc-pgmid':'PGJ15BM01'
  };
  if(cookie)headers.cookie=cookie;
  let r;
  try{r=await fetchWithTimeout(BASE+'/pgj/pgj15B/selectAuctnCsSrchRslt.on',{method:'POST',headers,body:JSON.stringify(body)},25000)}catch(e){throw new Error(`detail network ${e.message||e}${warmupError?' / warmup '+warmupError.message:''}`)}
  const raw=await r.text();let data;
  try{data=JSON.parse(raw)}catch{throw new Error(`detail non-json HTTP ${r.status}${warmupError?' / warmup '+warmupError.message:''}`)}
  if(data?.data?.ipcheck===false)throw new Error('BLOCKED by court site');
  if(!r.ok)throw new Error(`detail HTTP ${r.status}`);
  return data;
}
async function getItemDetail(row){
  const body={dma_srchGdsDtlSrch:{csNo:String(row.caseNumber),cortOfcCd:String(row.courtCode||''),dspslGdsSeq:Number(row.itemNumber||1),pgmId:'PGJ151F01',srchInfo:searchWindow(row)}};
  let last=null;
  for(let i=0;i<3;i++){
    try{return await postDetail(body)}catch(e){last=e;cookie='';if(i<2)await sleep(4500+(i*2500)+Math.floor(Math.random()*1500));}
  }
  throw last||new Error('detail fetch failed');
}
function ext(buf){if(buf.length>=8&&buf.subarray(0,8).toString('hex')==='89504e470d0a1a0a')return'png';if(buf.length>=3&&buf.subarray(0,3).toString('hex')==='ffd8ff')return'jpg';if(buf.length>=6&&['GIF87a','GIF89a'].includes(buf.subarray(0,6).toString('ascii')))return'gif';return null;}
function savePhotos(row,detail){const pics=detail?.data?.dma_result?.csPicLst||[];if(!Array.isArray(pics)||!pics.length)return [];const dir=path.join(PHOTO_ROOT,safe(row.caseNumber),safe(row.itemNumber));fs.mkdirSync(dir,{recursive:true});const urls=[];let seq=0;for(const p of pics){if(!p?.picFile)continue;let buf;try{buf=Buffer.from(String(p.picFile).replace(/^data:[^;]+;base64,/,''),'base64')}catch{continue}if(buf.length<100)continue;const e=ext(buf);if(!e)continue;const h=sha(buf);const n=String(p.cortAuctnPicSeq||p.pageSeq||++seq).padStart(2,'0');const file=`${n}_${h.slice(0,10)}.${e}`;const fp=path.join(dir,file);if(!fs.existsSync(fp))fs.writeFileSync(fp,buf);urls.push(`photos/${encodeURIComponent(safe(row.caseNumber))}/${encodeURIComponent(safe(row.itemNumber))}/${encodeURIComponent(file)}`);}return [...new Set(urls)];}
function buildCourtPhotoCoverage(rows){const m=new Map();for(const r of rows){const c=String(r.courtCode||'');if(!c)continue;if(!m.has(c))m.set(c,0);if((r.photoUrls?.length||0)>0)m.set(c,m.get(c)+1)}return m;}
function priority(row,today,courtCoverage){const has=(row.photoUrls?.length||0)>0?1:0;const courtPhotos=Number(courtCoverage.get(String(row.courtCode||''))||0);const checked=Date.parse(row.photoCheckedAt||'');const recent=Number.isFinite(checked)&&today-checked<RECENT_CHECK_MS?1:0;const t=Date.parse(row.saleDate||'');if(!Number.isFinite(t))return[has,courtPhotos,recent,4,Number.MAX_SAFE_INTEGER];const d=(t-today)/86400000;const bucket=d>=-7&&d<=60?0:d<-7&&d>=-90?1:d>60?2:3;return[has,courtPhotos,recent,bucket,Math.abs(d)];}
async function main(){
  const rows=read(DATA)||[],stats=read(STATS)||{};if(!rows.length){console.log('no rows');return}
  const today=Date.now(),courtCoverage=buildCourtPhotoCoverage(rows);
  const ranked=[...rows].filter(r=>shardOf(r)===SHARD_INDEX).sort((a,b)=>{const A=priority(a,today,courtCoverage),B=priority(b,today,courtCoverage);for(let i=0;i<A.length;i++)if(A[i]!==B[i])return A[i]-B[i];return String(a.courtCode||'').localeCompare(String(b.courtCode||''))}).slice(0,MAX_ITEMS);
  let itemSuccess=0,saved=0,lastError=null;const selectedCourts=[...new Set(ranked.map(r=>String(r.courtCode||'')).filter(Boolean))],savedCourts=new Set();
  for(const row of ranked){try{const detail=await getItemDetail(row),urls=savePhotos(row,detail);if(urls.length){row.photoUrls=urls;row.photoCount=urls.length;row.photoSource='대한민국 법원경매정보';row.coverage={...(row.coverage||{}),photos:1};saved+=urls.length;itemSuccess++;savedCourts.add(String(row.courtCode||''))}row.photoCheckedAt=new Date().toISOString()}catch(e){lastError=`${row.courtCode||''} ${row.caseNumber}: ${e.message||e}`;console.error(lastError);cookie='';row.photoCheckedAt=new Date().toISOString()}}
  write(DATA,rows);stats.generatedAt=new Date().toISOString();stats.photoCount=rows.reduce((n,x)=>n+Number(x.photoUrls?.length||0),0);stats.coverage={...(stats.coverage||{}),photos:rows.filter(x=>(x.photoUrls?.length||0)>0).length};stats.photoCourtCount=new Set(rows.filter(x=>(x.photoUrls?.length||0)>0).map(x=>String(x.courtCode||'')).filter(Boolean)).size;stats.latestPhotoRun={checked:ranked.length,success:itemSuccess,photosSaved:saved,selectedCourts,savedCourts:[...savedCourts],source:'대한민국 법원경매정보',order:'least-covered-court-first',shard:`${SHARD_INDEX+1}/${SHARD_COUNT}`,error:lastError,finishedAt:new Date().toISOString()};write(STATS,stats);console.log(JSON.stringify(stats.latestPhotoRun,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
