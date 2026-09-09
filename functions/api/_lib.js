// Shared helpers for the auction API. One place decides how data is read and how
// big a response may be.

// Nothing the web reads may exceed this. The exporter enforces the same number on
// what it stores; this enforces it on what we hand back.
export const RESPONSE_CAP = Number(512000);

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...headers
    }
  });

export const badRequest = message => json({ error: message }, 400);
export const notFound = message => json({ error: message }, 404);

async function gunzip(buf) {
  const stream = new Response(buf).body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// The list blob is gzipped in KV. Prefer a region shard when the query is scoped
// to one, so a bigger dataset later still costs one read.
export async function loadIndex(env, sido) {
  if (!env.AUCTION_KV) throw new Error('AUCTION_KV binding is missing');
  const keys = sido ? [`region:v1:${sido}`, 'index:v1'] : ['index:v1'];
  for (const key of keys) {
    const buf = await env.AUCTION_KV.get(key, 'arrayBuffer');
    if (!buf) continue;
    const parsed = JSON.parse(await gunzip(buf));
    if (!parsed.facets && key.startsWith('region:')) {
      const root = await env.AUCTION_KV.get('facets:v1', 'json');
      if (root) parsed.facets = root;
    }
    return parsed;
  }
  throw new Error('no list index in KV; run the exporter and upload');
}

export const cardToObject = (fields, row) =>
  Object.fromEntries(fields.map((f, i) => [f, row[i]]));
