$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
$env:WORKER_ID = "laptop"
if (-not $env:BATCH_SIZE) { $env:BATCH_SIZE = "12" }

while ($true) {
  try {
    git pull --rebase origin main
    node laptop-worker.js
    $delta = git status --porcelain data/worker-deltas
    if ($delta) {
      git add data/worker-deltas
      git commit -m "data: laptop detail delta $(Get-Date -Format s)"
      git pull --rebase origin main
      git push origin HEAD:main
    }
  } catch {
    Write-Host "[laptop] $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 300
}
