const fs=require('fs');
const path=require('path');
const lib=require('court-auction-notice-search');

const FROM_YEAR=1990;
const COURTS_PER_RUN=Number(process.env.HISTORY_COURTS_PER_RUN||3);
const NOTICES_PER_COURT=Number(process.env.HISTORY_NOTICES_PER_COURT||2);
const DATA=path.join(__dirname,'data','auctions.json');
const STATS=path.join(__dirname,'data','stats.json');
const STATE=path.join(__dirname,'data','state.json');
const read=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return f}};
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const txt=v=>v==null?'':String(v);
const int=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(String(v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?Math.trunc(n):null};
const date=v=>{if(!v)return null;const s=String(v).replace(/[^0-9]/g,'');return s.length>=8?`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`:String(v)};
const ym=(y,m)=>`${y}-${String(m).padStart(2,'0')}`;
const prev=(y,m)=>{const d=new Date(Date.UTC(y,m-2,1));return[d.getUTCFullYear(),d.getUTCMonth()+1]};
function keyNotice(n){const r=n?.raw||n||{};return [n?.noticeId,r.rletDspslPbancId,n?.courtCode,r.cortOfcCd,n?.saleDate,r.dspslDxdyYmd,n?.judgeDeptCode,r.jdbnCd].map(txt).join('|')}
function cov(){return{base_info:1,schedule:0,winning_price:0,photos:0,status_report:0,sale_statement:0,appraisal_summary:0,appraisal_pdf:0,transactions:0,building_registry:0,land_use:0,rights:0}}
function normalize(item,notice){
 const raw=item?.raw||{},nr=notice?.raw||{};
 const courtCode=txt(item?.courtCode||notice?.courtCode||raw.cortOfcCd||nr.cortOfcCd);
 const courtName=txt(item?.courtName||notice?.courtName||raw.cortSptNm||nr.cortSptNm||nr.jiwonNm);
 const caseNumber=txt(item?.caseNumber||item?.displayCaseNumber||raw.srnSaNo||raw.userCsNo||raw.csNo);
 const itemNumber=txt(item?.itemSeq||item?.itemNumber||raw.dspslSeq||raw.maemulSer||raw.mokmulSer||1);
 if(!courtCode||!caseNumber)return null;
 const appraisedPrice=int(item?.appraisedPrice??raw.aeeEvlAmt??raw.gamevalAmt??raw.gamPrice);
 const minimumPrice=int(item?.minimumSalePrice??raw.lwsDspslPrc??raw.minmaePrice??raw.minimumPrice);
 return {id:`${courtCode}|${caseNumber}|${itemNumber}`,courtCode,courtName,caseNumber,itemNumber,usage:txt(item?.usage||raw.usgNm||raw.dspslUsgNm),usageCodes:null,address:txt(item?.address||raw.st||raw.userStPrint||raw.printSt||raw.realSt),regionSido:'',regionSigungu:'',regionCodes:null,buildingName:txt(raw.buldNm),propertyDescription:txt(item?.remarks||raw.dspslRmk||raw.gdsSpcfcCtt),appraisedPrice,minimumPrice,failedCount:int(raw.yuchalCnt||raw.failedCount)||0,saleDate:date(notice?.saleDate||raw.dspslDxdyYmd||nr.dspslDxdyYmd),decisionDate:null,status:txt(raw.mulStatcd||raw.resState||raw.status),winningPrice:null,winningDate:null,winningRatio:null,latitude:null,longitude:null,areaRange:null,buildingList:[],areaList:[],landCategoryList:[],eventCount:0,photoCount:0,documentCount:0,coverage:cov(),events:[],components:[],documents:[],firstSeenAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),source:'대한민국 법원경매정보 매각공고(과거백필)'};
}
function merge(a,b){const o={...a,...b,firstSeenAt:a.firstSeenAt||b.firstSeenAt,lastSeenAt:new Date().toISOString()};for(const k of ['appraisedPrice','minimumPrice','winningPrice','winningDate','saleDate','address','usage','buildingName','propertyDescription','regionSido','regionSigungu'])if((b[k]===null||b[k]==='')&&a[k]!=null)o[k]=a[k];for(const k of ['photoUrls','events','components','documents','buildingList','areaList','landCategoryList'])if((!Array.isArray(b[k])||!b[k].length)&&Array.isArray(a[k]))o[k]=a[k];o.failedCount=Math.max(Number(a.failedCount||0),Number(b.failedCount||0));o.photoCount=Math.max(Number(a.photoCount||0),Number(b.photoCount||0));o.documentCount=Math.max(Number(a.documentCount||0),Number(b.documentCount||0));o.eventCount=Math.max(Number(a.eventCount||0),Number(b.eventCount||0));o.coverage={...(a.coverage||{})};for(const[k,v]of Object.entries(b.coverage||{}))o.coverage[k]=Math.max(Number(o.coverage[k]||0),Number(v||0));return o}

