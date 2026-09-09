// Cloud Run Job one-shot master merge.
//
// clone/fetch GitHub latest -> apply worker deltas -> metrics -> guard -> commit
// -> pull --rebase -> push -> exit.
//
// The Docker image's own data/ is a build-time snapshot and is never used as the
// source of truth: every run works on a fresh checkout under the work dir.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { snapshot, evaluateGuard, evaluateRecordLoss, formatFailures, syncStatsCoverage } = require('./merge-guard-lib');

const REPO_SLUG = process.env.REPO_SLUG || 'KingKCLee/auction-view';
const BRANCH = process.env.REPO_BRANCH || 'main';
const WORK = process.env.CLOUD_WORK_DIR || path.join(os.tmpdir(), 'auction-master');
const SOURCE = process.env.CLOUD_SOURCE_DIR || __dirname;
const GUARD_TOLERANCE = Number(process.env.MERGE_GUARD_TOLERANCE || 0);
const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || '');
const GIT_NAME = process.env.GIT_COMMITTER_NAME || 'auction-cloud-master';
const GIT_EMAIL = process.env.GIT_COMMITTER_EMAIL || 'auction-cloud-master@users.noreply.github.com';

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

function readToken() {
  const file = process.env.GITHUB_TOKEN_FILE;
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return String(process.env.GITHUB_TOKEN || process.env.GH_PAT || '').trim();
}

const TOKEN = readToken();

// Never let the PAT reach a log line.
function redact(text) {
  let s = String(text ?? '');
  if (TOKEN) s = s.split(TOKEN).join('***');
  return s.replace(/https:\/\/[^@\s]*@github\.com/g, 'https://***@github.com');
}

function remoteUrl() {
  if (process.env.REPO_URL) return process.env.REPO_URL;
  if (TOKEN) return `https://x-access-token:${TOKEN}@github.com/${REPO_SLUG}.git`;
  return `https://github.com/${REPO_SLUG}.git`;
}

function log(...parts) {
  console.log(redact(parts.join(' ')));
}

function run(cmd, args, { cwd = WORK, check = true } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: process.env });
  const out = redact(`${r.stdout || ''}${r.stderr || ''}`).trim();
  const shown = args.map(a => (TOKEN && a.includes(TOKEN) ? '<redacted-url>' : a));
  log(`$ ${cmd} ${shown.join(' ')}`);
  if (out) console.log(redact(out));
  if (check && r.status !== 0) {
    throw new Error(`${cmd} ${shown.join(' ')} failed with exit ${r.status}`);
  }
  return { status: r.status, out };
}

const git = (args, opts) => run('git', args, opts);

function node(script, { cwd = WORK, check = true } = {}) {
  return run(process.execPath, [path.join(cwd, script)], { cwd, check });
}

function prepareCheckout() {
  const gitDir = path.join(WORK, '.git');
  if (!fs.existsSync(gitDir)) {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(WORK), { recursive: true });
    run('git', ['clone', '--depth', '50', '--branch', BRANCH, remoteUrl(), WORK], { cwd: os.tmpdir() });
  } else {
    git(['remote', 'set-url', 'origin', remoteUrl()]);
    git(['fetch', '--depth', '50', 'origin', BRANCH]);
    git(['reset', '--hard', `origin/${BRANCH}`]);
    git(['clean', '-fd', '--', 'data']);
  }
  git(['config', 'user.name', GIT_NAME]);
  git(['config', 'user.email', GIT_EMAIL]);
}

const MERGE_SCRIPTS = ['apply-worker-deltas.js', 'metrics-corrector.js', 'dual-collector-lib.js', 'merge-guard-lib.js', 'export-for-web.js', 'upload-web-export.js'];

const sameDir = () => path.resolve(SOURCE) === path.resolve(WORK);

// The merge scripts live in the image, not necessarily in the checkout's history.
// Copy the ones we need into the work dir so a stale checkout can't run old logic.
function syncMergeScripts() {
  if (sameDir()) return;
  for (const name of MERGE_SCRIPTS) {
    const from = path.join(SOURCE, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(WORK, name));
  }
}

// Undo those copies before staging. The image copies differ from the checked-out
// ones at least in line endings, and any leftover diff makes `pull --rebase` bail
// with "cannot pull with rebase: You have unstaged changes".
function unsyncMergeScripts() {
  if (sameDir()) return;
  for (const name of MERGE_SCRIPTS) {
    const target = path.join(WORK, name);
    if (!fs.existsSync(target)) continue;
    const tracked = git(['ls-files', '--error-unmatch', '--', name], { check: false }).status === 0;
    if (tracked) git(['checkout', '--', name], { check: false });
    else fs.rmSync(target, { force: true });
  }
}

function restoreData(reason) {
  log(`[cloud-master] restoring canonical data/ (${reason})`);
  git(['checkout', '--', 'data'], { check: false });
  git(['clean', '-fd', '--', 'data'], { check: false });
}

function countDeltaFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) n += countDeltaFiles(p);
    else if (name.endsWith('.json')) n++;
  }
  return n;
}

