"use strict";

function num(v,f){const n=Number(v);return Number.isInteger(n)&&n>0?n:f}
function normalize(v={},fallback={year:2026,month:1,page:1}){
  return {year:num(v.year,num(fallback.year,2026)),month:num(v.month,num(fallback.month,1)),page:num(v.page,num(fallback.page,1)),updatedAt:v.updatedAt||null};
}
function rank(c){return c.year*12+c.month}
function furthest(a,b){
  const A=normalize(a),B=normalize(b,A);
  const ra=rank(A),rb=rank(B);
  if(ra<rb)return A;
  if(rb<ra)return B;
  if(A.page>B.page)return A;
  if(B.page>A.page)return B;
  const ta=Date.parse(A.updatedAt||0)||0,tb=Date.parse(B.updatedAt||0)||0;
  return tb>ta?B:A;
}
module.exports={normalize,furthest};
