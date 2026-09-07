const lib=require('court-auction-notice-search');

// Prefer the court's JSON endpoints directly. The WebSquare warm-up page is
// intermittently unreachable from some GitHub-hosted runner regions even when
// the JSON endpoints themselves are reachable.
if(lib.CourtAuctionHttpClient&&lib.CourtAuctionHttpClient.prototype){
  lib.CourtAuctionHttpClient.prototype.warmup=async function(){this.warmedUp='direct-json';};
}

// A browser cannot help when the runner has no network path to the court host;
// fail fast and let the next scheduled runner try instead of waiting 45s per court.
try{lib.CourtAuctionPlaywrightClient=undefined;}catch{}

// Keep a court-code fallback so a transient failure of the court-code endpoint
// does not collapse a nationwide sweep to only the courts already in the DB.
const STATIC_COURTS=[
['B000210','서울중앙지방법원'],['B000211','서울동부지방법원'],['B000215','서울서부지방법원'],['B000212','서울남부지방법원'],['B000213','서울북부지방법원'],
['B000214','의정부지방법원'],['B214807','고양지원'],['B214804','남양주지원'],['B000240','인천지방법원'],['B000241','부천지원'],
['B000250','수원지방법원'],['B000251','성남지원'],['B000252','여주지원'],['B000253','평택지원'],['B250826','안산지원'],['B000254','안양지원'],
['B000260','춘천지방법원'],['B000261','강릉지원'],['B000262','원주지원'],['B000263','속초지원'],['B000264','영월지원'],
['B000270','청주지방법원'],['B000271','충주지원'],['B000272','제천지원'],['B000273','영동지원'],
['B000280','대전지방법원'],['B000281','홍성지원'],['B000282','논산지원'],['B000283','천안지원'],['B000284','공주지원'],['B000285','서산지원'],
['B000310','대구지방법원'],['B000311','안동지원'],['B000312','경주지원'],['B000313','김천지원'],['B000314','상주지원'],['B000315','의성지원'],['B000316','영덕지원'],['B000317','포항지원'],['B000320','대구서부지원'],
['B000410','부산지방법원'],['B000412','부산동부지원'],['B000414','부산서부지원'],['B000411','울산지방법원'],
['B000420','창원지방법원'],['B000431','마산지원'],['B000421','진주지원'],['B000422','통영지원'],['B000423','밀양지원'],['B000424','거창지원'],
['B000510','광주지방법원'],['B000511','목포지원'],['B000512','장흥지원'],['B000513','순천지원'],['B000514','해남지원'],
['B000520','전주지방법원'],['B000521','군산지원'],['B000522','정읍지원'],['B000523','남원지원'],['B000530','제주지방법원']
];
const originalGetCourtCodes=lib.getCourtCodes;
if(typeof originalGetCourtCodes==='function'){
  lib.getCourtCodes=async function(...args){
    try{
      const result=await originalGetCourtCodes(...args);
      if(Array.isArray(result?.items)&&result.items.length>=40)return result;
    }catch{}
    return {items:STATIC_COURTS.map(([code,name])=>({code,name})),source:'static-fallback'};
  };
}

// Cap individual network waits. A bad runner should finish quickly so the next
// five-minute run can land on a different hosted region.
const nativeFetch=global.fetch;
if(typeof nativeFetch==='function'){
  global.fetch=function(url,opts={}){
    const c=new AbortController();
    const timer=setTimeout(()=>c.abort(),12000);
    let signal=c.signal;
    if(opts.signal&&typeof AbortSignal!=='undefined'&&typeof AbortSignal.any==='function'){
      signal=AbortSignal.any([opts.signal,c.signal]);
    }
    return nativeFetch(url,{...opts,signal}).finally(()=>clearTimeout(timer));
  };
}
