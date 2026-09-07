const fs=require('fs');
const path=require('path');

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
const money=(obj,keys)=>{for(const k of keys){const n=int(obj?.[k]);if(n!==null)return n}return null};
const SIDO=['서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시','경기도','강원특별자치도','충청북도','충청남도','전북특별자치도','전라남도','경상북도','경상남도','제주특별자치도'];

function shiftMonth(y,m,delta){const d=new Date(Date.UTC(y,m-1+delta,1));return[d.getUTCFullYear(),d.getUTCMonth()+1]}
function prevMonth(y,m){return shiftMonth(y,m,-1)}
function ym(y,m){return `${y}-${String(m).padStart(2,'0')}`}
function day(d){return d.toISOString().slice(0,10)}
function addDays(d,n){return new Date(d.getTime()+n*86400000)}
function monthRange(y,m){const a=new Date(Date.UTC(y,m-1,1));const b=new Date(Date.UTC(y,m,0));return{from:day(a),to:day(b)}}
function inferRegion(address,courtName){const a=String(address||'').trim();let sido=SIDO.find(s=>a.startsWith(s))||'';if(!sido){for(const s of SIDO){const short=s.replace(/(특별자치도|특별자치시|특별시|광역시|도)$/,'');if(String(courtName||'').includes(short)){sido=s;break}}}const p=a.split(/\s+/);const sigungu=p.find((v,i)=>i>0&&/(시|군|구)$/.test(v))||'';return{sido,sigungu}}
function usageText(x,r){const direct=text(x.usage||x.usageName||r.dspslUsgNm||r.usageName||r.usage);if(direct)return direct;const u=x.usageCodes||{};return text(u.smallName||u.mediumName||u.largeName||'')}

function normalize(x){
 const r=x?.raw||{};
 const courtCode=text(x.courtCode||r.boCd||r.cortOfcCd);
 const courtName=text(x.courtName||r.jiwonNm||r.cortSptNm||'');
 const caseNumber=text(x.caseNumber||x.displayCaseNumber||r.srnSaNo||r.userCsNo||r.caseNumber||r.csNo);
 const itemNumber=text(x.itemNumber||x.itemSeq||r.maemulSer||r.mokmulSer||r.itemNumber||r.mokmulNo||1);
 if(!caseNumber||!courtCode)return null;
 const address=text(x.address||r.userStPrint||r.printSt||r.realSt||r.address);
 const appraisedPrice=int(x.appraisedPrice??money(r,['gamevalAmt','appraisedPrice','gamPrice','appraisalPrice']));
 const minimumPrice=int(x.minimumSalePrice??x.minimumPrice??money(r,['minmaePrice','minimumSalePrice','minimumPrice','minPrice']));
 const winningPrice=int(x.winningPrice??money(r,['naksalAmt','naksalPrice','maeAmt','maxmaePrice','selPrice','bidPrice','salePrice']));
 const rg=inferRegion(address,courtName);
 const coords=x.coordinatesWgs84||{};
 return {
  id:`${courtCode}|${caseNumber}|${itemNumber}`,
  courtCode,courtName,caseNumber,itemNumber,
  usage:usageText(x,r),usageCodes:x.usageCodes||null,
  address,regionSido:rg.sido,regionSigungu:rg.sigungu,regionCodes:x.regionCodes||null,
  buildingName:text(x.buildingName||r.buldNm||r.buildingName),
  propertyDescription:text(x.propertyDescription||r.gdsSpcfcCtt||''),
  appraisedPrice,minimumPrice,
  failedCount:int(x.flbdCount??r.yuchalCnt??r.failedCount)||0,
  saleDate:date(x.saleDate||r.maeGiil||r.saleDate),
  decisionDate:date(r.maegyuljGiil||r.decisionDate),
  status:text(x.progressStatusCode||x.statusCode||r.mulStatcd||r.resState||r.status||r.progressStatusCode),
  winningPrice,winningDate:date(x.winningDate||r.winningDate||r.naksalYmd||r.maeYmd),
  winningRatio:(winningPrice&&appraisedPrice)?Math.round(winningPrice/appraisedPrice*10000)/100:null,
  latitude:num(coords.lat??coords.latitude??coords.y??r.wgs84Ycordi||r.latitude),
  longitude:num(coords.lng??coords.longitude??coords.x??r.wgs84Xcordi||r.longitude),
  areaRange:x.areaRange||null,buildingList:Array.isArray(x.buildingList)?x.buildingList:[],areaList:Array.isArray(x.areaList)?x.areaList:[],landCategoryList:Array.isArray(x.landCategoryList)?x.landCategoryList:[],
  eventCount:0,photoCount:int(r.picCnt||r.photoCount)||0,documentCount:0,
  coverage:{base_info:1,schedule:0,winning_price:winningPrice?1:0,photos:(int(r.picCnt||r.photoCount)||0)>0?1:0,status_report:0,sale_statement:0,appraisal_summary:0,appraisal_pdf:0,transactions:0,building_registry:0,land_use:0,rights:0},
  events:[],components:[],documents:[],
  firstSeenAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),source:'대한민국 법원경매정보 공개조회'
 };
}

