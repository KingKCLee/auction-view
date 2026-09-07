const fs=require('fs');
const path=require('path');
const lib=require('court-auction-notice-search');

const FROM_YEAR=1990;
const BATCH=Number(process.env.HISTORY_NOTICE_BATCH||5);
const DATA=path.join(__dirname,'data','auctions.json');
const STATS=path.join(__dirname,'data','stats.json');
const STATE=path.join(__dirname,'data','state.json');
const read=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return f}};
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2));
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

async function main(){
 const rows=read(DATA,[]),map=new Map(rows.map(x=>[x.id,x])),stats=read(STATS,{}),state=read(STATE,{}),before=map.size;
 const now=new Date();let y=Number(state.saleNoticeBackfillYear||now.getUTCFullYear()),m=Number(state.saleNoticeBackfillMonth||now.getUTCMonth()),offset=Number(state.saleNoticeBackfillOffset||0);
 if(m<1){y--;m=12} if(y<FROM_YEAR)return;
 state.saleNoticeDeferred=Array.isArray(state.saleNoticeDeferred)?state.saleNoticeDeferred:[];
 state.saleNoticeFailures=state.saleNoticeFailures||{};
 const monthKey=ym(y,m);let searched=false,processed=0,successful=0,err=null,list=[];
 const client=new lib.CourtAuctionHttpClient({timeoutMs:30000,minDelayMs:3000,jitterMs:1200,maxCallsPerSession:7});
 try{const res=await lib.searchSaleNotices({date:monthKey,courtCode:'',bidType:'date',client,includeRaw:true});list=res?.items||[];searched=true;state.saleNoticeFailures[monthKey]=0;}catch(e){err=`search ${monthKey}: ${e.message||e}`;state.saleNoticeFailures[monthKey]=Number(state.saleNoticeFailures[monthKey]||0)+1;}
 if(searched){
   if(!list.length){const [py,pm]=prev(y,m);y=py;m=pm;offset=0;}
   else{
     offset=Math.min(offset,Math.max(0,list.length-1));
     for(let i=offset;i<list.length&&processed<BATCH;i++){
       const n=list[i],nk=keyNotice(n)||`${monthKey}|${i}`;processed++;
       try{const d=await lib.getSaleNoticeDetail(n,{client,includeRaw:true});for(const item of d?.items||[]){const z=normalize(item,n);if(z)map.set(z.id,map.has(z.id)?merge(map.get(z.id),z):z)}successful++;state.saleNoticeFailures[nk]=0;offset=i+1;}
       catch(e){const c=Number(state.saleNoticeFailures[nk]||0)+1;state.saleNoticeFailures[nk]=c;err=`detail ${monthKey} #${i}: ${e.message||e}`;if(c>=2){if(!state.saleNoticeDeferred.includes(nk))state.saleNoticeDeferred.push(nk);offset=i+1;}break;}
     }
     if(offset>=list.length){const[py,pm]=prev(y,m);y=py;m=pm;offset=0;}
   }
 }else if(Number(state.saleNoticeFailures[monthKey]||0)>=2){
   if(!state.saleNoticeDeferred.includes(monthKey))state.saleNoticeDeferred.push(monthKey);
   const[py,pm]=prev(y,m);y=py;m=pm;offset=0;
 }
 const out=[...map.values()].sort((a,b)=>String(b.saleDate||'').localeCompare(String(a.saleDate||''))||String(b.caseNumber||'').localeCompare(String(a.caseNumber||'')));write(DATA,out);
 state.saleNoticeBackfillYear=y;state.saleNoticeBackfillMonth=m;state.saleNoticeBackfillOffset=offset;state.saleNoticeBackfillLastRun=new Date().toISOString();state.saleNoticeBackfillLastError=err;write(STATE,state);
 const added=Math.max(0,map.size-before);stats.generatedAt=new Date().toISOString();stats.itemCount=out.length;stats.coverage={...(stats.coverage||{}),base_info:out.length};stats.saleNoticeBackfill={cursor:{year:y,month:m,offset},processedNotices:processed,successfulNotices:successful,newUniqueItems:added,deferredCount:state.saleNoticeDeferred.length,lastError:err,source:'대한민국 법원경매정보 매각공고',finishedAt:new Date().toISOString()};write(STATS,stats);
 console.log(JSON.stringify(stats.saleNoticeBackfill,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
