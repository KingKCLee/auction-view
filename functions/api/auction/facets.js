// GET /api/auction/facets — the filter options (시/도, 시군구, 용도) on their own,
// so a screen can build its dropdowns without pulling a list page first.

import { json } from '../_lib.js';

export async function onRequestGet({ env }) {
  if (!env.AUCTION_KV) return json({ error: 'AUCTION_KV binding is missing' }, 503);
  const facets = await env.AUCTION_KV.get('facets:v1', 'json');
  if (!facets) return json({ error: 'no facets in KV; run the exporter and upload' }, 503);
  return json(facets, 200, { 'cache-control': 'public, max-age=600' });
}
