const fs=require('fs');
const path=require('path');

const BASE='https://www.courtauction.go.kr';
const DATA=path.join(__dirname,'data','auctions.json');
const STATS=path.join(__dirname,'data','stats.json');
const STATUS=path.join(__dirname,'data','laptop-status.json');
const MAX_ITEMS=Number(process.env.BATCH_SIZE||4);
const SHARD_COUNT=Math.max(1,Number(process.env.SHARD_COUNT||1));
const SHARD_INDEX=Math.max(0,Math.min(SHARD_COUNT-1,Number(process.env.SHARD_INDEX||0)));
const MIN_DELAY=3400;
let cookie='';let lastCall=0;

const read=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return null}};
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const asInt=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(String(v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?Math.trunc(n):null};
const txt=v=>{if(v==null)return'';if(typeof v==='string'||typeof v==='number')return String(v);try{return JSON.stringify(v)}catch{return String(v)}};
const first=(o,keys)=>{for(const k of keys){const v=o?.[k];if(v!==undefined&&v!==null&&v!=='')return v}return null};
const normDate=v=>{if(!v)return null;const s=String(v).replace(/[^0-9]/g,'');return s.length>=8?`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`:String(v)};
function shardOf(row){const s=String(row.id||`${row.courtCode}|${row.caseNumber}|${row.itemNumber}`);let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return (h>>>0)%SHARD_COUNT}
function setWorkerStatus(patch){try{const prev=read(STATUS)||{};write(STATUS,{...prev,...patch,updatedAt:new Date().toISOString()})}catch{}}
function addRecent(entry){try{const prev=read(STATUS)||{};const recent=[entry,...(Array.isArray(prev.recentItems)?prev.recentItems:[])].slice(0,10);write(STATUS,{...prev,recentItems:recent,updatedAt:new Date().toISOString()})}catch{}}

async function throttle(){const w=Math.max(0,MIN_DELAY-(Date.now()-lastCall))+Math.floor(Math.random()*700);if(w)await sleep(w);lastCall=Date.now()}
async function timedFetch(url,opts={},ms=18000){const c=new AbortController();const t=setTimeout(()=>c.abort(),ms);try{return await fetch(url,{...opts,signal:c.signal})}finally{clearTimeout(t)}}
async function warmup(){await throttle();const r=await timedFetch(BASE+'/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml&pgjId=151F00',{headers:{'user-agent':'Mozilla/5.0','accept':'text/html,application/xhtml+xml,*/*','accept-language':'ko-KR,ko;q=0.9'}},18000);const sc=r.headers.getSetCookie?r.headers.getSetCookie():[r.headers.get('set-cookie')].filter(Boolean);if(sc.length)cookie=sc.map(x=>x.split(';')[0]).join('; ');if(!r.ok)throw new Error('warmup HTTP '+r.status)}
async function post(url,body,user='SYSTEM',pgmid='PGJ151F01'){if(!cookie)await warmup();await throttle();const r=await timedFetch(BASE+url,{method:'POST',headers:{'content-type':'application/json;charset=UTF-8','accept':'application/json,text/plain,*/*','user-agent':'Mozilla/5.0','accept-language':'ko-KR,ko;q=0.9','referer':BASE+'/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml','cookie':cookie,'sc-userid':user,'sc-pgmid':pgmid},body:JSON.stringify(body)},18000);const raw=await r.text();let j;try{j=JSON.parse(raw)}catch{throw new Error('non-json '+r.status)}if(j?.data?.ipcheck===false)throw new Error('BLOCKED by court site');if(!r.ok)throw new Error('HTTP '+r.status);return j}
async function detail(row){return post('/pgj/pgj15B/selectAuctnCsSrchRslt.on',{dma_srchGdsDtlSrch:{csNo:String(row.caseNumber),cortOfcCd:String(row.courtCode||''),dspslGdsSeq:Number(row.itemNumber||1),pgmId:'PGJ151F01'}})}
async function statusReport(row){return post('/pgj/pgj15B/selectCurstExmndc.on',{dma_srchCurstExmn:{cortOfcCd:String(row.courtCode||''),csNo:String(row.caseNumber),auctnInfOriginDvsCd:'2'}},'NONUSER','PGJ15BP01')}
function eventsOf(d){return d?.data?.dma_result?.gdsDspslDxdyLst||d?.data?.dma_result?.dspslDxdyLst||[]}
function eventResult(e){return txt(e.dspslDxdyRsltNm||e.result||e.rsltCtt||e.resResultDesc||'')}
function eventDate(e){return normDate(e.dspslDxdyYmd||e.maeGiil||e.resDate)}
function winningFrom(e){for(const k of ['winningPrice','bidPrice','salePrice','maePrc','maeAmt','sucBidPrc','dspslPrc','bidAmt','nakchalAmt','nakchalPrc','scsBidPrc']){const n=asInt(e?.[k]);if(n&&n>0)return n}const s=eventResult(e);if(/매각|낙찰/.test(s)){const n=[...s.matchAll(/([0-9][0-9,]{4,})\s*원?/g)].map(m=>asInt(m[1])).filter(Boolean);if(n.length)return Math.max(...n)}return null}
function sanitizeEvents(list){return list.map(e=>({event_date:eventDate(e),event_type:txt(e.dspslDxdyDvsNm||e.dxdyDvsNm||e.resKind||'매각기일'),amount:asInt(e.lwsDspslPrc||e.minmaePrice||e.dspslPrc||e.resAmount),result_text:eventResult(e)})).filter(e=>e.event_date||e.result_text)}
function components(r){const out=[];const groups=[['OBJECT',r.gdsDspslObjctLst],['LAND',r.rgltLandLstAll],['BUILDING',r.bldSdtrDtlLstAll],['EXTRA_BUILDING',r.gdsNotSugtBldLsstAll]];for(const [kind,list] of groups){for(const [i,x] of (Array.isArray(list)?list:[]).entries()){out.push({type:kind,sequence:String(first(x,['lstSeq','seq','mokmulSer','dspslObjctSeq'])??i+1),address:txt(first(x,['userStPrint','printSt','st','addr','ltno'])||''),structure:txt(first(x,['bldStrctNm','strctCtt','useCtt','userLstPrint','printCtt'])||''),area:Number(first(x,['area','bldArea','landArea','excluUseArea','calcArea']))||null,appraisedPrice:asInt(first(x,['aeeWevlAmt','gamevalAmt','appraisedPrice'])),note:txt(first(x,['rmk','note','bigo'])||'')})}}return out}
function priority(row,today){const t=Date.parse(row.saleDate||'');const enriched=Number(row.coverage?.schedule||0)+Number(row.coverage?.appraisal_summary||0)+Number(row.coverage?.status_report||0)+Number(row.coverage?.sale_statement||0);if(!Number.isFinite(t))return[enriched,4,999999];const d=(t-today)/86400000;const bucket=d>=-14&&d<=60?0:d<-14&&d>=-120?1:d>60?2:3;return[enriched,bucket,Math.abs(d)]}
async function main(){
 const rows=read(DATA)||[];const stats=read(STATS)||{};if(!rows.length)return;
 const today=Date.now();const ranked=[...rows].filter(r=>shardOf(r)===SHARD_INDEX).sort((a,b)=>{const A=priority(a,today),B=priority(b,today);return A[0]-B[0]||A[1]-B[1]||A[2]-B[2]}).slice(0,MAX_ITEMS);
 setWorkerStatus({phase:'collecting_details',currentIndex:0,totalInBatch:ranked.length,currentCaseNumber:null,currentCourtName:null,currentAddress:null,batchSuccess:0,batchFailed:0});
 let done=0,lastError=null,eventsAdded=0,docsAdded=0;
 for(let idx=0;idx<ranked.length;idx++){
  const row=ranked[idx];
  setWorkerStatus({phase:'collecting_details',currentIndex:idx+1,totalInBatch:ranked.length,currentCaseNumber:row.caseNumber||'',currentCourtName:row.courtName||row.courtCode||'',currentAddress:row.address||'',message:`${idx+1}/${ranked.length} · ${row.courtName||''} ${row.caseNumber||''} 상세정보 조회 중`,batchSuccess:done,batchFailed:idx-done});
  try{
   const d=await detail(row);const r=d?.data?.dma_result||{};const base=r.csBaseInfo||{};const dx=r.dspslGdsDxdyInfo||{};
   row.caseType=txt(first(base,['csNm','csTypeNm','caseName','csType'])||row.caseType||'');row.usage=row.usage||txt(first(dx,['dspslUsgNm','usageName','gdsUsgNm'])||'');row.buildingName=row.buildingName||txt(first(dx,['buldNm','buildingName'])||'');
   const ev=sanitizeEvents(eventsOf(d));if(ev.length){row.events=ev;row.eventCount=ev.length;row.coverage={...(row.coverage||{}),schedule:1};eventsAdded+=ev.length;row.failedCount=Math.max(Number(row.failedCount||0),ev.filter(x=>/유찰/.test(x.result_text)).length);const last=[...ev].filter(x=>x.event_date).sort((a,b)=>a.event_date.localeCompare(b.event_date)).at(-1);if(last?.amount)row.minimumPrice=last.amount;if(last?.event_date)row.saleDate=last.event_date;for(const e of eventsOf(d)){const w=winningFrom(e);if(w){row.winningPrice=w;row.winningDate=eventDate(e);row.winningRatio=row.appraisedPrice?Math.round(w/row.appraisedPrice*10000)/100:null;row.coverage.winning_price=1;row.status='매각'}}}
   const appraisal=Array.isArray(r.aeeWevlMnpntLst)?r.aeeWevlMnpntLst:[];const summary=appraisal.map(x=>txt(first(x,['aeeWevlMnpntCtt','mnpntCtt','ctt','note','printCtt'])||'')).filter(Boolean).join('\n');if(summary){row.appraisalSummary=summary;row.coverage={...(row.coverage||{}),appraisal_summary:1}}
   row.appraisalDate=normDate(first(base,['aeeWevlYmd','gamevalYmd','pricePointYmd'])||first(dx,['aeeWevlYmd','gamevalYmd']));row.appraisalAgency=txt(first(base,['aeeWevlInstNm','gamevalInstNm','aeeWevlCorpNm'])||'');row.claimAmount=asInt(first(base,['clmAmt','claimAmt','chungAmt','reqAmt']));row.components=components(r);if(!row.address){const c=row.components.find(x=>x.address);if(c)row.address=c.address}row.landArea=row.components.filter(x=>x.type==='LAND').reduce((n,x)=>n+(Number(x.area)||0),0)||null;row.buildingArea=row.components.filter(x=>x.type==='BUILDING').reduce((n,x)=>n+(Number(x.area)||0),0)||null;
   const saleAvailable=!!(dx.dspslGdsSpcfcEcdocId&&dx.orvParam);if(saleAvailable){row.coverage={...(row.coverage||{}),sale_statement:1};row.saleStatementAvailable=true;docsAdded++}
   try{const sr=await statusReport(row);if(sr?.data){row.coverage={...(row.coverage||{}),status_report:1};row.statusReportAvailable=true;docsAdded++}}catch(e){if(/BLOCKED/.test(String(e.message||e)))throw e}
   row.documents=[...(row.saleStatementAvailable?[{type:'매각물건명세서',source:'대한민국 법원경매정보',available:true}]:[]),...(row.statusReportAvailable?[{type:'현황조사서',source:'대한민국 법원경매정보',available:true}]:[])];row.documentCount=row.documents.length;row.detailCheckedAt=new Date().toISOString();done++;
   addRecent({at:new Date().toISOString(),ok:true,caseNumber:row.caseNumber,courtName:row.courtName||row.courtCode||'',address:row.address||'',documents:row.documentCount||0});
   setWorkerStatus({batchSuccess:done,batchFailed:(idx+1)-done,lastProcessedCase:row.caseNumber,lastProcessedOk:true});
  }catch(e){lastError=`${row.caseNumber}: ${e.message||e}`;console.error(lastError);cookie='';row.detailCheckedAt=new Date().toISOString();addRecent({at:new Date().toISOString(),ok:false,caseNumber:row.caseNumber,courtName:row.courtName||row.courtCode||'',address:row.address||'',error:String(e.message||e)});setWorkerStatus({batchSuccess:done,batchFailed:(idx+1)-done,lastProcessedCase:row.caseNumber,lastProcessedOk:false,lastItemError:String(e.message||e)})}
 }
 write(DATA,rows);stats.generatedAt=new Date().toISOString();stats.winningCount=rows.filter(x=>x.winningPrice).length;stats.eventCount=rows.reduce((n,x)=>n+Number(x.eventCount||0),0);stats.documentCount=rows.reduce((n,x)=>n+Number(x.documentCount||0),0);stats.coverage={...(stats.coverage||{})};for(const k of ['schedule','winning_price','status_report','sale_statement','appraisal_summary'])stats.coverage[k]=rows.filter(x=>Number(x.coverage?.[k]||0)===1).length;stats.latestDetailRun={checked:ranked.length,success:done,eventsAdded,docsAdded,source:'대한민국 법원경매정보',order:'latest-first',shard:`${SHARD_INDEX+1}/${SHARD_COUNT}`,error:lastError,finishedAt:new Date().toISOString()};write(STATS,stats);setWorkerStatus({currentIndex:ranked.length,totalInBatch:ranked.length,batchSuccess:done,batchFailed:ranked.length-done,currentCaseNumber:null,currentCourtName:null,currentAddress:null});console.log(JSON.stringify(stats.latestDetailRun,null,2));
}
main().catch(e=>{console.error(e);setWorkerStatus({phase:'error',error:String(e?.message||e)});process.exitCode=1});
