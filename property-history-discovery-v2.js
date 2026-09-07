const fs=require('fs');
const path=require('path');
const lib=require('court-auction-notice-search');
const DATA=path.join(__dirname,'data','auctions.json');
const STATS=path.join(__dirname,'data','stats.json');
const STATE=path.join(__dirname,'data','state.json');
const PAGE_SIZE=100, FROM_YEAR=1990;
const read=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return f}};
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2));
const prev=(y,m)=>{const d=new Date(Date.UTC(y,m-2,1));return[d.getUTCFullYear(),d.getUTCMonth()+1]};
const iso=(y,m,d)=>`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
const lastDay=(y,m)=>new Date(Date.UTC(y,m,0)).getUTCDate();
const text=v=>v==null?'':String(v);
function norm(i){
 const raw=i?.raw||{}; const courtCode=text(i.courtCode||raw.boCd), courtName=text(i.courtName||raw.jiwonNm);
 const caseNumber=text(i.displayCaseNumber||raw.srnSaNo||raw.printCsNo||i.caseNumber||raw.saNo); const internalCaseNumber=text(i.caseNumber||raw.saNo)||null;
 const itemNumber=text(i.itemNumber||i.itemSeq||raw.mokmulSer||raw.maemulSer||1); if(!courtCode||!caseNumber)return null;
 return {id:`${courtCode}|${caseNumber}|${itemNumber}`,courtCode,courtName,caseNumber,internalCaseNumber,itemNumber,
  usage:'',usageCodes:i.usageCodes||null,address:text(i.address),regionSido:'',regionSigungu:'',regionCodes:i.regionCodes||null,buildingName:'',propertyDescription:text(i.propertyDescription||i.remarks),
  appraisedPrice:i.appraisedPrice??null,minimumPrice:i.minimumSalePrice??null,failedCount:Number(i.flbdCount||i.failedBidCount||0),saleDate:i.saleDate||null,status:text(i.progressStatusCode||i.statusCode||i.status),
  winningPrice:null,winningDate:null,winningRatio:null,latitude:i.coordinatesWgs84?.y??null,longitude:i.coordinatesWgs84?.x??null,areaRange:i.areaRange||null,
  buildingList:i.buildingList?[i.buildingList].flat():[],areaList:i.areaList?[i.areaList].flat():[],landCategoryList:i.landCategoryList?[i.landCategoryList].flat():[],eventCount:0,photoCount:0,documentCount:0,
  coverage:{base_info:1,schedule:0,winning_price:0,photos:0,status_report:0,sale_statement:0,appraisal_summary:0,appraisal_pdf:0,transactions:0,building_registry:0,land_use:0,rights:0},events:[],components:[],documents:[],firstSeenAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),source:'대한민국 법원경매정보 물건검색'};
}
function merge(a,b){const o={...a,...b,firstSeenAt:a.firstSeenAt||b.firstSeenAt,lastSeenAt:new Date().toISOString()};for(const k of ['usage','address','buildingName','propertyDescription','appraisedPrice','minimumPrice','winningPrice','winningDate','saleDate','regionSido','regionSigungu','latitude','longitude'])if((b[k]===null||b[k]==='')&&a[k]!=null)o[k]=a[k];for(const k of ['photoUrls','events','components','documents','buildingList','areaList','landCategoryList'])if((!Array.isArray(b[k])||!b[k].length)&&Array.isArray(a[k]))o[k]=a[k];o.photoCount=Math.max(Number(a.photoCount||0),Number(b.photoCount||0));o.documentCount=Math.max(Number(a.documentCount||0),Number(b.documentCount||0));o.eventCount=Math.max(Number(a.eventCount||0),Number(b.eventCount||0));o.failedCount=Math.max(Number(a.failedCount||0),Number(b.failedCount||0));o.coverage={...(a.coverage||{})};for(const[k,v]of Object.entries(b.coverage||{}))o.coverage[k]=Math.max(Number(o.coverage[k]||0),Number(v||0));return o}
async function main(){
 const rows=read(DATA,[]), map=new Map(rows.map(x=>[x.id,x])), stats=read(STATS,{}), state=read(STATE,{});const now=new Date();const[startY,startM]=prev(now.getUTCFullYear(),now.getUTCMonth()+1);
 let y=Number(state.propertyHistoryYear||startY),m=Number(state.propertyHistoryMonth||startM),page=Number(state.propertyHistoryPage||1);if(y<FROM_YEAR)return;
 const from=iso(y,m,1),to=iso(y,m,lastDay(y,m)),before=map.size;let res=null,err=null,code=null,statusCode=null;
 try{const client=new lib.CourtAuctionHttpClient({timeoutMs:35000,minDelayMs:3000,jitterMs:1200,maxCallsPerSession:7});res=await lib.searchProperties({saleDate:{from,to},bidType:'date',courtCode:'',page,pageSize:PAGE_SIZE,includeRaw:true,client,fallback:true});for(const i of res?.items||[]){const n=norm(i);if(n)map.set(n.id,map.has(n.id)?merge(map.get(n.id),n):n)}const total=Number(res?.page?.totalCount||0),cnt=Number(res?.items?.length||0);if(!cnt||page*PAGE_SIZE>=total){[y,m]=prev(y,m);page=1}else page++}catch(e){err=String(e.message||e);code=e?.code||null;statusCode=e?.statusCode||null;console.error('[property-history-v2]',code,statusCode,err)}
 state.propertyHistoryYear=y;state.propertyHistoryMonth=m;state.propertyHistoryPage=page;state.propertyHistoryLastRun=new Date().toISOString();state.propertyHistoryLastError=err;write(STATE,state);
 const out=[...map.values()].sort((a,b)=>String(b.saleDate||'').localeCompare(String(a.saleDate||''))||String(b.caseNumber||'').localeCompare(String(a.caseNumber||'')));write(DATA,out);const added=map.size-before;
 stats.generatedAt=new Date().toISOString();stats.itemCount=out.length;stats.coverage={...(stats.coverage||{}),base_info:out.length};stats.latestHistoryPropertyRun={from,to,returned:Number(res?.items?.length||0),totalCount:Number(res?.page?.totalCount||0),newUniqueItems:added,nextCursor:{year:y,month:m,page},transport:res?'property-search-http-or-browser':'failed',status:err?'partial':'done',error:err,errorCode:code,httpStatus:statusCode,source:'대한민국 법원경매정보 물건검색',finishedAt:new Date().toISOString()};write(STATS,stats);console.log(JSON.stringify(stats.latestHistoryPropertyRun,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
