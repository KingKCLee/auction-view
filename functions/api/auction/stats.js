// GET /api/auction/stats — the progress numbers, for the admin screen and for
// anyone who wants to know how complete the database is.

import { json, RESPONSE_CAP } from '../_lib.js';

export async function onRequestGet({ env }) {
  if (!env.AUCTION_KV) return json({ error: 'AUCTION_KV binding is missing' }, 503);
  const stats = await env.AUCTION_KV.get('stats:v1', 'json');
  if (!stats) return json({ error: 'no stats in KV; run the exporter and upload' }, 503);

  const encoded = JSON.stringify(stats);
  if (encoded.length > RESPONSE_CAP) {
    return json({ error: 'response too large', bytes: encoded.length, cap: RESPONSE_CAP }, 500);
  }
  return json(stats, 200, { 'cache-control': 'public, max-age=60' });
}
