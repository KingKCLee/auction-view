const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {chromium}=require('playwright');

const BASE='https://www.courtauction.go.kr';
const DATA=path.join(__dirname,'data','auctions.json');
const STATS=path.join(__dirname,'data','stats.json');
const PHOTO_ROOT=path.join(__dirname,'photos');
const MAX_ITEMS=6;
const MIN_DELAY=3200;
let cookie='';
let lastCall=0;

// 검증용 공개 백업 경로. 장기 수집의 1순위는 법원 원문이다.
const BOOTSTRAP_PUBLIC_PAGES={
  '2025타경509565':'https://auctionlabs.co.kr/detail/944052/'
};

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

function saveBuffer(row,buf,seq){
 if(!buf||buf.length<100)return null;
 const [ext]=extAndMime(buf);
 if(ext==='bin')return null;
 const dir=path.join(PHOTO_ROOT,safe(row.caseNumber),safe(row.itemNumber));
 fs.mkdirSync(dir,{recursive:true});
 const h=sha(buf);
 const file=`${String(seq).padStart(2,'0')}_${h.slice(0,10)}.${ext}`;
 const fp=path.join(dir,file);
 if(!fs.existsSync(fp))fs.writeFileSync(fp,buf);
 return `photos/${encodeURIComponent(safe(row.caseNumber))}/${encodeURIComponent(safe(row.itemNumber))}/${encodeURIComponent(file)}`;
}

function savePhotos(row,detail){
 const pics=detail?.data?.dma_result?.csPicLst||[];
 if(!Array.isArray(pics)||!pics.length)return [];
 const urls=[];
 let seq=0;
 for(const p of pics){
  if(!p?.picFile)continue;
  let buf;
  try{buf=Buffer.from(String(p.picFile).replace(/^data:[^;]+;base64,/,''),'base64')}catch{continue}
  const u=saveBuffer(row,buf,p.cortAuctnPicSeq||p.pageSeq||++seq);
  if(u)urls.push(u);
 }
 return [...new Set(urls)];
}

async function publicBootstrapPhotos(row){
 const pageUrl=BOOTSTRAP_PUBLIC_PAGES[row.caseNumber];
 if(!pageUrl)return [];
 let browser;
 try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({locale:'ko-KR',userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36'});
  await page.goto(pageUrl,{waitUntil:'domcontentloaded',timeout:25000});
  await page.waitForTimeout(2500);
  const raw=await page.locator('img').evaluateAll(imgs=>imgs.flatMap(img=>Array.from(img.attributes).map(a=>a.value)).filter(Boolean));
  const candidates=[...new Set(raw.flatMap(v=>String(v).split(/\s+/)).filter(v=>/B00024020250130509565[1-9]\.jpg/i.test(v)).map(v=>{try{return new URL(v,location.href).href}catch{return v}}))];
  // evaluateAll 내부 location 변환이 브라우저 컨텍스트 밖에서 불가능한 경우를 보완
  const absolute=candidates.map(v=>{try{return new URL(v,pageUrl).href}catch{return v}});
  const out=[];
  let seq=0;
  for(const src of absolute){
   try{
    const res=await page.request.get(src,{headers:{referer:pageUrl},timeout:20000});
    if(!res.ok())continue;
    const u=saveBuffer(row,await res.body(),++seq);
    if(u)out.push(u);
   }catch{}
  }
  return [...new Set(out)];
 }catch(e){
  console.error(`bootstrap ${row.caseNumber}: ${e.message||e}`);
  return [];
 }finally{if(browser)await browser.close()}
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
  let urls=[];
  try{
   const detail=await getItemDetail(row);
   urls=savePhotos(row,detail);
   row.photoSource='court-detail';
  }catch(e){
   lastError=`${row.caseNumber}: ${e.message||e}`;
   console.error(lastError);
   cookie='';
   urls=await publicBootstrapPhotos(row);
   if(urls.length)row.photoSource='public-bootstrap';
  }
  if(urls.length){
   row.photoUrls=urls;row.photoCount=urls.length;row.coverage={...(row.coverage||{}),photos:1};saved+=urls.length;itemSuccess++;
  }
  row.photoCheckedAt=new Date().toISOString();
 }
 write(DATA,rows);
 stats.generatedAt=new Date().toISOString();
 stats.photoCount=rows.reduce((n,x)=>n+Number(x.photoUrls?.length||0),0);
 stats.coverage={...(stats.coverage||{}),photos:rows.filter(x=>(x.photoUrls?.length||0)>0).length};
 stats.latestPhotoRun={checked:ranked.length,success:itemSuccess,photosSaved:saved,error:lastError,finishedAt:new Date().toISOString()};
 write(STATS,stats);
 console.log(JSON.stringify(stats.latestPhotoRun,null,2));
}

main().catch(e=>{console.error(e);process.exitCode=1});
