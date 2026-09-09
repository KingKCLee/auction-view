// GET /api/auction/:id   — one case, read only when a case page is opened.
// id is the canonical row id, "<courtCode>|<caseNumber>|<itemNumber>", so it must
// arrive percent-encoded.

import { json, notFound, RESPONSE_CAP } from '../_lib.js';

export async function onRequestGet({ params, env }) {
  const id = decodeURIComponent(params.id || '');
  if (!id) return notFound('no case id given');
  if (!env.AUCTION_KV) return json({ error: 'AUCTION_KV binding is missing' }, 503);

  const detail = await env.AUCTION_KV.get(`detail:v1:${id}`, 'json');
  if (!detail) return notFound(`no case ${id}`);

  const encoded = JSON.stringify(detail);
  if (encoded.length > RESPONSE_CAP) {
    return json({ error: 'response too large', bytes: encoded.length, cap: RESPONSE_CAP }, 500);
  }
  return json(detail, 200, { 'cache-control': 'public, max-age=300' });
}
