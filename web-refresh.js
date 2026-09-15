// 화면이 읽는 것(Cloudflare KV)을 창고의 canonical 로 맞춘다.
//
// 왜 노트북에서 도는가 (2026-09-15): KV 갱신이 Cloud Run 마스터 안에만 있었고, 그
// 마스터는 "이번 회차에 병합할 델타가 있었는가"에 갱신을 매달아 두었다. 델타 병합을
// GitHub Actions 가 먼저 가져가면서 마스터는 매번 "nothing staged" 로 끝났고,
// **12시간 동안 화면 데이터가 멈췄다**(라이브 12,111 vs 창고 12,231).
// 마스터 쪽 결합은 풀었지만 그것은 이미지를 다시 굽기 전까지 적용되지 않는다.
// 그래서 이미지와 무관하게 도는 자리를 하나 둔다 - 신선도가 한 군데에만 매달려
// 있는 것 자체가 이번 사고의 형태였다.
//
// ★법원에 접속하지 않는다. 관문과 무관하고, 수집기가 차단돼 있어도 돈다.
// ★작업본 canonical 을 쓰지 않는다. 수집기가 쥐고 쓰는 중이라 중간 상태일 수 있다.
//   창고(origin/main) 판을 꺼내 스크래치에 놓고 그것으로 내보낸다.
// ★자격 값은 어디에도 찍지 않는다. 있다/없다와 결과만 낸다.
//
//   CF_API_TOKEN=… CF_ACCOUNT_ID=… CF_KV_NAMESPACE_ID=… node web-refresh.js
//   MIN_LAG_MIN=30 node web-refresh.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = __dirname;
const STATUS = path.join(ROOT, 'data', 'web-refresh-status.json');
const SITE = (process.env.SITE || 'https://auction-view.pages.dev').replace(/\/+$/, '');
const REF = process.env.WATCH_REF || 'origin/main';
const MIN_LAG_MIN = Number(process.env.MIN_LAG_MIN || 30);

const git = (...a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 1 << 28 });
const writeStatus = (v) => {
  fs.mkdirSync(path.dirname(STATUS), { recursive: true });
  fs.writeFileSync(STATUS, JSON.stringify(v, null, 2));
  console.log(JSON.stringify(v, null, 2));
};

/** 창고 판을 스크래치에 꺼내 둔다. 없는 파일은 조용히 건너뛴다(선택 입력이다). */
function materialize(dir, rel) {
  try {
    const buf = git('show', `${REF}:${rel}`);
    const to = path.join(dir, path.basename(rel));
    fs.writeFileSync(to, buf);
    return to;
  } catch { return null; }
}

(async () => {
  const at = new Date().toISOString();

  /* ① 지금 얼마나 뒤처져 있나. 앞서 있으면 아무것도 하지 않는다 - 쓰기 횟수를 아낀다. */
  let repoAt = null, repoCount = null;
  try {
    const st = JSON.parse(git('show', `${REF}:data/stats.json`).toString('utf8'));
    repoAt = st.generatedAt; repoCount = st.itemCount;
  } catch (e) {
    writeStatus({ at, phase: 'failed', why: '창고 stats.json 을 읽지 못했다: ' + (e.message || e) });
    process.exitCode = 1; return;
  }

  let liveAt = null, liveCount = null;
  try {
    const r = await fetch(SITE + '/api/auction/stats', { headers: { 'cache-control': 'no-cache' } });
    if (r.ok) { const j = await r.json(); liveAt = j.generatedAt; liveCount = j.itemCount; }
  } catch { /* 라이브를 못 읽으면 뒤처진 것으로 본다 - 올리고 보는 편이 안전하다. */ }

  const lagMin = (repoAt && liveAt) ? Math.round((Date.parse(repoAt) - Date.parse(liveAt)) / 60000) : null;
  if (lagMin !== null && lagMin < MIN_LAG_MIN) {
    writeStatus({ at, phase: 'idle', why: `KV 가 최신이다(뒤처짐 ${lagMin}분 < ${MIN_LAG_MIN}분)`, repoAt, liveAt, repoCount, liveCount });
    return;
  }

  /* ② 자격이 없으면 여기서 끝낸다. 없는 것을 있는 척 넘기지 않는다. */
  const token = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  /* 네임스페이스 id 는 비밀이 아니다 - wrangler.toml 에 이미 적혀 있다. 대표님이
     붙여 넣어야 할 값을 둘로 줄이려고 거기서 읽어 쓴다. */
  const ns = process.env.CF_KV_NAMESPACE_ID || process.env.CLOUDFLARE_KV_NAMESPACE_ID || (() => {
    try {
      const toml = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
      const m = toml.match(/binding\s*=\s*"AUCTION_KV"[\s\S]{0,200}?id\s*=\s*"([0-9a-f]{32})"/)
        || toml.match(/id\s*=\s*"([0-9a-f]{32})"/);
      return m ? m[1] : null;
    } catch { return null; }
  })();
  if (!token || !account || !ns) {
    writeStatus({
      at, phase: 'blocked',
      why: 'Cloudflare 자격이 없다 - CF_API_TOKEN · CF_ACCOUNT_ID · CF_KV_NAMESPACE_ID 중 없는 것이 있다',
      missing: [!token && 'CF_API_TOKEN', !account && 'CF_ACCOUNT_ID', !ns && 'CF_KV_NAMESPACE_ID'].filter(Boolean),
      repoAt, liveAt, repoCount, liveCount, lagMin,
    });
    process.exitCode = 8; return;
  }

  /* ③ 창고 판으로 내보내고 올린다. */
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'web-refresh-'));
  const out = path.join(scratch, 'export');
  try {
    const auctions = materialize(scratch, 'data/auctions.json');
    const stats = materialize(scratch, 'data/stats.json');
    materialize(scratch, 'data/collection-alert.json');
    materialize(scratch, 'data/laptop-status.json');
    if (!auctions || !stats) throw new Error('창고에서 canonical/stats 를 꺼내지 못했다');

    const env = {
      ...process.env,
      AUCTIONS_FILE: auctions,
      STATS_FILE: stats,
      EXPORT_OUT: out,
      CLOUDFLARE_API_TOKEN: token,
      CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_KV_NAMESPACE_ID: ns,
    };
    const step = (script) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, stdio: 'inherit', env });
      if (r.status !== 0) throw new Error(`${script} 가 ${r.status} 로 끝났다`);
    };
    step('export-for-web.js');
    step('upload-web-export.js');

    /* 실제로 붙었는지 확인한다 - 올렸다는 말과 붙었다는 사실은 다르다.
       KV 는 전파에 수십 초가 걸리므로 곧바로 아니어도 실패로 적지 않는다. */
    let after = null;
    try {
      const r = await fetch(SITE + '/api/auction/stats', { headers: { 'cache-control': 'no-cache' } });
      if (r.ok) { const j = await r.json(); after = { generatedAt: j.generatedAt, itemCount: j.itemCount }; }
    } catch {}

    writeStatus({ at, phase: 'uploaded', repoAt, repoCount, before: { generatedAt: liveAt, itemCount: liveCount }, after, lagMin });
  } catch (e) {
    writeStatus({ at, phase: 'failed', why: String(e.message || e).slice(0, 300), repoAt, liveAt, repoCount, liveCount, lagMin });
    process.exitCode = 9;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exitCode = 1;
});
