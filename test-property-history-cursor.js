"use strict";
const assert=require('assert');
const {furthest}=require('./property-history-cursor-lib');
assert.deepStrictEqual(furthest({year:2017,month:6,page:1},{year:2017,month:5,page:1}).year,2017);
assert.strictEqual(furthest({year:2017,month:6,page:1},{year:2017,month:5,page:1}).month,5);
assert.strictEqual(furthest({year:2017,month:6,page:1},{year:2017,month:6,page:3}).page,3);
assert.strictEqual(furthest({year:2016,month:12,page:1},{year:2017,month:1,page:99}).year,2016);
console.log('property history cursor monotonic guard: PASS');
