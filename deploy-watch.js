// 창고에 올린 것이 **라이브에 실제로 나갔는가**를 감시한다.
//
// 왜 필요한가 (2026-09-15): auction-view 의 Cloudflare Pages Git 연결이 끊긴 채로
// 6일이 지났다. 그동안 커밋·푸시는 전부 성공했고 창고는 최신이었는데 라이브만 옛
// 코드였다. 푸시가 성공했다는 것과 배포가 됐다는 것은 다른 사실인데, 그 차이를
// 아무도 보고 있지 않아 새 필터를 단 화면이 "칸은 있는데 안 걸러지는" 상태로
// 나갈 뻔했다. 사람이 고치더라도 **발견은 자동이어야 한다.**
//
// 무엇을 재는가 — 원인을 묻지 않고 결과를 잰다:
//   ① public/ 의 각 파일이 창고 판과 라이브 판이 **바이트 단위로 같은가**
//   ② KV 에 올라간 데이터 기준 시각이 창고 canonical 보다 얼마나 뒤처졌나
// 이 둘은 연결 끊김·빌드 실패·자동배포 꺼짐·업로드 OOM 을 원인과 무관하게 잡는다.
//
// 토큰이 있으면(선택) Cloudflare API 로 "왜"까지 덧붙인다. 없어도 ①②는 돌아간다.
//   CF_API_TOKEN(또는 CLOUDFLARE_API_TOKEN) · CF_ACCOUNT_ID(또는 CLOUDFLARE_ACCOUNT_ID)
// ★토큰 값은 어디에도 찍지 않는다. 있다/없다와 결과만 낸다.
//
//   node deploy-watch.js
//   ALERT_HOURS=6 SITE=https://auction-view.pages.dev node deploy-watch.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const STATE = path.join(ROOT, 'data', 'deploy-watch.json');
const SITE = (process.env.SITE || 'https://auction-view.pages.dev').replace(/\/+$/, '');
const PROJECT = process.env.CF_PAGES_PROJECT || 'auction-view';
const ALERT_HOURS = Number(process.env.ALERT_HOURS || 6);
const BRANCH = process.env.WATCH_REF || 'origin/main';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };
const git = (...a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 1 << 28 });

/**
 * 창고의 public/ 파일 목록. Pages 의 출력 디렉터리가 public 이라 여기만 서빙된다
 * (wrangler.toml: pages_build_output_dir = "public").
 */
function repoPublicFiles() {
  const out = git('ls-tree', '-r', '--name-only', '-z', BRANCH, 'public/').toString('utf8');
  return out.split('\0').filter(Boolean);
}

/**
 * 라이브가 그 파일을 어떤 주소로 주는가.
 * Pages 는 /foo.html 을 /foo 로 308 보내므로 리다이렉트를 따라간다.
 */
async function fetchLive(relPath) {
  const url = SITE + '/' + relPath.replace(/^public\//, '');
  const res = await fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) return { ok: false, status: res.status, hash: null };
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: true, status: res.status, hash: sha256(buf), bytes: buf.length };
}

/** 창고와 라이브가 같은가. 다르면 그 파일 이름을 남긴다. */
async function compareOutput() {
  const files = repoPublicFiles();
  const diverged = [];
  for (const f of files) {
    const repoHash = sha256(git('show', `${BRANCH}:${f}`));
    const live = await fetchLive(f);
    if (!live.ok || live.hash !== repoHash) {
      diverged.push({ file: f, liveStatus: live.status, same: false });
    }
  }
  return { checked: files.length, diverged };
}

/** KV 가 창고보다 얼마나 뒤처졌나. 배포와 별개로 막히는 자리라 따로 잰다. */
async function compareData() {
  let repoAt = null;
  try { repoAt = JSON.parse(git('show', `${BRANCH}:data/stats.json`).toString('utf8')).generatedAt; } catch {}
  let liveAt = null, liveCount = null, repoCount = null;
  try {
    const r = await fetch(SITE + '/api/auction/stats', { headers: { 'cache-control': 'no-cache' } });
    if (r.ok) { const j = await r.json(); liveAt = j.generatedAt; liveCount = j.itemCount; }
  } catch {}
  try { repoCount = JSON.parse(git('show', `${BRANCH}:data/stats.json`).toString('utf8')).itemCount; } catch {}
  const lagHours = (repoAt && liveAt) ? (Date.parse(repoAt) - Date.parse(liveAt)) / 3600000 : null;
  return { repoAt, liveAt, repoCount, liveCount, lagHours: lagHours === null ? null : Math.round(lagHours * 10) / 10 };
}

