const assert = require('assert');
const { buildPatch, applyPatch } = require('./dual-collector-lib');

const before = {
  id: 'B0001|2026타경1|1',
  address: '기존주소',
  minimumPrice: 100,
  winningPrice: null,
  coverage: { base_info: 1, schedule: 0, winning_price: 0 }
};

const after = {
  ...before,
  winningPrice: 123,
  winningDate: '2026-09-08',
  events: [{ event_date: '2026-09-08', result_text: '매각' }],
  coverage: { ...before.coverage, schedule: 1, winning_price: 1 }
};

const patch = buildPatch(before, after);
assert(patch, 'detail change must create a patch');
assert.strictEqual(patch.set.address, undefined, 'unchanged base fields must not be patched');
assert.strictEqual(patch.set.winningPrice, 123, 'winning price must be included');

const canonical = {
  ...before,
  minimumPrice: 90,
  coverage: { base_info: 1, schedule: 0, winning_price: 0, photos: 1 }
};
applyPatch(canonical, patch);

assert.strictEqual(canonical.minimumPrice, 90, 'unrelated canonical fields must survive');
assert.strictEqual(canonical.winningPrice, 123, 'winning price must merge');
assert.strictEqual(canonical.coverage.base_info, 1, 'base coverage must survive');
assert.strictEqual(canonical.coverage.photos, 1, 'unrelated coverage must survive');
assert.strictEqual(canonical.coverage.winning_price, 1, 'detail coverage must merge');

console.log('dual collector merge test: PASS');
