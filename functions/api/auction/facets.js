// GET /api/auction/facets — the filter options (시/도, 시군구, 용도, 법원) on their own,
// so a screen can build its dropdowns without pulling a list page first.

import { json, loadIndex } from '../_lib.js';

export async function onRequestGet({ env }) {
  if (!env.AUCTION_KV) return json({ error: 'AUCTION_KV binding is missing' }, 503);
  const facets = await env.AUCTION_KV.get('facets:v1', 'json');
  if (!facets) return json({ error: 'no facets in KV; run the exporter and upload' }, 503);

  /*
   * 법원 목록은 내보내기가 facets 에 넣어 주기 시작했지만(2026-09-14), 이미 올라가 있는
   * KV 블롭에는 없다. 다음 내보내기를 기다리는 동안 화면의 법원 선택칸이 비는 것을
   * 막으려고 여기서 카드 인덱스로부터 뽑아 준다 - courtName 은 카드에 이미 실려 있다.
   * 내보내기가 넣어 준 값이 있으면 그것을 쓴다(여기서 다시 세지 않는다).
   */
  if (!Array.isArray(facets.court) || !facets.court.length) {
    try {
      const index = await loadIndex(env, null);
      const i = index.fields.indexOf('courtName');
      if (i >= 0) {
        facets.court = [...new Set(index.rows.map((r) => r[i]).filter(Boolean))].sort();
      }
    } catch {
      /* 인덱스를 못 읽어도 나머지 선택지는 그대로 준다 - 법원칸만 비운다. */
    }
  }

  return json(facets, 200, { 'cache-control': 'public, max-age=600' });
}
