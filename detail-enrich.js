const fs=require('fs');
const path=require('path');

const gate=require('./court-gate');
const { listingDetail, rawCoords } = require('./listing-detail');
const BASE='https://www.courtauction.go.kr';
/* AUCTIONS_FILE / STATS_FILE 은 스크래치 사본에 대고 돌리기 위한 것이다 - 수집기가
   canonical 을 쥐고 있는 동안에도 추출 로직을 시험할 수 있어야 한다(photo-enrich 와 같은 규약). */
const DATA=process.env.AUCTIONS_FILE||path.join(__dirname,'data','auctions.json');
const STATS=process.env.STATS_FILE||path.join(__dirname,'data','stats.json');
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
async function warmup(){return gate.acquire('detail-enrich:warmup',async()=>{const r=await timedFetch(BASE+'/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml&pgjId=151F00',{headers:{'user-agent':'Mozilla/5.0','accept':'text/html,application/xhtml+xml,*/*','accept-language':'ko-KR,ko;q=0.9'}},18000);const sc=r.headers.getSetCookie?r.headers.getSetCookie():[r.headers.get('set-cookie')].filter(Boolean);if(sc.length)cookie=sc.map(x=>x.split(';')[0]).join('; ');if(!r.ok)throw new Error('warmup HTTP '+r.status)})}
async function post(url,body,user='SYSTEM',pgmid='PGJ151F01'){if(!cookie)await warmup();return gate.acquire('detail-enrich:'+url,async()=>{const r=await timedFetch(BASE+url,{method:'POST',headers:{'content-type':'application/json;charset=UTF-8','accept':'application/json,text/plain,*/*','user-agent':'Mozilla/5.0','accept-language':'ko-KR,ko;q=0.9','referer':BASE+'/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml','cookie':cookie,'sc-userid':user,'sc-pgmid':pgmid},body:JSON.stringify(body)},18000);const raw=await r.text();gate.inspect(raw,url);let j;try{j=JSON.parse(raw)}catch{throw new Error('non-json '+r.status)}if(j?.data?.ipcheck===false)throw new Error('BLOCKED by court site');if(!r.ok)throw new Error('HTTP '+r.status);return j})}
async function detail(row){return post('/pgj/pgj15B/selectAuctnCsSrchRslt.on',{dma_srchGdsDtlSrch:{csNo:String(row.caseNumber),cortOfcCd:String(row.courtCode||''),dspslGdsSeq:Number(row.itemNumber||1),pgmId:'PGJ151F01'}})}
async function statusReport(row){return post('/pgj/pgj15B/selectCurstExmndc.on',{dma_srchCurstExmn:{cortOfcCd:String(row.courtCode||''),csNo:String(row.caseNumber),auctnInfOriginDvsCd:'2'}},'NONUSER','PGJ15BP01')}
function eventsOf(d){return d?.data?.dma_result?.gdsDspslDxdyLst||d?.data?.dma_result?.dspslDxdyLst||[]}
// Field names measured from a live response on 2026-09-09. The names this file
// used before (dspslDxdyYmd / dspslDxdyRsltNm / dspslPrc) do not exist on these
// objects, so every event was dropped by sanitizeEvents and no winning price
// could ever be read. The real keys are dxdyYmd, auctnDxdyRsltCd and dspslAmt.
//   { dxdyYmd:'20260701', dxdyHm:'1000', dxdyPlcNm:'...',
//     auctnDxdyKndCd:'01', auctnDxdyRsltCd:'002',
//     tsLwsDspslPrc:79000000, dspslAmt:null }
// The result is a code, not text; we keep the code rather than guess its wording,
// and let dspslAmt decide whether a sale happened.
function eventResult(e){return txt(e.auctnDxdyRsltCd||e.dspslDxdyRsltNm||e.result||e.rsltCtt||e.resResultDesc||'')}
function eventDate(e){return normDate(e.dxdyYmd||e.dspslDxdyYmd||e.maeGiil||e.resDate)}
function winningFrom(e){for(const k of ['dspslAmt','winningPrice','bidPrice','salePrice','maePrc','maeAmt','sucBidPrc','dspslPrc','bidAmt','nakchalAmt','nakchalPrc','scsBidPrc']){const n=asInt(e?.[k]);if(n&&n>0)return n}return null}
function sanitizeEvents(list){return list.map(e=>({event_date:eventDate(e),event_time:txt(e.dxdyHm||''),event_kind_code:txt(e.auctnDxdyKndCd||e.dspslDxdyDvsNm||e.dxdyDvsNm||e.resKind||''),place:txt(e.dxdyPlcNm||''),amount:asInt(e.tsLwsDspslPrc||e.lwsDspslPrc||e.minmaePrice||e.resAmount),winning_amount:asInt(e.dspslAmt),result_code:eventResult(e)})).filter(e=>e.event_date)}
function components(r){const out=[];const groups=[['OBJECT',r.gdsDspslObjctLst],['LAND',r.rgltLandLstAll],['BUILDING',r.bldSdtrDtlLstAll],['EXTRA_BUILDING',r.gdsNotSugtBldLsstAll]];for(const [kind,list] of groups){for(const [i,x] of (Array.isArray(list)?list:[]).entries()){out.push({type:kind,sequence:String(first(x,['lstSeq','seq','mokmulSer','dspslObjctSeq'])??i+1),address:txt(first(x,['userStPrint','printSt','st','addr','ltno'])||''),structure:txt(first(x,['bldStrctNm','strctCtt','useCtt','userLstPrint','printCtt'])||''),area:Number(first(x,['area','bldArea','landArea','excluUseArea','calcArea']))||null,appraisedPrice:asInt(first(x,['aeeWevlAmt','gamevalAmt','appraisedPrice'])),note:txt(first(x,['rmk','note','bigo'])||'')})}}return out}
// The source publishes a case only while its 기일 is today or later and drops it
// the next day, and the winning price is decided on the day itself. So a case
// whose 기일 is today or tomorrow and whose winningPrice we do not yet hold is the
// only kind of row we can lose forever. Everything else can wait a cycle.
// Single decision point: nothing else in this file reorders the queue.
const KST_MS=9*3600000;
const kstDay=ms=>new Date(ms+KST_MS).toISOString().slice(0,10);
const COVERAGE_WANTED=['schedule','appraisal_summary','status_report','sale_statement','winning_price'];
function missingCount(row){return COVERAGE_WANTED.filter(k=>Number(row.coverage?.[k]||0)!==1).length}
// Only today's 기일 vanishes tonight. Tomorrow's is still there tomorrow, so it
// does not belong in the same tier: measured with both in tier 0, a full pass took
// 8.2 hours over 1470 cases and today's 647 got revisited about once before
// midnight. Today alone is a 1.9 hour pass and four revisits.
function expiringUncaptured(row,nowMs){
 const sd=String(row.saleDate||'');
 if(!sd)return false;
 return sd===kstDay(nowMs)&&!Number(row.winningPrice||0);
}
// Tomorrow's: next in line, ahead of the general pool but behind tonight's losses.
function expiringNext(row,nowMs){
 const sd=String(row.saleDate||'');
 if(!sd)return false;
 return sd===kstDay(nowMs+86400000)&&!Number(row.winningPrice||0);
}
function priority(row,today){
 // TIER 0 - gone from the source tonight with no winning price recorded.
 if(expiringUncaptured(row,today))return[0,-missingCount(row),0,0];
 // TIER 1 - gone tomorrow night.
 if(expiringNext(row,today))return[1,-missingCount(row),0,0];
 // TIER 2+ - the previous ordering: least-enriched first, then nearest 기일.
 const t=Date.parse(row.saleDate||'');
 const enriched=Number(row.coverage?.schedule||0)+Number(row.coverage?.appraisal_summary||0)+Number(row.coverage?.status_report||0)+Number(row.coverage?.sale_statement||0);
 if(!Number.isFinite(t))return[2,enriched,4,999999];
 const d=(t-today)/86400000;
 const bucket=d>=-14&&d<=60?0:d<-14&&d>=-120?1:d>60?2:3;
 return[2,enriched,bucket,Math.abs(d)];
}
function bidderCountFrom(e){for(const k of ['bidPrsnCnt','dspslBidPrsnCnt','scsBidPrsnCnt','bidderCnt','bidCnt','bidderCount']){const n=asInt(e?.[k]);if(n!==null&&n>=0)return n}return null}
async function main(){
 const rows=read(DATA)||[];const stats=read(STATS)||{};if(!rows.length)return;
 const today=Date.now();const ranked=[...rows].filter(r=>shardOf(r)===SHARD_INDEX).sort((a,b)=>{const A=priority(a,today),B=priority(b,today);for(let i=0;i<Math.max(A.length,B.length);i++){const d=(A[i]??0)-(B[i]??0);if(d)return d}return 0}).slice(0,MAX_ITEMS);
 setWorkerStatus({phase:'collecting_details',currentIndex:0,totalInBatch:ranked.length,currentCaseNumber:null,currentCourtName:null,currentAddress:null,batchSuccess:0,batchFailed:0});
 let done=0,lastError=null,eventsAdded=0,docsAdded=0;
 for(let idx=0;idx<ranked.length;idx++){
  const row=ranked[idx];
  setWorkerStatus({phase:'collecting_details',currentIndex:idx+1,totalInBatch:ranked.length,currentCaseNumber:row.caseNumber||'',currentCourtName:row.courtName||row.courtCode||'',currentAddress:row.address||'',message:`${idx+1}/${ranked.length} · ${row.courtName||''} ${row.caseNumber||''} 상세정보 조회 중`,batchSuccess:done,batchFailed:idx-done});
  try{
   const d=await detail(row);const r=d?.data?.dma_result||{};const base=r.csBaseInfo||{};const dx=r.dspslGdsDxdyInfo||{};
   // An empty dma_result means the source has dropped this case: it is published
   // only while its 기일 is today or later. Never delete the row - canonical is now
   // the only copy - just record that the source no longer carries it.
   if(!Object.keys(r).length){row.status='expired';row.expiredAt=row.expiredAt||new Date().toISOString();row.detailCheckedAt=new Date().toISOString();done++;addRecent({at:new Date().toISOString(),ok:true,caseNumber:row.caseNumber,courtName:row.courtName||row.courtCode||'',address:row.address||'',expired:true});setWorkerStatus({batchSuccess:done,batchFailed:(idx+1)-done,lastProcessedCase:row.caseNumber,lastProcessedOk:true});continue}
   row.caseType=txt(first(base,['csNm','csTypeNm','caseName','csType'])||row.caseType||'');row.usage=row.usage||txt(first(dx,['dspslUsgNm','usageName','gdsUsgNm'])||'');row.buildingName=row.buildingName||txt(first(dx,['buldNm','buildingName'])||'');
   const ev=sanitizeEvents(eventsOf(d));if(ev.length){row.events=ev;row.eventCount=ev.length;row.coverage={...(row.coverage||{}),schedule:1};eventsAdded+=ev.length;row.failedCount=Math.max(Number(row.failedCount||0),Number(asInt(dx.flbdNcnt)||0));const last=[...ev].filter(x=>x.event_date).sort((a,b)=>a.event_date.localeCompare(b.event_date)).at(-1);if(last?.amount)row.minimumPrice=last.amount;for(const e of eventsOf(d)){const w=winningFrom(e);if(w){row.winningPrice=w;row.winningDate=eventDate(e);row.winningRatio=row.appraisedPrice?Math.round(w/row.appraisedPrice*10000)/100:null;row.coverage.winning_price=1;row.status='매각';const bc=bidderCountFrom(e);if(bc!==null)row.bidderCount=bc}}const soldEv=[...eventsOf(d)].filter(e=>Number(asInt(e.dspslAmt)||0)>0).sort((a,b)=>String(eventDate(a)).localeCompare(String(eventDate(b)))).at(-1);if(soldEv)row.saleResult=eventResult(soldEv);// The outcome may surface on the goods-status code or the 매각결정기일 before it
// reaches the 기일 event, so both are recorded rather than waited on.
row.goodsStatusCode=txt(dx.auctnGdsStatCd||'');row.decisionDate=normDate(dx.dspslDcsnDxdyYmd);row.caseProgressCode=txt(base.csProgStatCd||'');row.caseClosedDivision=txt(base.ultmtDvsCd||'');row.caseClosedDate=normDate(base.csUltmtYmd);if(row.caseClosedDate&&!row.status)row.status='종국';}
   const appraisal=Array.isArray(r.aeeWevlMnpntLst)?r.aeeWevlMnpntLst:[];const summary=appraisal.map(x=>txt(first(x,['aeeWevlMnpntCtt','mnpntCtt','ctt','note','printCtt'])||'')).filter(Boolean).join('\n');if(summary){row.appraisalSummary=summary;row.coverage={...(row.coverage||{}),appraisal_summary:1}}
   if(!row.appraisedPrice)row.appraisedPrice=asInt(dx.aeeEvlAmt);if(dx.dspslDxdyYmd)row.saleDate=normDate(dx.dspslDxdyYmd)||row.saleDate;row.appraisalDate=normDate(first(base,['aeeWevlYmd','gamevalYmd','pricePointYmd'])||first(dx,['aeeWevlYmd','gamevalYmd']));row.appraisalAgency=txt(first(base,['aeeWevlInstNm','gamevalInstNm','aeeWevlCorpNm'])||'');row.claimAmount=asInt(first(base,['clmAmt','claimAmt','chungAmt','reqAmt']));row.components=components(r);if(!row.address){const c=row.components.find(x=>x.address);if(c)row.address=c.address}
   /* [2026-09-16] 면적은 components 로 못 구한다 - 그 함수가 ['area','bldArea',...] 라는
      **없는 키 이름**으로 찾고 있어 24,521개 항목이 전부 area:null 이었다. 실제 키는
      objctArDts·landArDts 이고 값은 숫자가 아니라 "철근콘크리트구조 59.79㎡" 문자열이다.
      listing-detail.js 가 원본 화면의 「목록내역」 그대로 읽어 온다. */
   {const L=listingDetail(r);
    if(L){row.listing=L;
      row.buildingArea=L.exclusiveArea??row.buildingArea??null;
      row.landArea=L.landShareArea??row.landArea??null;
      row.landTotalArea=L.totalLandArea??null;
      row.coverage={...(row.coverage||{}),listing:1};}}
   {const c=rawCoords(r);if(c)row.rawCoords=c;}
   /* 입찰방법 - 코드(bidDvsCd)의 뜻은 확인되지 않았다. 코드는 그대로 남기고,
      **입찰기간이 실제로 있을 때만** 기간입찰로 적는다(그건 값으로 확인된다).
      기간이 없다고 곧바로 기일입찰이라 단정하지 않는다 - 그건 아직 미확인이다. */
   row.bidMethodCode=txt(dx.bidDvsCd||'')||null;
   row.bidMethod=(row.bidPeriodFrom||row.bidPeriodTo)?'기간입찰':null;

   /* [2026-09-14] 여기까지 오는 응답에 이미 들어 있는데 버리고 있던 것들을 꺼낸다.
      법원 요청은 한 건도 늘지 않는다 - 같은 d 에서 읽을 뿐이다.
      ★값의 뜻을 모르는 코드는 글자로 바꾸지 않는다(감정요항 항목코드 등) - 코드 그대로 남긴다. */
   row.caseReceivedDate=normDate(base.csRcptYmd)||row.caseReceivedDate||null;
   row.caseStartDate=normDate(base.csCmdcYmd)||row.caseStartDate||null;
   row.courtDept=txt(base.cortAuctnJdbnNm||'')||row.courtDept||'';
   row.courtDeptTel=txt(base.jdbnTelno||'')||row.courtDeptTel||'';
   row.caseSuspendCode=txt(base.auctnSuspStatCd||'');
   row.caseSuspendReason=txt(base.csProgSuspRsn||'');
   /* 배당요구종기 - 별도 배열로 온다. 여러 건이면 가장 늦은 날짜를 쓴다. */
   {const dd=(Array.isArray(r.dstrtDemnInfo)?r.dstrtDemnInfo:[]).map(x=>normDate(x&&x.dstrtDemnLstprdYmd)).filter(Boolean).sort();
    if(dd.length)row.distributionDeadline=dd[dd.length-1];}
   /* 매각물건명세서 본문. 법원 규정상 매각기일 1주일 전부터 채워지므로, 비어 오는 것은
      결함이 아니라 아직 공개 전이다 - 그 구분이 화면에 드러나도록 작성일도 함께 둔다. */
   {const rg={assumedRights:txt(dx.ndstrcRghCtt||''),surfaceRight:txt(dx.sprfcExstcDts||''),
              seniorMortgage:txt(dx.tprtyRnkHypthcStngDts||''),statementNote:txt(dx.gdsSpcfcRmk||''),
              goodsNote:txt(dx.dspslGdsRmk||''),writtenAt:normDate(dx.gdsSpcfcWrtYmd)};
    const any=Object.values(rg).some(Boolean);
    if(any){row.rights=rg;row.coverage={...(row.coverage||{}),rights:1}}}
   /* 회차별 최저가·입찰기간·장소·보증금비율 */
   {const rounds=[dx.fstPbancLwsDspslPrc,dx.scndPbancLwsDspslPrc,dx.thrdPbancLwsDspslPrc,dx.fothPbancLwsDspslPrc]
      .map(asInt).filter(x=>x&&x>0);
    if(rounds.length)row.minimumPriceRounds=rounds;}
   row.bidPeriodFrom=normDate(dx.bidBgngYmd)||null;
   row.bidPeriodTo=normDate(dx.bidEndYmd)||null;
   row.salePlace=txt(dx.dspslPlcNm||'');
   row.decisionPlace=txt(dx.dspslDcsnPlcNm||'');
   {const dr=Number(dx.prchDposRate);if(Number.isFinite(dr)&&dr>0)row.depositRate=dr;}
   /* 감정 요항 - 지금까지는 본문을 줄바꿈으로 이어 붙인 요약 한 덩어리만 남겼다.
      항목이 10개면 10개로 남긴다(순번·항목코드·본문). 코드의 뜻은 모르므로 붙이지 않는다. */
   {const pts=(Array.isArray(r.aeeWevlMnpntLst)?r.aeeWevlMnpntLst:[])
      .map(x=>({seq:Number(x&&x.aeeWevlMnpntDtlSeq)||null,itemCode:txt((x&&x.aeeWevlMnpntItmCd)||''),
                content:txt(first(x,['aeeWevlMnpntCtt','mnpntCtt','ctt'])||'')}))
      .filter(x=>x.content);
    if(pts.length)row.appraisalPoints=pts;}
   const saleAvailable=!!(dx.dspslGdsSpcfcEcdocId&&dx.orvParam);if(saleAvailable){row.coverage={...(row.coverage||{}),sale_statement:1};row.saleStatementAvailable=true;docsAdded++}
   // Every request spent on the 현황조사서 is one not spent re-polling a 기일 that
   // is about to expire. Skipping only when the answer was "yes" barely helped:
   // ~88% of cases have no 현황조사서, so the check stayed true and they were asked
   // again on every pass. A case we have already visited and that is expiring today
   // needs only the result, so its re-check costs one request instead of two.
   const isRecheck=Boolean(row.detailCheckedAt);
   const askStatusReport=!(isRecheck&&expiringUncaptured(row,today))
     &&(row.statusReportAvailable===undefined||Number(row.coverage?.status_report||0)!==1);
   if(askStatusReport){
    /* [2026-09-14] 전에는 이 응답을 받아 놓고 있다/없다만 보고 버렸다. 그 안에 점유관계
       문장과 임차인 목록이 들어 있다 - 같은 요청에서 꺼내 쓴다(요청 수는 그대로). */
    try{const sr=await statusReport(row);if(sr?.data){row.coverage={...(row.coverage||{}),status_report:1};row.statusReportAvailable=true;docsAdded++;
     const sd=sr.data||{};
     const mng=sd.dma_curstExmnMngInf||{};
     const rlet=Array.isArray(sd.dlt_ordTsRlet)?sd.dlt_ordTsRlet:[];
     const occ={investigatedAt:txt(mng.exmnDtDts||''),sentAt:normDate(mng.exmndcSndngYmd),receivedAt:normDate(mng.exmndcRcptnYmd),
                note:[mng.lstPossRltnDts,mng.fstmLstPossRltnDts,mng.scntmLstPossRltnDts].map(x=>txt(x||'')).filter(Boolean).join(' '),
                items:rlet.map(x=>({address:txt(x.rprsLtnoAddr||x.printSt||''),buildingName:txt(x.bldNm||''),
                                    possessionCode:txt(x.auctnPossRltnCd||''),possession:txt((x.gdsPossCtt||'').replace(/<br\s*\/?>/gi,' ')),
                                    lesseeCount:Number(x.lesCnt)||0}))};
     if(occ.note||occ.items.length){row.occupancy=occ}
     const les=Array.isArray(sd.dlt_ordTsLserLtn)?sd.dlt_ordTsLserLtn:[];
     /* 임차인이 0건인 것과 조사를 못 한 것은 다르다 - 조사가 됐으면 0건도 사실로 남긴다. */
     /* 키 이름은 2026-09-14 실측으로 확정했다(2026타경10032, 임차인 1건):
          intrpsNm 이름 · mvinDtlCtt 전입일 · rgstryCrtcpCfmtnCtt 확정일자 ·
          lesDposDts 보증금(문자열, 콤마 포함) · mmrntAmtDts 월세 ·
          gdsPossCtt 점유기간 · lesPartCtt 점유부분 · lesDtsRmk 비고
        ★enrrno 는 **암호화된 주민등록번호**다. 저장하지 않는다 - 원문을 통째로 담으면
          그것이 따라 들어온다(그래서 raw 를 담던 코드를 걷어냈다).
        ★이름은 가운데를 가려 저장한다. 권리분석에 필요한 것은 동일인 여부이지 실명이 아니다.
        ★배당요구 여부는 이 목록에서 확인되지 않았다 - 없는 칸을 만들지 않는다(미확인). */
     const mask=v=>{const t=txt(v||'');return t.length<=1?t:(t.length===2?t[0]+'*':t[0]+'*'.repeat(t.length-2)+t[t.length-1])};
     const amt=v=>asInt(String(v==null?'':v).replace(/[^0-9]/g,''));
     row.lessees=les.map(x=>({name:mask(x.intrpsNm),
                              moveInDate:normDate(String(x.mvinDtlCtt||'').replace(/[.\s]+$/,'').replace(/\./g,'-')),
                              fixedDate:normDate(String(x.rgstryCrtcpCfmtnCtt||'').replace(/\./g,'-')),
                              deposit:amt(x.lesDposDts),
                              rent:amt(x.mmrntAmtDts),
                              period:txt(x.gdsPossCtt||''),
                              part:txt(x.lesPartCtt||''),
                              note:txt(x.lesDtsRmk||'')}));
     row.lesseeCount=row.lessees.length;
    }}catch(e){if(/BLOCKED/.test(String(e.message||e)))throw e}
   }
   row.documents=[...(row.saleStatementAvailable?[{type:'매각물건명세서',source:'대한민국 법원경매정보',available:true}]:[]),...(row.statusReportAvailable?[{type:'현황조사서',source:'대한민국 법원경매정보',available:true}]:[])];row.documentCount=row.documents.length;row.detailCheckedAt=new Date().toISOString();done++;
   addRecent({at:new Date().toISOString(),ok:true,caseNumber:row.caseNumber,courtName:row.courtName||row.courtCode||'',address:row.address||'',documents:row.documentCount||0});
   setWorkerStatus({batchSuccess:done,batchFailed:(idx+1)-done,lastProcessedCase:row.caseNumber,lastProcessedOk:true});
  }catch(e){lastError=`${row.caseNumber}: ${e.message||e}`;console.error(lastError);cookie='';row.detailCheckedAt=new Date().toISOString();addRecent({at:new Date().toISOString(),ok:false,caseNumber:row.caseNumber,courtName:row.courtName||row.courtCode||'',address:row.address||'',error:String(e.message||e)});setWorkerStatus({batchSuccess:done,batchFailed:(idx+1)-done,lastProcessedCase:row.caseNumber,lastProcessedOk:false,lastItemError:String(e.message||e)})}
 }
 write(DATA,rows);stats.generatedAt=new Date().toISOString();stats.winningCount=rows.filter(x=>x.winningPrice).length;stats.eventCount=rows.reduce((n,x)=>n+Number(x.eventCount||0),0);stats.documentCount=rows.reduce((n,x)=>n+Number(x.documentCount||0),0);stats.coverage={...(stats.coverage||{})};for(const k of ['schedule','winning_price','status_report','sale_statement','appraisal_summary'])stats.coverage[k]=rows.filter(x=>Number(x.coverage?.[k]||0)===1).length;stats.latestDetailRun={checked:ranked.length,success:done,eventsAdded,docsAdded,source:'대한민국 법원경매정보',order:'latest-first',shard:`${SHARD_INDEX+1}/${SHARD_COUNT}`,error:lastError,finishedAt:new Date().toISOString()};write(STATS,stats);setWorkerStatus({currentIndex:ranked.length,totalInBatch:ranked.length,batchSuccess:done,batchFailed:ranked.length-done,currentCaseNumber:null,currentCourtName:null,currentAddress:null});console.log(JSON.stringify(stats.latestDetailRun,null,2));
}
// Only run when invoked directly. `require('./detail-enrich')` used to start a
// full collection run as a side effect, which is how three court requests went
// out during a stop order.
if(require.main===module){main().catch(e=>{console.error(e);setWorkerStatus({phase:'error',error:String(e?.message||e)});process.exitCode=1})}
module.exports={priority,expiringUncaptured,expiringNext,missingCount,bidderCountFrom,kstDay};
