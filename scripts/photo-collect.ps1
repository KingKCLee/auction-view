# One photo pass, then publish. Scheduled tasks carry no environment, so the
# safety settings are set here rather than assumed.
#
# This runs alongside the detail collector. They share one rate through
# court-gate.js: each process enforces the same minimum against the gate's shared
# last-call timestamp, so two runners is still ~360 requests/hour in total, not
# 720. Two independent pacers is what got this IP blocked on 2026-09-09.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot\..

# Same pacing the detail collector uses. Do not raise these independently.
if (-not $env:COURT_MIN_INTERVAL_MS) { $env:COURT_MIN_INTERVAL_MS = "10000" }
if (-not $env:COURT_JITTER_MS)       { $env:COURT_JITTER_MS = "1200" }
# The detail collector holds the gate lock through its own pacing wait, so a
# fail-fast pass would only ever see COURT_BUSY. Wait for a turn instead.
if (-not $env:COURT_LOCK_WAIT_MS)    { $env:COURT_LOCK_WAIT_MS = "240000" }
if (-not $env:PHOTO_BATCH)           { $env:PHOTO_BATCH = "6" }

# An un-gated court request throws instead of going out.
$env:NODE_OPTIONS = "--require ./court-gate-enforce.js"

node photo-worker.js
$workerExit = $LASTEXITCODE
Write-Host "[photos] worker exit $workerExit"

# 12 means the gate stopped us. Publish nothing, try again next time.
if ($workerExit -eq 12) {
  Write-Host "[photos] gate stopped this pass; not publishing"
  exit 0
}

# The delta goes out with the detail collector's own commit - it already stages
# data/worker-deltas every cycle. Only the image files need publishing here, and
# they are new files, never edits.
$dirty = git status --porcelain photos
if (-not $dirty) {
  Write-Host "[photos] no new image files"
  exit 0
}

for ($i = 1; $i -le 3; $i++) {
  git add photos
  git commit -m "data: laptop photos $(Get-Date -Format s)" | Out-Host
  git pull --rebase origin main | Out-Host
  git push origin HEAD:main | Out-Host
  if ($LASTEXITCODE -eq 0) { Write-Host "[photos] published on attempt $i"; exit 0 }
  Write-Host "[photos] publish attempt $i failed; another writer got there first"
  Start-Sleep -Seconds 20
}
Write-Host "[photos] could not publish after 3 attempts; the files stay staged for next time"
exit 0