async function getCourts(rows){
 const attempts=[];
 const client=new lib.CourtAuctionHttpClient({timeoutMs:30000,minDelayMs:2200,jitterMs:800,maxCallsPerSession:5});
 try{
   const r=await lib.getCourtCodes({client});
   const seen=new Set(),courts=[];
   for(const c of r?.items||[]){const code=txt(c.code);if(code&&!seen.has(code)){seen.add(code);courts.push({code,name:txt(c.name||c.branchName)})}}
   if(courts.length)return{courts,source:'official-court-codes',attempts};
 }catch(e){attempts.push(`court-codes:${e.code||''}:${e.message||e}`)}
 finally{if(typeof client.close==='function')try{await client.close()}catch{}}
 const seen=new Set(),fallback=[];
 for(const r of rows){const code=txt(r.courtCode);if(code&&!seen.has(code)){seen.add(code);fallback.push({code,name:txt(r.courtName)})}}
 return{courts:fallback,source:'existing-db-court-codes',attempts};
}

async function openNoticeMonth(monthKey,courtCode){
 const attempts=[];
 const http=new lib.CourtAuctionHttpClient({timeoutMs:30000,minDelayMs:2600,jitterMs:1000,maxCallsPerSession:6});
 try{const res=await lib.searchSaleNotices({date:monthKey,courtCode,bidType:'date',client:http,includeRaw:true});return{res,client:http,transport:'http',attempts}}
 catch(e){attempts.push(`http:${e.code||''}:${e.message||e}`);if(e?.code==='BLOCKED'){if(typeof http.close==='function')try{await http.close()}catch{};return{error:e,attempts,transport:'blocked'}}}
 if(typeof http.close==='function')try{await http.close()}catch{}
 if(typeof lib.CourtAuctionPlaywrightClient==='function'){
   const browser=new lib.CourtAuctionPlaywrightClient({preferRuntime:false,headless:true,timeoutMs:45000});
   try{const res=await lib.searchSaleNotices({date:monthKey,courtCode,bidType:'date',client:browser,includeRaw:true});return{res,client:browser,transport:'browser',attempts}}
   catch(e){attempts.push(`browser:${e.code||''}:${e.message||e}`);try{await browser.close()}catch{};return{error:e,attempts,transport:'failed'}}
 }
 return{error:new Error(attempts.join(' | ')||'no transport'),attempts,transport:'failed'};
}

