// Watches who is writing to origin/main, and whether the policies we set keep
// holding.
//
// Measured 2026-09-10: 199 commits on this repository carry the identity
// `KingKCLee <noble.kclee@gmail.com>`, which is nobody's machine here - this
// laptop commits as court-auction-laptop, the Cloud Run job as
// auction-cloud-master, GitHub Actions as court-auction-bot. Those commits are
// unsigned (so not the GitHub web UI), carry a +0900 offset, and land on a
// roughly two-hour cadence at about half past the hour, through the night. They
// are an automated writer we did not account for, and twice they put back a cron
// that the project rule forbids.
//
// This does not block anything - it cannot, the writer is upstream of us. It
// makes the writing visible: who wrote, how much, and whether the two settings
// that were quietly reverted before have been reverted again.
//
//   node identity-watch.js            # check, write data/identity-alert.json
//   IDENTITY_WINDOW=48 node ...       # hours of history to census (default 24)
//
// Exit 0 clean, 11 when something needs a human look.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'data', 'identity-alert.json');
const BRANCH = process.env.REPO_BRANCH || 'main';
const WINDOW_HOURS = Number(process.env.IDENTITY_WINDOW || 24);

// Machines we run. Anything else is either the unattributed writer below or new.
const APPROVED = new Set([
  'court-auction-bot@users.noreply.github.com',      // this laptop + GitHub Actions
  'auction-cloud-master@users.noreply.github.com'    // Cloud Run master job
]);

// Known address, unexplained writer. Kept in its own bucket rather than approved
// so it stays counted and visible instead of fading into the background.
const UNATTRIBUTED = new Set(['noble.kclee@gmail.com']);

const git = (args, opts = {}) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
  return { status: r.status, out: `${r.stdout || ''}`.trim(), err: `${r.stderr || ''}`.trim() };
};

const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};

// A file's content on origin/main, without touching the work tree - the
// collector runs in this same checkout and must not find the index moved.
function showFromOrigin(file) {
  const blob = git(['rev-parse', `origin/${BRANCH}:${file}`]);
  if (blob.status !== 0) return null;
  const content = git(['cat-file', 'blob', blob.out]);
  return content.status === 0 ? content.out : null;
}

// The two settings that were put back after being removed once already.
function policyChecks() {
  const findings = [];

  const listing = git(['ls-tree', '--name-only', `origin/${BRANCH}`, '.github/workflows/']);
  const workflows = listing.status === 0 ? listing.out.split('\n').filter(Boolean) : [];
  const scheduled = [];
  for (const wf of workflows) {
    const body = showFromOrigin(wf);
    if (body && /^\s*schedule:\s*$/m.test(body) && /^\s*-\s*cron:/m.test(body)) {
      scheduled.push(wf.replace('.github/workflows/', ''));
    }
  }
  if (scheduled.length) {
    findings.push({
      policy: 'no-cron',
      severity: 'high',
      detail: `cron is back on ${scheduled.length} workflow(s): ${scheduled.join(', ')}`,
      fix: 'remove the schedule block; CLAUDE.md says workflow_dispatch only'
    });
  }

  const watcher = showFromOrigin('scripts/recovery-watch.ps1');
  if (watcher && /AUTO_RESUME\s*=\s*"?1"?/.test(watcher)) {
    findings.push({
      policy: 'no-auto-resume',
      severity: 'high',
      detail: 'scripts/recovery-watch.ps1 sets AUTO_RESUME=1; court-recovery-watch.js spawns the collector directly on recovery',
      fix: 'the owner decides when the collector resumes, not a recovery event'
    });
  }

  return findings;
}

function main() {
  // Read-only. A failure here just means the census is against what we last saw.
  const fetched = git(['fetch', 'origin', BRANCH, '--quiet']);

  const since = new Date(Date.now() - WINDOW_HOURS * 3600 * 1000).toISOString();
  const log = git(['log', `--since=${since}`, '--pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%G?%x1f%s', `origin/${BRANCH}`]);
  const commits = log.status !== 0 || !log.out ? [] : log.out.split('\n').map(line => {
    const [sha, name, email, at, sig, subject] = line.split('\x1f');
    return { sha: (sha || '').slice(0, 8), name, email, at, signed: sig !== 'N', subject };
  });

  const census = {};
  for (const c of commits) {
    const bucket = APPROVED.has(c.email) ? 'approved' : UNATTRIBUTED.has(c.email) ? 'unattributed' : 'unknown';
    const key = `${c.name} <${c.email}>`;
    census[key] = census[key] || { bucket, commits: 0, firstAt: c.at, lastAt: c.at, signedCommits: 0 };
    census[key].commits++;
    if (c.signed) census[key].signedCommits++;
    if (c.at < census[key].firstAt) census[key].firstAt = c.at;
    if (c.at > census[key].lastAt) census[key].lastAt = c.at;
  }

  const unknown = commits.filter(c => !APPROVED.has(c.email) && !UNATTRIBUTED.has(c.email));
  const unattributed = commits.filter(c => UNATTRIBUTED.has(c.email));
  const policies = policyChecks();

  const previous = readJson(OUT, { history: [] });
  const entry = {
    at: new Date().toISOString(),
    windowHours: WINDOW_HOURS,
    fetched: fetched.status === 0,
    commitsInWindow: commits.length,
    census,
    unknownIdentityCommits: unknown.map(c => ({ sha: c.sha, at: c.at, who: `${c.name} <${c.email}>`, subject: c.subject })),
    unattributedCommits: unattributed.length,
    unattributedSample: unattributed.slice(0, 5).map(c => ({ sha: c.sha, at: c.at, subject: c.subject })),
    policyFindings: policies
  };

  const needsAttention = unknown.length > 0 || policies.length > 0;
  entry.status = needsAttention ? 'attention' : 'ok';

  const history = [entry, ...(previous.history || [])].slice(0, 200);
  fs.writeFileSync(OUT, JSON.stringify({ ...entry, history }, null, 2));

  console.log(JSON.stringify({ ...entry, history: undefined }, null, 2));

  for (const f of policies) console.error(`[identity-watch] POLICY ${f.severity}: ${f.detail}`);
  for (const c of unknown) console.error(`[identity-watch] UNKNOWN IDENTITY ${c.sha} ${c.who || ''} ${c.subject}`);
  if (unattributed.length) {
    console.error(`[identity-watch] ${unattributed.length} commit(s) in the last ${WINDOW_HOURS}h from the unattributed writer (noble.kclee@gmail.com).`);
  }

  if (needsAttention) process.exitCode = 11;
}

main();