/**
 * 토큰이 있으면 "왜"를 덧붙인다. 없으면 조용히 건너뛴다 - 진단이 없다고 감시가
 * 멈추지는 않는다. ★토큰 값은 절대 출력하지 않는다.
 */
async function diagnose() {
  const token = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CF_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) return { available: false, why: 'CF_API_TOKEN/CF_ACCOUNT_ID 없음' };
  const api = `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${PROJECT}`;
  const head = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  try {
    const pr = await fetch(api, { headers: head });
    if (!pr.ok) return { available: false, why: 'project 조회 실패 http ' + pr.status };
    const src = ((await pr.json()).result || {}).source || null;
    const cfg = (src && src.config) || {};
    const dp = await fetch(api + '/deployments?per_page=1', { headers: head });
    let last = null;
    if (dp.ok) {
      const d = ((await dp.json()).result || [])[0];
      if (d) {
        last = {
          createdOn: d.created_on,
          status: d.latest_stage && d.latest_stage.status,
          trigger: d.deployment_trigger && d.deployment_trigger.type,
          commit: (d.source && d.source.config && d.source.config.commit_hash || '').slice(0, 8) || null,
        };
      }
    }
    return {
      available: true,
      gitConnected: !!(src && src.type),
      repo: src && src.type ? `${cfg.owner || '?'}/${cfg.repo_name || '?'}` : null,
      productionBranch: cfg.production_branch || null,
      productionDeploymentsEnabled: cfg.production_deployments_enabled !== false,
      lastDeployment: last,
    };
  } catch (e) {
    return { available: false, why: String(e.message || e).slice(0, 120) };
  }
}

(async () => {
  const now = new Date();
  const prev = readJson(STATE, {});
  const out = await compareOutput();
  const data = await compareData();
  const diag = await diagnose();

  const outputStale = out.diverged.length > 0;
  /* 언제부터 어긋나 있었나. 처음 어긋난 시각을 붙들고 있어야 "몇 시간째"를 말할 수 있다. */
  const since = outputStale ? (prev.divergedSince || now.toISOString()) : null;
  const staleHours = since ? Math.round(((now - Date.parse(since)) / 3600000) * 10) / 10 : 0;

  const alarms = [];
  if (outputStale && staleHours >= ALERT_HOURS) {
    alarms.push(`public/ 가 ${staleHours}시간째 라이브에 안 나갔다 (${out.diverged.map((d) => d.file).join(', ')})`);
  }
  if (data.lagHours !== null && data.lagHours >= ALERT_HOURS) {
    alarms.push(`웹 API(KV) 데이터가 창고보다 ${data.lagHours}시간 뒤처졌다 (라이브 ${data.liveCount} vs 창고 ${data.repoCount})`);
  }
  if (diag.available && diag.gitConnected === false) {
    alarms.push('Cloudflare Pages 에 Git 연결이 없다 - 자동 배포가 아예 일어나지 않는다');
  }
  if (diag.available && diag.productionDeploymentsEnabled === false) {
    alarms.push('Cloudflare Pages 의 프로덕션 자동 배포가 꺼져 있다');
  }

  const report = {
    at: now.toISOString(),
    site: SITE,
    ref: BRANCH,
    output: { checked: out.checked, diverged: out.diverged, divergedSince: since, staleHours },
    data,
    cloudflare: diag,
    alarms,
    ok: alarms.length === 0,
  };

  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify({ ...report, divergedSince: since }, null, 2));
  console.log(JSON.stringify(report, null, 2));

  /* 경보는 종료코드로도 낸다 - 작업 스케줄러의 "마지막 결과"에 그대로 보인다. */
  if (alarms.length) process.exitCode = 9;
})().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exitCode = 1;
});
