const fs = require('fs');
const path = require('path');
const lib = require('court-auction-notice-search');

const DATA = path.join(__dirname, 'data', 'auctions.json');
const STATS = path.join(__dirname, 'data', 'stats.json');
const STATE = path.join(__dirname, 'data', 'state.json');
const FROM_YEAR = 1990;
const PAGE_SIZE = 100;

const read = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const txt = v => v == null ? '' : String(v);
const asInt = v => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? Math.trunc(n) : null; };
function prevMonth(y, m) { const d = new Date(Date.UTC(y, m - 2, 1)); return [d.getUTCFullYear(), d.getUTCMonth() + 1]; }
function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const SIDO = ['서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시','경기도','강원특별자치도','충청북도','충청남도','전북특별자치도','전라남도','경상북도','경상남도','제주특별자치도'];
function region(address, courtName) { const a = txt(address).trim(); let sido = SIDO.find(s => a.startsWith(s)) || ''; if (!sido) for (const s of SIDO) { const short = s.replace(/(특별자치도|특별자치시|특별시|광역시|도)$/,''); if (txt(courtName).includes(short)) { sido = s; break; } } const p = a.split(/\s+/); return { sido, sigungu: p.find((v,i)=>i>0&&/(시|군|구)$/.test(v)) || '' }; }
function coverageBase(winning, photos) { return {base_info:1,schedule:0,winning_price:winning?1:0,photos:photos?1:0,status_report:0,sale_statement:0,appraisal_summary:0,appraisal_pdf:0,transactions:0,building_registry:0,land_use:0,rights:0}; }
function normalize(item) {
  const raw = item?.raw || {};
  const courtCode = txt(item.courtCode || raw.boCd);
  const courtName = txt(item.courtName || raw.jiwonNm);
  const display = txt(item.displayCaseNumber || raw.srnSaNo || raw.printCsNo);
  const internal = txt(item.caseNumber || raw.saNo);
  const caseNumber = display || internal;
  const itemNumber = txt(item.itemNumber || item.itemSeq || raw.mokmulSer || raw.maemulSer || 1);
  if (!courtCode || !caseNumber) return null;
  const address = txt(item.address || raw.realSt || raw.printSt);
  const rg = region(address, courtName);
  const appraisedPrice = asInt(item.appraisedPrice ?? raw.gamevalAmt);
  const minimumPrice = asInt(item.minimumSalePrice ?? raw.minmaePrice);
  const photoCount = asInt(raw.picCnt || raw.photoCount) || 0;
  return {
    id: `${courtCode}|${caseNumber}|${itemNumber}`,
    courtCode, courtName, caseNumber, internalCaseNumber: internal || null, itemNumber,
    usage: txt(item.usage || raw.yongdoNm || raw.mulYongdo),
    usageCodes: item.usageCodes || null,
    address, regionSido: rg.sido, regionSigungu: rg.sigungu,
    regionCodes: item.regionCodes || null,
    buildingName: txt(raw.buldNm), propertyDescription: txt(item.propertyDescription || item.remarks || raw.mulBigo),
    appraisedPrice, minimumPrice, failedCount: Number(item.flbdCount || item.failedBidCount || 0),
    saleDate: item.saleDate || null, status: txt(item.progressStatusCode || item.statusCode || item.status),
    winningPrice: null, winningDate: null, winningRatio: null,
    latitude: item.coordinatesWgs84?.y ?? null, longitude: item.coordinatesWgs84?.x ?? null,
    areaRange: item.areaRange || null,
    buildingList: item.buildingList ? [item.buildingList].flat() : [], areaList: item.areaList ? [item.areaList].flat() : [], landCategoryList: item.landCategoryList ? [item.landCategoryList].flat() : [],
    eventCount:0, photoCount, documentCount:0, coverage:coverageBase(false, photoCount>0), events:[], components:[], documents:[],
    firstSeenAt:new Date().toISOString(), lastSeenAt:new Date().toISOString(), source:'대한민국 법원경매정보 물건검색'
  };
}
function merge(a,b) {
  const o = {...a,...b,firstSeenAt:a.firstSeenAt||b.firstSeenAt,lastSeenAt:new Date().toISOString()};
  for (const k of ['appraisedPrice','minimumPrice','winningPrice','winningDate','saleDate','address','usage','buildingName','propertyDescription','regionSido','regionSigungu','latitude','longitude']) if ((b[k]===null||b[k]==='') && a[k]!=null) o[k]=a[k];
  for (const k of ['photoUrls','events','components','documents','buildingList','areaList','landCategoryList']) if ((!Array.isArray(b[k])||!b[k].length) && Array.isArray(a[k])) o[k]=a[k];
  o.failedCount=Math.max(Number(a.failedCount||0),Number(b.failedCount||0)); o.photoCount=Math.max(Number(a.photoCount||0),Number(b.photoCount||0)); o.documentCount=Math.max(Number(a.documentCount||0),Number(b.documentCount||0)); o.eventCount=Math.max(Number(a.eventCount||0),Number(b.eventCount||0));
  o.coverage={...(a.coverage||{})}; for (const [k,v] of Object.entries(b.coverage||{})) o.coverage[k]=Math.max(Number(o.coverage[k]||0),Number(v||0)); return o;
}

