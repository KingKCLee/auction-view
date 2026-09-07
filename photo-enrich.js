const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

const BASE='https://www.courtauction.go.kr';
const DATA=path.join(__dirname,'data','auctions.json');
const STATS=path.join(__dirname,'data','stats.json');
const PHOTO_ROOT=path.join(__dirname,'photos');
const MAX_ITEMS=6;
const MIN_DELAY=3200;
let cookie='';
let lastCall=0;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const safe=s=>String(s||'x').replace(/[\\/:*?"<>|\s]+/g,'_').slice(0,120);
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return null}};
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2));

async function throttle(){
 const wait=Math.max(0,MIN_DELAY-(Date.now()-lastCall))+Math.floor(Math.random()*600);
 if(wait)await sleep(wait);
 lastCall=Date.now();
}

async function fetchWithTimeout(url,opts={},ms=18000){
 const c=new AbortController();
 const t=setTimeout(()=>c.abort(),ms);
 try{return await fetch(url,{...opts,signal:c.signal})}finally{clearTimeout(t)}
}

async function warmup(){
 await throttle();
 const r=await fetchWithTimeout(BASE+'/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml&pgjId=151F00',{headers:{'user-agent':'Mozilla/5.0','accept':'text/html,application/xhtml+xml,*/*','accept-language':'ko-KR,ko;q=0.9'}},18000);
 const sc=r.headers.getSetCookie?r.headers.getSetCookie():[r.headers.get('set-cookie')].filter(Boolean);
 if(sc.length)cookie=sc.map(x=>x.split(';')[0]).join('; ');
 if(!r.ok)throw new Error('warmup HTTP '+r.status);
}

async function post(pathname,body){
 if(!cookie)await warmup();
 await throttle();
 const r=await fetchWithTimeout(BASE+pathname,{method:'POST',headers:{'content-type':'application/json;charset=UTF-8','accept':'application/json,text/plain,*/*','user-agent':'Mozilla/5.0','accept-language':'ko-KR,ko;q=0.9','referer':BASE+'/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml','cookie':cookie,'sc-userid':'SYSTEM'},body:JSON.stringify(body)},18000);
 const txt=await r.text();
 let data;
 try{data=JSON.parse(txt)}catch{throw new Error('non-json '+r.status+' '+txt.slice(0,120))}
 if(data?.data?.ipcheck===false)throw new Error('BLOCKED by court site');
 if(!r.ok)throw new Error('court HTTP '+r.status);
 return data;
}

async function getItemDetail(row){
 return post('/pgj/pgj15B/selectAuctnCsSrchRslt.on',{dma_srchGdsDtlSrch:{csNo:String(row.caseNumber),cortOfcCd:String(row.courtCode||'B000240'),dspslGdsSeq:Number(row.itemNumber||1),pgmId:'PGJ151F01'}});
}

function extAndMime(buf){
 if(buf.length>=8&&buf.subarray(0,8).toString('hex')==='89504e470d0a1a0a')return['png','image/png'];
 if(buf.length>=3&&buf.subarray(0,3).toString('hex')==='ffd8ff')return['jpg','image/jpeg'];
 if(buf.length>=6&&['GIF87a','GIF89a'].includes(buf.subarray(0,6).toString('ascii')))return['gif','image/gif'];
 return['bin','application/octet-stream'];
}

function savePhotos(row,detail){
 const pics=detail?.data?.dma_result?.csPicLst||[];
 if(!Array.isArray(pics)||!pics.length)return [];
 const dir=path.join(PHOTO_ROOT,safe(row.caseNumber),safe(row.itemNumber));
 fs.mkdirSync(dir,{recursive:true});
 const urls=[];
 let seq=0;
 for(const p of pics){
  if(!p?.picFile)continue;
  let buf;
  try{buf=Buffer.from(String(p.picFile).replace(/^data:[^;]+;base64,/,''),'base64')}catch{continue}
  if(buf.length<100)continue;
  const [ext,mime]=extAndMime(buf);
  if(ext==='bin')continue;
  const h=sha(buf);
  const n=String(p.cortAuctnPicSeq||p.pageSeq||++seq).padStart(2,'0');
  const file=`${n}_${h.slice(0,10)}.${ext}`;
  const fp=path.join(dir,file);
  if(!fs.existsSync(fp))fs.writeFileSync(fp,buf);
  urls.push(`photos/${encodeURIComponent(safe(row.caseNumber))}/${encodeURIComponent(safe(row.itemNumber))}/${encodeURIComponent(file)}`);
 }
 return [...new Set(urls)];
}

async function main(){
 const rows=read(DATA)||[];
 const stats=read(STATS)||{};
 if(!rows.length){console.log('no rows');return}
 const today=Date.now();
 const ranked=[...rows].sort((a,b)=>{
  const ap=(a.photoUrls?.length||0)?1:0,bp=(b.photoUrls?.length||0)?1:0;
  if(ap!==bp)return ap-bp;
  const ad=Math.abs(new Date(a.saleDate||'2100-01-01').getTime()-today);
  const bd=Math.abs(new Date(b.saleDate||'2100-01-01').getTime()-today);
  return ad-bd;
 }).slice(0,MAX_ITEMS);
 let itemSuccess=0,saved=0,lastError=null;
 for(const row of ranked){
  try{
   const detail=await getItemDetail(row);
   const urls=savePhotos(row,detail);
   if(urls.length){row.photoUrls=urls;row.photoCount=urls.length;row.coverage={...(row.coverage||{}),photos:1};saved+=urls.length}
   row.photoCheckedAt=new Date().toISOString();
   itemSuccess++;
  }catch(e){lastError=`${row.caseNumber}: ${e.message||e}`;console.error(lastError);cookie='';}
 }
 write(DATA,rows);
 stats.generatedAt=new Date().toISOString();
 stats.photoCount=rows.reduce((n,x)=>n+Number(x.photoUrls?.length||x.photoCount||0),0);
 stats.coverage={...(stats.coverage||{}),photos:rows.filter(x=>(x.photoUrls?.length||0)>0).length};
 stats.latestPhotoRun={checked:ranked.length,success:itemSuccess,photosSaved:saved,error:lastError,finishedAt:new Date().toISOString()};
 write(STATS,stats);
 console.log(JSON.stringify(stats.latestPhotoRun,null,2));
}

main().catch(e=>{console.error(e);process.exitCode=1});
