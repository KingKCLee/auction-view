$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
$env:WORKER_ID = "laptop"
# Every node process started from here (and their children, since env is
# inherited) goes through the gate. An un-gated court request throws instead of
# going out, which is what stops a second caller from racing the first.
$env:NODE_OPTIONS = "--require ./court-gate-enforce.js"
if (-not $env:BATCH_SIZE) { $env:BATCH_SIZE = "24" }
# No idle wait between cycles. The safe rate is enforced per request by
# court-gate.js (3.4s + jitter, shared across every process), so sleeping here
# only adds dead time - and dead time is cases expiring unscraped.
if (-not $env:LOOP_SLEEP_SECONDS) { $env:LOOP_SLEEP_SECONDS = "0" }
# A cycle that fails fast would otherwise spin, so errors still back off.
if (-not $env:ERROR_BACKOFF_SECONDS) { $env:ERROR_BACKOFF_SECONDS = "30" }

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