function merge(oldRow,newRow){
 const out={...oldRow,...newRow,firstSeenAt:oldRow.firstSeenAt||newRow.firstSeenAt,lastSeenAt:new Date().toISOString()};
 for(const k of ['appraisedPrice','minimumPrice','winningPrice','winningDate','saleDate','decisionDate','address','usage','buildingName','propertyDescription','regionSido','regionSigungu'])if((newRow[k]===null||newRow[k]==='')&&oldRow[k]!=null)out[k]=oldRow[k];
 for(const k of ['photoUrls','events','components','documents','buildingList','areaList','landCategoryList'])if((!Array.isArray(newRow[k])||!newRow[k].length)&&Array.isArray(oldRow[k]))out[k]=oldRow[k];
 out.failedCount=Math.max(Number(oldRow.failedCount||0),Number(newRow.failedCount||0));out.photoCount=Math.max(Number(oldRow.photoCount||0),Number(newRow.photoCount||0));out.documentCount=Math.max(Number(oldRow.documentCount||0),Number(newRow.documentCount||0));out.eventCount=Math.max(Number(oldRow.eventCount||0),Number(newRow.eventCount||0));
 out.winningRatio=out.winningPrice&&out.appraisedPrice?Math.round(out.winningPrice/out.appraisedPrice*10000)/100:(oldRow.winningRatio||null);
 out.coverage={};const keys=new Set([...Object.keys(oldRow.coverage||{}),...Object.keys(newRow.coverage||{})]);for(const k of keys)out.coverage[k]=Math.max(Number(oldRow.coverage?.[k]||0),Number(newRow.coverage?.[k]||0));
 return out;
}
async function retry(fn,n=2){let e;for(let i=0;i<n;i++){try{return await fn()}catch(err){e=err;await new Promise(r=>setTimeout(r,1800*(i+1)))}}throw e}
function importRows(items,map){let n=0;for(const x of items||[]){const row=normalize(x);if(!row)continue;map.set(row.id,map.has(row.id)?merge(map.get(row.id),row):row);n++}return n}