async function main(){
  const rows=read(DATA,[]), map=new Map(rows.map(x=>[x.id,x])), stats=read(STATS,{}), state=read(STATE,{});
  const now=new Date(); const [startY,startM]=prevMonth(now.getUTCFullYear(),now.getUTCMonth()+1);
  let y=Number(state.propertyHistoryYear||startY), m=Number(state.propertyHistoryMonth||startM), page=Number(state.propertyHistoryPage||1);
  if (y < FROM_YEAR) return;
  const from=iso(y,m,1), to=iso(y,m,lastDay(y,m)); const beforeCount=map.size; let result=null, err=null;
  try {
    const client=new lib.CourtAuctionHttpClient({timeoutMs:30000,minDelayMs:2800,jitterMs:900,maxCallsPerSession:8});
    result=await lib.searchProperties({saleDate:{from,to},bidType:'date',courtCode:'',page,pageSize:PAGE_SIZE,includeRaw:true,client,fallback:false});
    for(const item of result?.items||[]){const n=normalize(item); if(!n) continue; map.set(n.id,map.has(n.id)?merge(map.get(n.id),n):n);}
    const total=Number(result?.page?.totalCount||0), count=Number(result?.items?.length||0);
    if(!count || page*PAGE_SIZE>=total){[y,m]=prevMonth(y,m);page=1;} else page++;
  } catch(e){err=String(e.message||e); console.error('[property-history]',err); state.propertyHistoryFailureCount=Number(state.propertyHistoryFailureCount||0)+1;}
  if(!err) state.propertyHistoryFailureCount=0;
  state.propertyHistoryYear=y;state.propertyHistoryMonth=m;state.propertyHistoryPage=page;state.propertyHistoryLastRun=new Date().toISOString();state.propertyHistoryLastError=err;write(STATE,state);
  const out=[...map.values()].sort((a,b)=>String(b.saleDate||'0000').localeCompare(String(a.saleDate||'0000'))||String(b.caseNumber||'').localeCompare(String(a.caseNumber||'')));write(DATA,out);
  const added=Math.max(0,map.size-beforeCount);stats.generatedAt=new Date().toISOString();stats.itemCount=out.length;stats.coverage={...(stats.coverage||{}),base_info:out.length};stats.latestHistoryPropertyRun={from,to,pageRequested:Number(state.propertyHistoryPage===1?Math.max(1,page-1):page),returned:Number(result?.items?.length||0),totalCount:Number(result?.page?.totalCount||0),newUniqueItems:added,nextCursor:{year:y,month:m,page},status:err?'partial':'done',error:err,source:'대한민국 법원경매정보 물건검색',finishedAt:new Date().toISOString()};write(STATS,stats);console.log(JSON.stringify(stats.latestHistoryPropertyRun,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
