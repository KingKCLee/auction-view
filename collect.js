const fs=require('fs');
const path=require('path');

const COURT_CODE='B000240';
const COURT_NAME='인천지방법원';
const REGION='인천광역시';
const FROM_YEAR=1990;
const DATA_DIR=path.join(__dirname,'data');
const AUCTIONS=path.join(DATA_DIR,'auctions.json');
const STATS=path.join(DATA_DIR,'stats.json');
const STATE=path.join(DATA_DIR,'state.json');
fs.mkdirSync(DATA_DIR,{recursive:true});

const read=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return f}};
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2));
const int=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(String(v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?Math.trunc(n):null};
const num=v=>{if(v===null||v===undefined||v==='')return null;const n=Number(String(v).replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:null};
const text=v=>{if(v==null)return'';if(typeof v==='string'||typeof v==='number'||typeof v==='boolean')return String(v);if(Array.isArray(v))return v.map(text).filter(Boolean).join(' / ');for(const k of ['name','label','small','medium','large','value','text'])if(v[k]!=null&&typeof v[k]!=='object')return String(v[k]);return''};
const date=v=>{if(!v)return null;const s=String(v).replace(/[^0-9]/g,'');return s.length>=8?`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`:String(v)};
const money=(r,keys)=>{for(const k of keys){const n=int(r?.[k]);if(n!==null)return n}return null};

function normalize(x,saleDate){
 const r=x?.raw||x||{};
 const winningPrice=money(r,['winningPrice','naksalAmt','naksalPrice','maeAmt','maxmaePrice','selPrice','bidPrice','salePrice']);
 const appraisedPrice=money(r,['gamevalAmt','appraisedPrice','gamPrice','appraisalPrice']);
 const minimumPrice=money(r,['minmaePrice','minimumSalePrice','minimumPrice','minPrice']);
 const caseNumber=text(r.srnSaNo||r.userCsNo||r.caseNumber||r.csNo);
 const itemNumber=text(r.maemulSer||r.mokmulSer||r.itemNumber||r.mokmulNo||1);
 if(!caseNumber)return null;
 return {
  id:`${COURT_CODE}|${caseNumber}|${itemNumber}`,
  courtCode:text(r.boCd||r.cortOfcCd||COURT_CODE)||COURT_CODE,
  courtName:text(r.jiwonNm||r.cortSptNm||r.courtName||COURT_NAME)||COURT_NAME,
  caseNumber,itemNumber,
  usage:text(r.dspslUsgNm||r.usageName||r.usage),
  address:text(r.userStPrint||r.printSt||r.realSt||r.address),
  buildingName:text(r.buldNm||r.buildingName),
  appraisedPrice,minimumPrice,
  failedCount:int(r.yuchalCnt||r.failedCount)||0,
  saleDate:date(r.maeGiil||r.saleDate||saleDate),
  decisionDate:date(r.maegyuljGiil||r.decisionDate),
  status:text(r.mulStatcd||r.resState||r.status||r.progressStatusCode),
  winningPrice,
  winningDate:date(r.winningDate||r.naksalYmd||r.maeYmd),
  winningRatio:(winningPrice&&appraisedPrice)?Math.round(winningPrice/appraisedPrice*10000)/100:null,
  latitude:num(r.wgs84Ycordi||r.latitude),longitude:num(r.wgs84Xcordi||r.longitude),
  eventCount:0,photoCount:int(r.picCnt||r.photoCount)||0,documentCount:0,
  coverage:{base_info:1,schedule:0,winning_price:winningPrice?1:0,photos:(int(r.picCnt||r.photoCount)||0)>0?1:0,status_report:0,sale_statement:0,appraisal_summary:0,appraisal_pdf:0,transactions:0,building_registry:0,land_use:0,rights:0},
  events:[],components:[],documents:[],
  firstSeenAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),source:'대한민국 법원경매정보 공개조회'
 };
}

function merge(oldRow,newRow){
 const out={...oldRow,...newRow,firstSeenAt:oldRow.firstSeenAt||newRow.firstSeenAt,lastSeenAt:new Date().toISOString()};
 for(const k of ['appraisedPrice','minimumPrice','winningPrice','winningDate','saleDate','decisionDate','address','usage','buildingName'])if((newRow[k]===null||newRow[k]==='')&&oldRow[k]!=null)out[k]=oldRow[k];
 out.failedCount=Math.max(Number(oldRow.failedCount||0),Number(newRow.failedCount||0));
 out.photoCount=Math.max(Number(oldRow.photoCount||0),Number(newRow.photoCount||0));
 out.documentCount=Math.max(Number(oldRow.documentCount||0),Number(newRow.documentCount||0));
 out.eventCount=Math.max(Number(oldRow.eventCount||0),Number(newRow.eventCount||0));
 out.winningRatio=out.winningPrice&&out.appraisedPrice?Math.round(out.winningPrice/out.appraisedPrice*10000)/100:(oldRow.winningRatio||null);
 out.coverage={...(oldRow.coverage||{}),...(newRow.coverage||{})};
 if(out.winningPrice)out.coverage.winning_price=1;
 return out;
}

function shiftMonth(y,m,delta){
 const d=new Date(Date.UTC(y,m-1+delta,1));
 return [d.getUTCFullYear(),d.getUTCMonth()+1];
}
function prevMonth(y,m){return shiftMonth(y,m,-1)}
function ym(y,m){return `${y}-${String(m).padStart(2,'0')}`}
function monthOf(d){return ym(d.getUTCFullYear(),d.getUTCMonth()+1)}
function noticeDate(n){return Date.parse(n?.saleDate||n?.auctionDate||n?.dspslDxdyYmd||'')||0}
async function retry(fn,n=2){let e;for(let i=0;i<n;i++){try{return await fn()}catch(err){e=err;await new Promise(r=>setTimeout(r,1500*(i+1)))}}throw e}

async function importNotice(lib,notice,map){
 const detail=await retry(()=>lib.getSaleNoticeDetail(notice),2);
 const saleDate=notice?.saleDate||notice?.auctionDate||notice?.dspslDxdyYmd||detail?.notice?.saleDate||detail?.notice?.dspslDxdyYmd||null;
 let saved=0;
 for(const raw of (detail?.items||[])){
  const n=normalize(raw,saleDate);if(!n)continue;
  map.set(n.id,map.has(n.id)?merge(map.get(n.id),n):n);saved++;
 }
 return saved;
}

async function main(){
 const lib=require('court-auction-notice-search');
 const existing=read(AUCTIONS,[]);const map=new Map(existing.map(x=>[x.id,x]));
 const now=new Date();
 const cy=now.getUTCFullYear(),cm=now.getUTCMonth()+1;
 const [hy,hm]=shiftMonth(cy,cm,-2);
 const defaultState={historyYear:hy,historyMonth:hm,historyNoticeIndex:0,priorityIndex:{},runCount:0,lastRun:null,lastError:null};
 const state={...defaultState,...read(STATE,{})};
 state.priorityIndex=state.priorityIndex||{};
 let priorityFound=0,historyFound=0,lastError=null;

 // 1순위: 최신 진행물건/최근 결과. 지난달 → 이번달 → 다음달을 매 실행마다 새로 확인.
 // 월별 공고를 순환(cursor)시켜 새 공고가 들어와도 계속 최신 구간을 재점검한다.
 const priorityMonths=[shiftMonth(cy,cm,0),shiftMonth(cy,cm,1),shiftMonth(cy,cm,-1)];
 for(const [y,m] of priorityMonths){
  const month=ym(y,m);
  try{
   const res=await retry(()=>lib.searchSaleNotices({date:month,courtCode:COURT_CODE,bidType:'date'}),2);
   const list=[...(res?.items||[])].sort((a,b)=>noticeDate(b)-noticeDate(a));
   if(!list.length)continue;
   const idx=Number(state.priorityIndex[month]||0)%list.length;
   priorityFound+=await importNotice(lib,list[idx],map);
   state.priorityIndex[month]=(idx+1)%list.length;
  }catch(e){lastError=`priority ${month}: ${e.message||e}`;console.error(lastError)}
 }

 // 2순위: 최신 구간을 계속 갱신하면서, 남는 호출로 과거를 월 단위 역순 백필.
 if(state.historyYear>=FROM_YEAR){
  const month=ym(state.historyYear,state.historyMonth);
  try{
   const res=await retry(()=>lib.searchSaleNotices({date:month,courtCode:COURT_CODE,bidType:'date'}),2);
   const list=[...(res?.items||[])].sort((a,b)=>noticeDate(b)-noticeDate(a));
   let processed=0;
   if(!list.length){const [y,m]=prevMonth(state.historyYear,state.historyMonth);state.historyYear=y;state.historyMonth=m;state.historyNoticeIndex=0}
   else{
    for(let i=state.historyNoticeIndex;i<list.length&&processed<2;i++,processed++){
      historyFound+=await importNotice(lib,list[i],map);state.historyNoticeIndex=i+1;
    }
    if(state.historyNoticeIndex>=list.length){const [y,m]=prevMonth(state.historyYear,state.historyMonth);state.historyYear=y;state.historyMonth=m;state.historyNoticeIndex=0}
   }
  }catch(e){lastError=`history ${month}: ${e.message||e}`;console.error(lastError)}
 }

 // 조회 화면도 최신 매각기일이 위에 오도록 내림차순 저장.
 const rows=[...map.values()].sort((a,b)=>String(b.saleDate||'0000').localeCompare(String(a.saleDate||'0000'))||String(b.caseNumber).localeCompare(String(a.caseNumber)));
 write(AUCTIONS,rows);
 state.runCount=Number(state.runCount||0)+1;state.lastRun=new Date().toISOString();state.lastError=lastError;write(STATE,state);
 const totalMonths=(cy-FROM_YEAR)*12+cm;
 const completed=Math.max(0,(cy-state.historyYear)*12+(cm-state.historyMonth)-1);
 const coverageKeys=['base_info','schedule','winning_price','photos','status_report','sale_statement','appraisal_summary','appraisal_pdf','transactions','building_registry','land_use','rights'];
 const coverage={};for(const k of coverageKeys)coverage[k]=rows.filter(x=>Number(x.coverage?.[k]||0)===1).length;
 const stats={generatedAt:new Date().toISOString(),court:COURT_NAME,region:REGION,itemCount:rows.length,winningCount:rows.filter(x=>x.winningPrice).length,photoCount:rows.reduce((a,x)=>a+Number(x.photoCount||0),0),documentCount:rows.reduce((a,x)=>a+Number(x.documentCount||0),0),eventCount:rows.reduce((a,x)=>a+Number(x.eventCount||0),0),queuedJobs:0,errorJobs:lastError?1:0,collectionOrder:'latest-first',priorityMonths:priorityMonths.map(([y,m])=>ym(y,m)),coverage,history:{fromYear:FROM_YEAR,startYear:cy,totalMonths,completedMonths:completed,percent:Math.min(100,Math.round(completed/Math.max(1,totalMonths)*10000)/100),cursor:{year:state.historyYear,month:state.historyMonth,noticeIndex:state.historyNoticeIndex}},latestRun:{run_type:'public-collector',started_at:state.lastRun,finished_at:new Date().toISOString(),status:lastError?'partial':'done',items_found:priorityFound+historyFound,items_saved:priorityFound+historyFound,priority_items:priorityFound,history_items:historyFound,photos_saved:0,documents_saved:0,error_text:lastError},runs:[{run_type:'public-collector',started_at:state.lastRun,status:lastError?'partial':'done',items_found:priorityFound+historyFound,priority_items:priorityFound,history_items:historyFound,error_text:lastError}]};
 write(STATS,stats);console.log(JSON.stringify(stats,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
