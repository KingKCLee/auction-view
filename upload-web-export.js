// Pushes data/export into the Cloudflare KV namespace the API reads.
//
// Uses the REST API directly rather than wrangler, so the cloud job needs only a
// token in the environment and no extra tooling. Values are sent in bulk batches;
// the gzipped list blob goes up base64-encoded.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... CLOUDFLARE_KV_NAMESPACE_ID=... \
//     node upload-web-export.js
//
// Every value is re-checked against the size cap on the way out: the exporter
// already refuses to write an oversized object, and this refuses to publish one.

const fs = require('fs');
const path = require('path');

const OUT = process.env.EXPORT_OUT || path.join(__dirname, 'data', 'export');
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || '';
const NAMESPACE = process.env.CLOUDFLARE_KV_NAMESPACE_ID || process.env.CF_KV_NAMESPACE_ID || '';
const MAX_OBJECT_BYTES = Number(process.env.MAX_OBJECT_BYTES || 512000);
const BATCH = Number(process.env.KV_BATCH || 5000);
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');

const redact = s => String(s ?? '').split(TOKEN).join('***');

function collect() {
  const entries = [];
  const push = (key, buf, base64 = false) => {
    if (buf.length > MAX_OBJECT_BYTES) {
      const e = new Error(`${key} is ${buf.length} bytes, over the ${MAX_OBJECT_BYTES} byte cap`);
      e.code = 'PAYLOAD_TOO_LARGE';
      throw e;
    }
    entries.push({ key, value: base64 ? buf.toString('base64') : buf.toString('utf8'), base64 });
  };

  push('index:v1', fs.readFileSync(path.join(OUT, 'index.json.gz')), true);
  push('stats:v1', fs.readFileSync(path.join(OUT, 'stats.json')));

  const index = JSON.parse(require('zlib').gunzipSync(fs.readFileSync(path.join(OUT, 'index.json.gz'))).toString('utf8'));
  push('facets:v1', Buffer.from(JSON.stringify(index.facets), 'utf8'));

  const regionDir = path.join(OUT, 'region');
  if (fs.existsSync(regionDir)) {
    for (const f of fs.readdirSync(regionDir)) {
      const sido = decodeURIComponent(f.replace(/\.json\.gz$/, ''));
      push(`region:v1:${sido}`, fs.readFileSync(path.join(regionDir, f)), true);
    }
  }

  // Detail filenames are hashes, so the KV key comes from the id inside the file.
  const detailDir = path.join(OUT, 'detail');
  for (const f of fs.readdirSync(detailDir)) {
    const buf = fs.readFileSync(path.join(detailDir, f));
    const id = JSON.parse(buf.toString('utf8')).id;
    if (!id) throw new Error(`detail/${f} has no id`);
    push(`detail:v1:${id}`, buf);
  }
  return entries;
}

async function putBatch(batch) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NAMESPACE}/bulk`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(batch.map(e => ({ key: e.key, value: e.value, base64: e.base64 || undefined })))
  });
  const text = await res.text();
  if (!res.ok) throw new Error(redact(`KV bulk put failed ${res.status}: ${text.slice(0, 400)}`));
  return JSON.parse(text);
}

async function main() {
  if (!fs.existsSync(path.join(OUT, 'index.json.gz'))) {
    throw new Error(`no export at ${OUT}; run export-for-web.js first`);
  }
  const entries = collect();
  const bytes = entries.reduce((n, e) => n + Buffer.byteLength(e.value), 0);
  console.log(`[upload] ${entries.length} keys, ${(bytes / 1024 / 1024).toFixed(1)}MB, cap ${MAX_OBJECT_BYTES}B per value`);

  if (DRY_RUN) {
    console.log('[upload] DRY_RUN=1; nothing sent');
    console.log(JSON.stringify({ keys: entries.length, sampleKeys: entries.slice(0, 5).map(e => e.key) }, null, 2));
    return;
  }
  if (!ACCOUNT || !TOKEN || !NAMESPACE) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and CLOUDFLARE_KV_NAMESPACE_ID are all required');
  }

  let done = 0;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    await putBatch(batch);
    done += batch.length;
    console.log(`[upload] ${done}/${entries.length}`);
  }
  console.log(JSON.stringify({ uploaded: done, at: new Date().toISOString() }, null, 2));
}

module.exports = { collect };

if (require.main === module) {
  main().catch(e => {
    console.error(`[upload] FAILED: ${redact(e.message || e)}`);
    process.exitCode = e.code === 'PAYLOAD_TOO_LARGE' ? 7 : 1;
  });
}
