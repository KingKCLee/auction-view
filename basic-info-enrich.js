const fs=require('fs');
const path=require('path');
const lib=require('court-auction-notice-search');

const DATA=path.join(__dirname,'data','auctions.json');
const STATS=path.join(__dirname,'data','stats.json');
const MAX_CASES=Math.max(1,Number(process.env.BASIC_INFO_CASES||4));
const read=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return f}};
const write=(p,v)=>fs.writeFileSync(p,JSON.stringify(v,null,2));
const txt=v=>v==null?'':String(v).trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const usable=row=>Boolean(txt(row.address)&&txt(row.courtCode)&&txt(row.caseNumber)&&(txt(row.usage)||Number(row.appraisedPrice)>0||Number(row.minimumPrice)>0||txt(row.saleDate)));
const itemKey=v=>txt(v).replace(/^0+/,'')||'0';

function makeClient(direct=false){
  const c=new lib.CourtAuctionHttpClient({timeoutMs:30000,minDelayMs:2600,jitterMs:900,maxCallsPerSession:8});
  if(direct)c.warmup=async()=>{};
  return c;
}

async function fetchCase(courtCode,caseNumber,normal,direct){
  const attempts=[];
  try{
    const r=await lib.getCaseByCaseNumber({courtCode,caseNumber,client:normal,includeRaw:true});
    if(r?.found)return{r,transport:'http',attempts};
    attempts.push('http:not-found');
  }catch(e){attempts.push(`http:${e.code||''}:${e.message||e}`)}
  try{
    const r=await lib.getCaseByCaseNumber({courtCode,caseNumber,client:direct,includeRaw:true});
    if(r?.found)return{r,transport:'direct-http',attempts};
    attempts.push('direct:not-found');
    return{r,transport:'direct-http',attempts};
  }catch(e){attempts.push(`direct:${e.code||''}:${e.message||e}`);return{r:null,transport:'failed',attempts,error:e}}
}

function applyCase(group,result){
  const ci=result?.caseInfo||{};
  const items=Array.isArray(result?.items)?result.items:[];
  const schedule=Array.isArray(result?.schedule)?result.schedule:[];
  let improved=0;
  for(const row of group){
    const before=usable(row);
    const ik=itemKey(row.itemNumber);
    const obj=items.find(x=>itemKey(x.itemSeq)===ik)||(items.length===1?items[0]:null);
    if(!txt(row.address)&&txt(obj?.address))row.address=txt(obj.address);
    if(!txt(row.courtName)&&txt(ci.courtName||ci.courtBranchName))row.courtName=txt(ci.courtName||ci.courtBranchName);
    if(!txt(row.caseType)&&txt(ci.caseName))row.caseType=txt(ci.caseName);
    if(!row.claimAmount&&Number(ci.claimAmount)>0)row.claimAmount=Number(ci.claimAmount);
    const ev=schedule.filter(x=>itemKey(x.itemSeq)===ik);
    const chosen=(ev.length?ev:schedule).filter(Boolean).sort((a,b)=>txt(a.saleDate).localeCompare(txt(b.saleDate))).at(-1);
    if(!row.appraisedPrice&&Number(chosen?.appraisedPrice)>0)row.appraisedPrice=Number(chosen.appraisedPrice);
    if(!row.minimumPrice&&Number(chosen?.minimumSalePrice)>0)row.minimumPrice=Number(chosen.minimumSalePrice);
    if(!txt(row.saleDate)&&txt(chosen?.saleDate))row.saleDate=txt(chosen.saleDate);
    row.coverage={...(row.coverage||{}),base_info:usable(row)?1:0};
    row.basicInfoCheckedAt=new Date().toISOString();
    if(!before&&usable(row))improved++;
  }
  return improved;
}

async function main(){
  const rows=read(DATA,[]),stats=read(STATS,{});
  if(!rows.length)return;
  for(const row of rows)row.coverage={...(row.coverage||{}),base_info:usable(row)?1:0};

  const groups=new Map();
  for(const row of rows){
    if(usable(row)||!txt(row.courtCode)||!txt(row.caseNumber))continue;
    const key=`${row.courtCode}|${row.caseNumber}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(row);
  }
  const ranked=[...groups.entries()].sort((a,b)=>{
    const ta=Math.min(...a[1].map(x=>Date.parse(x.basicInfoCheckedAt||0)||0));
    const tb=Math.min(...b[1].map(x=>Date.parse(x.basicInfoCheckedAt||0)||0));
    if(ta!==tb)return ta-tb;
    const da=Math.min(...a[1].map(x=>Math.abs((Date.parse(x.saleDate||'')||0)-Date.now())));
    const db=Math.min(...b[1].map(x=>Math.abs((Date.parse(x.saleDate||'')||0)-Date.now())));
    return da-db;
  }).slice(0,MAX_CASES);

  const normal=makeClient(false),direct=makeClient(true);
  let checked=0,success=0,itemsImproved=0,lastError=null;const transports=[],attempts=[];
  for(const [key,group] of ranked){
    const [courtCode,...rest]=key.split('|'),caseNumber=rest.join('|');
    checked++;
    const got=await fetchCase(courtCode,caseNumber,normal,direct);
    transports.push(`${courtCode}:${got.transport}`);attempts.push(...got.attempts);
    if(got.r?.found){success++;itemsImproved+=applyCase(group,got.r)}else{
      const now=new Date().toISOString();for(const row of group)row.basicInfoCheckedAt=now;
      lastError=`${courtCode} ${caseNumber}: ${got.error?.message||'case detail unavailable'}`;
    }
    await sleep(1000+Math.floor(Math.random()*800));
  }
  for(const c of [normal,direct])if(typeof c.close==='function')try{await c.close()}catch{}

  const ready=rows.filter(usable).length,addressCount=rows.filter(x=>txt(x.address)).length,priceCount=rows.filter(x=>Number(x.appraisedPrice)>0||Number(x.minimumPrice)>0).length;
  for(const row of rows)row.coverage={...(row.coverage||{}),base_info:usable(row)?1:0};
  write(DATA,rows);
  stats.generatedAt=new Date().toISOString();stats.itemCount=rows.length;stats.coverage={...(stats.coverage||{}),base_info:ready};
  stats.basicInfoQuality={ready,addressCount,priceCount,missing:rows.length-ready,definition:'주소 + (용도/감정가/최저가/매각기일 중 1개 이상)',updatedAt:new Date().toISOString()};
  stats.latestBasicInfoRun={checkedCases:checked,successfulCases:success,itemsImproved,remaining:rows.length-ready,transport:transports,attempts,lastError,source:'대한민국 법원경매정보 사건검색',finishedAt:new Date().toISOString()};
  write(STATS,stats);
  console.log(JSON.stringify(stats.latestBasicInfoRun,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