function main() {
  const startedAt = new Date().toISOString();
  log(`[cloud-master] start ${startedAt} repo=${REPO_SLUG} branch=${BRANCH} work=${WORK} dryRun=${DRY_RUN}`);
  if (!TOKEN) log('[cloud-master] no GITHUB_TOKEN/GH_PAT present; push will be attempted anonymously and is expected to fail');

  prepareCheckout();
  syncMergeScripts();

  const DATA = path.join(WORK, 'data', 'auctions.json');
  const STATS = path.join(WORK, 'data', 'stats.json');
  const DELTAS = path.join(WORK, 'data', 'worker-deltas');

  const baseRows = readJson(DATA, null);
  if (!Array.isArray(baseRows)) throw new Error('canonical data/auctions.json missing or not an array');

  const before = snapshot(baseRows);
  const pendingDeltaFiles = countDeltaFiles(DELTAS);
  log(`[cloud-master] before ${JSON.stringify(before)}`);
  log(`[cloud-master] pending delta files=${pendingDeltaFiles}`);

  if (!pendingDeltaFiles) {
    log('[cloud-master] no pending deltas; nothing to merge');
  }

  node('apply-worker-deltas.js');
  node('metrics-corrector.js', { check: false });
  unsyncMergeScripts();

  const afterRows = readJson(DATA, null);
  if (!Array.isArray(afterRows)) {
    restoreData('merged canonical unreadable');
    throw new Error('merged data/auctions.json is missing or not an array');
  }
  const after = snapshot(afterRows);
  log(`[cloud-master] after  ${JSON.stringify(after)}`);

  const failures = [
    ...evaluateRecordLoss(baseRows, afterRows),
    ...evaluateGuard(before, after, { tolerance: GUARD_TOLERANCE })
  ];
  if (failures.length) {
    console.error('[cloud-master] MERGE GUARD FAILED - canonical would shrink; aborting commit/push');
    console.error(formatFailures(failures));
    restoreData('merge guard failed');
    console.error(JSON.stringify({ mode: 'cloud-master-once', ok: false, guard: 'fail', failures, before, after }, null, 2));
    process.exitCode = 3;
    return;
  }
  log('[cloud-master] merge guard passed');

  // stats.json coverage is otherwise written from truncated worker subsets.
  writeJson(STATS, syncStatsCoverage(readJson(STATS, {}), afterRows));

  // docs/data used to get a 21MB copy of canonical on every merge, which is what
  // was bloating the repository. The web reads the small KV payloads through the
  // Pages API now, so nothing copies canonical into the repo any more.
  const wanted = ['data/auctions.json', 'data/stats.json', 'data/state.json', 'data/worker-deltas'];

  // Stage each path on its own. A single `git add` over the whole list fails
  // wholesale if one entry has become ignored or no longer exists, and that took
  // the merge down for nine hours without anything else looking wrong: docs/data
  // was removed from the repo and added to .gitignore while the running image
  // still listed it, so `git add` exited 1 and the job died after a clean merge.
  const paths = [];
  for (const p of wanted) {
    if (!fs.existsSync(path.join(WORK, p))) { log(`[cloud-master] skipping ${p}: not in the checkout`); continue; }
    const r = git(['add', '--', p], { check: false });
    if (r.status === 0) paths.push(p);
    else log(`[cloud-master] skipping ${p}: git add exited ${r.status}`);
  }
  if (!paths.length) throw new Error('nothing could be staged; refusing to continue');
  const staged = git(['diff', '--cached', '--quiet'], { check: false });
  if (staged.status === 0) {
    log('[cloud-master] nothing staged; exiting without commit');
    console.log(JSON.stringify({ mode: 'cloud-master-once', ok: true, committed: false, before, after }, null, 2));
    return;
  }

  const message = `data: cloud master merge ${new Date().toISOString()}`;
  if (DRY_RUN) {
    log('[cloud-master] DRY_RUN=1; skipping commit/push');
    restoreData('dry run');
    console.log(JSON.stringify({ mode: 'cloud-master-once', ok: true, committed: false, dryRun: true, before, after }, null, 2));
    return;
  }

  git(['commit', '-m', message]);

  // `pull --rebase` refuses to run on a dirty tree, so make sure nothing is left.
  const dirty = git(['status', '--porcelain'], { check: false }).out.trim();
  if (dirty) {
    console.error(`[cloud-master] work tree dirty after commit; aborting without push:\n${dirty}`);
    process.exitCode = 5;
    return;
  }

  const rebase = git(['pull', '--rebase', 'origin', BRANCH], { check: false });
  if (rebase.status !== 0) {
    // Never resolve a canonical conflict blindly; leave the remote untouched.
    git(['rebase', '--abort'], { check: false });
    console.error('[cloud-master] rebase onto origin failed; aborting without push');
    process.exitCode = 4;
    return;
  }

  git(['push', 'origin', `HEAD:${BRANCH}`]);
  const sha = git(['rev-parse', 'HEAD'], { check: false }).out.trim();

  // Refresh what the screens read. A failure here must not undo a good merge, so
  // it is reported rather than thrown.
  let webExport = null;
  try {
    node('export-for-web.js');
    const canUpload = process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN
      && process.env.CLOUDFLARE_KV_NAMESPACE_ID;
    if (canUpload) { node('upload-web-export.js'); webExport = 'exported and uploaded'; }
    else { webExport = 'exported; upload skipped (no Cloudflare credentials in env)'; }
  } catch (e) {
    webExport = `failed: ${e.message || e}`;
    console.error(`[cloud-master] web export ${webExport}`);
  }

  console.log(JSON.stringify({
    mode: 'cloud-master-once',
    ok: true,
    committed: true,
    commit: sha,
    appliedDeltaFiles: pendingDeltaFiles,
    webExport,
    before,
    after,
    startedAt,
    finishedAt: new Date().toISOString()
  }, null, 2));
}

try {
  main();
} catch (e) {
  console.error(redact(e?.stack || e?.message || String(e)));
  process.exitCode = process.exitCode || 1;
}
