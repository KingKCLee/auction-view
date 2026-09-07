const fs=require('fs');
const path=require('path');
const DATA=path.join(__dirname,'data','auctions.json');
const STATS=path.join(__dirname,'data','stats.json');
const read=(p,f)=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return f}};
const txt=v=>v==null?'':String(v).trim();
const usable=row=>Boolean(txt(row.address)&&txt(row.courtCode)&&txt(row.caseNumber)&&(txt(row.usage)||Number(row.appraisedPrice)>0||Number(row.minimumPrice)>0||txt(row.saleDate)));
const rows=read(DATA,[]),stats=read(STATS,{});
const falseReady=rows.filter(r=>Number(r.coverage?.base_info||0)===1&&!usable(r));
const ready=rows.filter(usable).length;
const statReady=Number(stats.coverage?.base_info||0);
if(falseReady.length||statReady!==ready){
  console.error(JSON.stringify({ok:false,falseReady:falseReady.length,ready,statReady,sample:falseReady.slice(0,5).map(r=>({id:r.id,caseNumber:r.caseNumber,address:r.address,usage:r.usage,appraisedPrice:r.appraisedPrice,minimumPrice:r.minimumPrice,saleDate:r.saleDate}))},null,2));
  process.exit(1);
}
console.log(JSON.stringify({ok:true,ready,total:rows.length},null,2));
