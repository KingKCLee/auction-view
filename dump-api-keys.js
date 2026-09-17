/**
 * dump-api-keys.js — 법원 응답의 **전체 키**를 있는 그대로 나열한다.
 * ==========================================================================
 * 왜: "그 필드는 없다"를 짐작으로 말하지 않기 위해서다(R4d). 최근 면적·당사자·
 * 목록내역이 전부 "없다"고 보고됐다가 실제로는 응답 안에 있었다.
 * 그래서 읽는 코드가 무엇을 꺼내든 상관없이 **응답에 오는 키 전부**를 찍는다.
 *
 * 안전: court-gate 경유(기계 단위 배타 잠금 + 공용 페이싱). 차단 감지 시 즉시 중단.
 * 계약: node dump-api-keys.js   (표본은 .probe-cases.json)
 */
const fs = require('fs');
const gate = require('./court-gate');
const BASE = 'https://www.courtauction.go.kr';
let cookie = '';

async function timedFetch(u, i, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(u, { ...i, signal: c.signal }); } finally { clearTimeout(t); }
}
async function warmup() {
  return gate.acquire('dump-api-keys:warmup', async () => {
    const r = await timedFetch(BASE + '/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml&pgjId=151F00',
      { headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html,application/xhtml+xml,*/*', 'accept-language': 'ko-KR,ko;q=0.9' } }, 18000);
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
    if (sc.length) cookie = sc.map((x) => x.split(';')[0]).join('; ');
    if (!r.ok) throw new Error('warmup HTTP ' + r.status);
  });
}
async function post(url, body, pgmid = 'PGJ151F01') {
  if (!cookie) await warmup();
  return gate.acquire('dump-api-keys:' + url, async () => {
    const r = await timedFetch(BASE + url, { method: 'POST', headers: {
      'content-type': 'application/json;charset=UTF-8', accept: 'application/json,text/plain,*/*',
      'user-agent': 'Mozilla/5.0', 'accept-language': 'ko-KR,ko;q=0.9',
      referer: BASE + '/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml', cookie,
      'sc-userid': 'SYSTEM', 'sc-pgmid': pgmid } , body: JSON.stringify(body) }, 18000);
    const raw = await r.text(); gate.inspect(raw, url);
    let j; try { j = JSON.parse(raw); } catch { throw new Error('non-json ' + r.status); }
    if (j?.data?.ipcheck === false) throw new Error('BLOCKED by court site');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return j;
  });
}

/** 키 경로를 전부 모은다. 배열은 [0] 하나만 따라간다(같은 모양이 반복되므로). */
function walk(node, path, sink, depth = 0) {
  if (depth > 6 || node === null || node === undefined) return;
  if (Array.isArray(node)) { sink.set(path + '[]', `array(${node.length})`); if (node.length) walk(node[0], path + '[]', sink, depth + 1); return; }
  if (typeof node !== 'object') { sink.set(path, JSON.stringify(node).slice(0, 48)); return; }
  for (const k of Object.keys(node)) walk(node[k], path ? path + '.' + k : k, sink, depth + 1);
}

(async () => {
  const cases = JSON.parse(fs.readFileSync('.probe-cases.json', 'utf8'));
  const all = {};
  for (const c of cases) {
    const eps = [
      ['pgj15B/selectAuctnCsSrchRslt (물건 상세)', '/pgj/pgj15B/selectAuctnCsSrchRslt.on',
        { dma_srchGdsDtlSrch: { csNo: String(c.caseNumber), cortOfcCd: String(c.courtCode), dspslGdsSeq: Number(c.itemNumber) || 1, pgmId: 'PGJ15BF01' } }],
      ['pgj15A/selectAuctnCsSrchRslt (사건 기본)', '/pgj/pgj15A/selectAuctnCsSrchRslt.on',
        { dma_srchCsDtlInf: { cortOfcCd: String(c.courtCode), csNo: String(c.caseNumber), pgmId: 'PGJ15AF01' } }],
      ['pgj15B/selectCurstExmndc (현황조사서)', '/pgj/pgj15B/selectCurstExmndc.on',
        { dma_srchCurstExmn: { cortOfcCd: String(c.courtCode), csNo: String(c.caseNumber), auctnInspoSeq: 1, pgmId: 'PGJ15BF01' } }],
    ];
    for (const [label, url, body] of eps) {
      let j = null, err = null;
      try { j = await post(url, body); } catch (e) { err = e.message; }
      const sink = new Map();
      if (j) walk(j, '', sink);
      const key = label;
      all[key] = all[key] || new Map();
      for (const [k, v] of sink) if (!all[key].has(k)) all[key].set(k, v);
      console.log(`[${c.why}] ${c.caseNumber} ${label} — ${err ? 'ERR ' + err : sink.size + ' 키'}`);
    }
  }
  const out = {};
  for (const [ep, m] of Object.entries(all)) out[ep] = [...m].map(([k, v]) => k + ' = ' + v);
  fs.writeFileSync('.api-keys-dump.json', JSON.stringify(out, null, 1));
  console.log('\n저장: .api-keys-dump.json');
  for (const [ep, arr] of Object.entries(out)) console.log('  ' + ep + ' — 고유 키 경로 ' + arr.length);
})().catch((e) => { console.error('중단:', e.message); process.exit(1); });
