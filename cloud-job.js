const { spawnSync } = require('child_process');

async function probe() {
  const url = 'https://www.courtauction.go.kr/';
  const started = Date.now();
  try {
    const r = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0',
        'accept-language': 'ko-KR,ko;q=0.9'
      },
      redirect: 'follow'
    });
    console.log(JSON.stringify({
      mode: 'probe',
      ok: r.ok,
      status: r.status,
      url: r.url,
      elapsedMs: Date.now() - started
    }, null, 2));
    if (!r.ok) process.exitCode = 2;
  } catch (e) {
    console.error(JSON.stringify({
      mode: 'probe',
      ok: false,
      error: e.message || String(e),
      elapsedMs: Date.now() - started
    }, null, 2));
    process.exitCode = 1;
  }
}

function runNode(script) {
  const r = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env });
  if (r.status) process.exitCode = r.status;
}

async function main() {
  const mode = String(process.env.CLOUD_JOB_MODE || 'probe').toLowerCase();
  if (mode === 'probe') return probe();
  if (mode === 'apply-deltas') return runNode('apply-worker-deltas.js');
  if (mode === 'metrics') return runNode('metrics-corrector.js');
  if (mode === 'master-once' || mode === 'cloud-master-once') return runNode('cloud-master-once.js');
  throw new Error(`Unknown CLOUD_JOB_MODE=${mode}`);
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