async function main(){
 const rows=read(DATA,[]),map=new Map(rows.map(x=>[x.id,x])),stats=read(STATS,{}),state=read(STATE,{}),before=map.size;
 const now=new Date();const[defaultY,defaultM]=prev(now.getUTCFullYear(),now.getUTCMonth()+1);
 let y=Number(state.saleNoticeBackfillYear||defaultY),m=Number(state.saleNoticeBackfillMonth||defaultM),courtIndex=Number(state.saleNoticeBackfillCourtIndex||0);
 if(y<FROM_YEAR)return;
 state.saleNoticeDeferred=Array.isArray(state.saleNoticeDeferred)?state.saleNoticeDeferred:[];
 state.saleNoticeFailures=state.saleNoticeFailures||{};
 state.saleNoticeCourtOffsets=state.saleNoticeCourtOffsets||{};
 const courtResult=await getCourts(rows),courts=courtResult.courts||[];
 let scanned=0,processed=0,successful=0,err=null,transports=[],attempts=[...(courtResult.attempts||[])],monthKey=ym(y,m),lastCourt=null;
 if(!courts.length){err='no court codes available';}
 while(!err&&scanned<COURTS_PER_RUN&&y>=FROM_YEAR&&courts.length){
   if(courtIndex>=courts.length){[y,m]=prev(y,m);monthKey=ym(y,m);courtIndex=0;continue;}
   const court=courts[courtIndex],courtCode=court.code;lastCourt=courtCode;scanned++;
   const progressKey=`${monthKey}|${courtCode}`,offset=Number(state.saleNoticeCourtOffsets[progressKey]||0);
   const opened=await openNoticeMonth(monthKey,courtCode);transports.push(`${courtCode}:${opened.transport}`);attempts.push(...(opened.attempts||[]));
   if(!opened.res){
     const fk=`search|${progressKey}`,count=Number(state.saleNoticeFailures[fk]||0)+1;state.saleNoticeFailures[fk]=count;
     if(count>=2){if(!state.saleNoticeDeferred.includes(progressKey))state.saleNoticeDeferred.push(progressKey);courtIndex++;}
     err=`${courtCode} ${monthKey}: ${opened.error?.message||opened.error}`;
     continue;
   }
   state.saleNoticeFailures[`search|${progressKey}`]=0;
   const list=opened.res?.items||[],client=opened.client;
   if(!list.length){state.saleNoticeCourtOffsets[progressKey]=-1;courtIndex++;if(client&&typeof client.close==='function')try{await client.close()}catch{};await sleep(1200+Math.floor(Math.random()*800));continue;}
   let nextOffset=Math.max(0,Math.min(offset,list.length));let local=0;
   while(nextOffset<list.length&&local<NOTICES_PER_COURT){
     const n=list[nextOffset],nk=keyNotice(n)||`${progressKey}|${nextOffset}`;processed++;local++;
     try{
       const d=await lib.getSaleNoticeDetail(n,{client,includeRaw:true});
       for(const item of d?.items||[]){const z=normalize(item,n);if(z)map.set(z.id,map.has(z.id)?merge(map.get(z.id),z):z)}
       successful++;state.saleNoticeFailures[nk]=0;nextOffset++;state.saleNoticeCourtOffsets[progressKey]=nextOffset;
       await sleep(2800+Math.floor(Math.random()*1200));
     }catch(e){
       const c=Number(state.saleNoticeFailures[nk]||0)+1;state.saleNoticeFailures[nk]=c;err=`detail ${progressKey} #${nextOffset}: ${e.message||e}`;
       if(c>=2){if(!state.saleNoticeDeferred.includes(nk))state.saleNoticeDeferred.push(nk);nextOffset++;state.saleNoticeCourtOffsets[progressKey]=nextOffset;}
       break;
     }
   }
   if(client&&typeof client.close==='function')try{await client.close()}catch{}
   if(nextOffset>=list.length){state.saleNoticeCourtOffsets[progressKey]=-1;courtIndex++;}
   if(!err)await sleep(1500+Math.floor(Math.random()*900));
 }
 const out=[...map.values()].sort((a,b)=>String(b.saleDate||'').localeCompare(String(a.saleDate||''))||String(b.caseNumber||'').localeCompare(String(a.caseNumber||'')));write(DATA,out);
 state.saleNoticeBackfillYear=y;state.saleNoticeBackfillMonth=m;state.saleNoticeBackfillCourtIndex=courtIndex;state.saleNoticeBackfillLastRun=new Date().toISOString();state.saleNoticeBackfillLastError=err;write(STATE,state);
 const added=Math.max(0,map.size-before);stats.generatedAt=new Date().toISOString();stats.itemCount=out.length;stats.coverage={...(stats.coverage||{}),base_info:out.length};stats.saleNoticeBackfill={cursor:{year:y,month:m,courtIndex},courtCount:courts.length,courtsScanned:scanned,lastCourt,processedNotices:processed,successfulNotices:successful,newUniqueItems:added,deferredCount:state.saleNoticeDeferred.length,lastError:err,transport:transports,attempts,courtSource:courtResult.source,source:'대한민국 법원경매정보 매각공고(법원별)',finishedAt:new Date().toISOString()};write(STATS,stats);
 console.log(JSON.stringify(stats.saleNoticeBackfill,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