async function main(){
 const lib=require('court-auction-notice-search');
 const existing=read(AUCTIONS,[]);const map=new Map(existing.map(x=>[x.id,x]));
 const now=new Date();const cy=now.getUTCFullYear(),cm=now.getUTCMonth()+1;const [hy,hm]=shiftMonth(cy,cm,-2);
 const state={latestPage:1,historyYear:hy,historyMonth:hm,historyPage:1,runCount:0,lastRun:null,lastError:null,...read(STATE,{})};
 let latestFound=0,historyFound=0,lastError=null;

 // 1순위: 전국 최신 진행/최근 결과를 매번 페이지1부터 갱신.
 const liveRange={from:day(addDays(now,-30)),to:day(addDays(now,90))};
 try{
  const firstPage=await retry(()=>lib.searchProperties({saleDate:liveRange,bidType:'date',page:1,pageSize:100,fallbackOnBlocked:true}),2);
  latestFound+=importRows(firstPage?.items,map);
  const p=Math.max(1,Number(state.latestPage||1));
  if(p>1){const extra=await retry(()=>lib.searchProperties({saleDate:liveRange,bidType:'date',page:p,pageSize:100,fallbackOnBlocked:true}),2);latestFound+=importRows(extra?.items,map);state.latestPage=(extra?.items||[]).length<100?1:p+1}
  else state.latestPage=(firstPage?.items||[]).length>=100?2:1;
 }catch(e){lastError=`latest nationwide: ${e.message||e}`;console.error(lastError)}

 // 2순위: 최신 구간을 확보한 뒤 전국 과거를 월 단위로 1990년까지 역순 백필.
 if(state.historyYear>=FROM_YEAR){
  const range=monthRange(state.historyYear,state.historyMonth);const p=Math.max(1,Number(state.historyPage||1));
  try{
   const res=await retry(()=>lib.searchProperties({saleDate:range,bidType:'date',page:p,pageSize:100,fallbackOnBlocked:true}),2);
   const items=res?.items||[];historyFound+=importRows(items,map);
   if(items.length<100){const [y,m]=prevMonth(state.historyYear,state.historyMonth);state.historyYear=y;state.historyMonth=m;state.historyPage=1}else state.historyPage=p+1;
  }catch(e){lastError=`history ${ym(state.historyYear,state.historyMonth)} page ${p}: ${e.message||e}`;console.error(lastError)}
 }

 const rows=[...map.values()].sort((a,b)=>String(b.saleDate||'0000').localeCompare(String(a.saleDate||'0000'))||String(b.caseNumber).localeCompare(String(a.caseNumber)));
 write(AUCTIONS,rows);state.runCount=Number(state.runCount||0)+1;state.lastRun=new Date().toISOString();state.lastError=lastError;write(STATE,state);
 const totalMonths=(cy-FROM_YEAR)*12+cm;const completed=Math.max(0,(cy-state.historyYear)*12+(cm-state.historyMonth)-1);const coverageKeys=['base_info','schedule','winning_price','photos','status_report','sale_statement','appraisal_summary','appraisal_pdf','transactions','building_registry','land_use','rights'];const coverage={};for(const k of coverageKeys)coverage[k]=rows.filter(x=>Number(x.coverage?.[k]||0)===1).length;
 const stats={generatedAt:new Date().toISOString(),court:'전국 법원',region:'전국',itemCount:rows.length,winningCount:rows.filter(x=>x.winningPrice).length,photoCount:rows.reduce((a,x)=>a+Number(x.photoCount||0),0),documentCount:rows.reduce((a,x)=>a+Number(x.documentCount||0),0),eventCount:rows.reduce((a,x)=>a+Number(x.eventCount||0),0),queuedJobs:0,errorJobs:lastError?1:0,collectionOrder:'latest-first',latestWindow:liveRange,coverage,history:{fromYear:FROM_YEAR,startYear:cy,totalMonths,completedMonths:completed,percent:Math.min(100,Math.round(completed/Math.max(1,totalMonths)*10000)/100),cursor:{year:state.historyYear,month:state.historyMonth,page:state.historyPage}},latestRun:{run_type:'public-collector',started_at:state.lastRun,finished_at:new Date().toISOString(),status:lastError?'partial':'done',items_found:latestFound+historyFound,items_saved:latestFound+historyFound,priority_items:latestFound,history_items:historyFound,error_text:lastError},runs:[{run_type:'public-collector',started_at:state.lastRun,status:lastError?'partial':'done',items_found:latestFound+historyFound,priority_items:latestFound,history_items:historyFound,error_text:lastError}]};
 write(STATS,stats);console.log(JSON.stringify(stats,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
