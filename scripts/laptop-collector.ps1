$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..
$env:WORKER_ID = "laptop"
if (-not $env:BATCH_SIZE) { $env:BATCH_SIZE = "12" }

try {
  Start-Process -FilePath "node" -ArgumentList "collector-monitor.js" -WindowStyle Hidden
  Start-Sleep -Seconds 1
  Write-Host "[monitor] http://localhost:8787"
} catch {
  Write-Host "[monitor] $($_.Exception.Message)"
}

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
  Write-Host "[laptop] 5분 후 다음 회차 시작"
  Start-Sleep -Seconds 300
}
