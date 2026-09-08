#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.."
export CURRENT_SWEEP_COURTS="${CURRENT_SWEEP_COURTS:-4}"
export CURRENT_SWEEP_NOTICES="${CURRENT_SWEEP_NOTICES:-4}"

while true; do
  git pull --rebase origin main || true
  node apply-worker-deltas.js || true
  node current-court-sweep.js || true
  node basic-info-enrich.js || true
  node discovery-supervisor.js || true
  node sale-notice-history-worker.js || true
  node property-history-discovery-v2.js || true
  node metrics-corrector.js || true

  git add data/auctions.json data/stats.json data/state.json data/worker-deltas docs 2>/dev/null || true
  if ! git diff --cached --quiet; then
    git commit -m "data: cloud master $(date -u +'%Y-%m-%dT%H:%MZ')" || true
    git pull --rebase origin main || true
    git push origin HEAD:main || true
  fi
  sleep 300
done
