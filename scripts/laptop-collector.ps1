$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
$env:WORKER_ID = "laptop"
# Every node process started from here (and their children, since env is
# inherited) goes through the gate. An un-gated court request throws instead of
# going out, which stops a second caller from racing the first.
$env:NODE_OPTIONS = "--require ./court-gate-enforce.js"
# Request pacing after the 11:01 KST block of 2026-09-09. Measured that day:
#   924 req/hour  -> blocked after 94 minutes
#   691 req/hour  -> had run for days without a block
# The court's limit tracks hourly volume, not the gap between calls, so the gap
# is now 10s: about 360 req/hour, roughly half the rate that was known to survive.
# Each item costs two requests (detail + statusReport), so this is ~180 items/hour.
if (-not $env:COURT_MIN_INTERVAL_MS) { $env:COURT_MIN_INTERVAL_MS = "10000" }
if (-not $env:BATCH_SIZE) { $env:BATCH_SIZE = "24" }

# Post-block safe pacing. The old 3.4s minimum could approach ~900 requests/hour.
# Keep the shared gate materially below the previously stable ~691/hour rate.
if (-not $env:COURT_MIN_INTERVAL_MS) { $env:COURT_MIN_INTERVAL_MS = "6000" }
if (-not $env:COURT_JITTER_MS) { $env:COURT_JITTER_MS = "1200" }

# No extra idle wait between cycles: court-gate.js now controls the actual request
# rate across every child process. Errors still back off to avoid local spin.
if (-not $env:LOOP_SLEEP_SECONDS) { $env:LOOP_SLEEP_SECONDS = "0" }
if (-not $env:ERROR_BACKOFF_SECONDS) { $env:ERROR_BACKOFF_SECONDS = "60" }

try {
  Start-Process -FilePath "node" -ArgumentList "collector-monitor.js" -WindowStyle Hidden
  Start-Sleep -Seconds 1
  Write-Host "[monitor] http://localhost:8787"
} catch {
  Write-Host "[monitor] $($_.Exception.Message)"
}

while ($true) {
  try {
    # laptop-worker truncates data/auctions.json to the candidate subset while it
    # runs and restores it at the end. If a cycle was killed mid-run the file is
    # left short, and `git pull --rebase` then refuses to run on the dirty tree
    # forever. The laptop never authors canonical, only deltas, so discarding any
    # local canonical edit here is always the correct recovery.
    $dirty = git status --porcelain data/auctions.json data/stats.json
    if ($dirty) {
      Write-Host "[laptop] discarding leftover canonical edit before pull"
      git checkout -- data/auctions.json data/stats.json
    }
    git pull --rebase origin main
    node laptop-worker.js
    $delta = git status --porcelain data/worker-deltas
    if ($delta) {
      git add data/worker-deltas
      git commit -m "data: laptop detail delta $(Get-Date -Format s)"
      git pull --rebase origin main
      git push origin HEAD:main
    }
    $cycleFailed = $false
  } catch {
    Write-Host "[laptop] $($_.Exception.Message)"
    $cycleFailed = $true
  }
  $wait = if ($cycleFailed) { [int]$env:ERROR_BACKOFF_SECONDS } else { [int]$env:LOOP_SLEEP_SECONDS }
  if ($wait -gt 0) {
    Write-Host "[laptop] $wait초 후 다음 회차 시작"
    Start-Sleep -Seconds $wait
  } else {
    Write-Host "[laptop] 곧바로 다음 회차 시작 (관문이 요청 속도를 통제)"
  }
}
