# Hourly single-request check for whether the court block has lifted.
# Scheduled tasks do not carry environment variables, so AUTO_RESUME is set here.
# On recovery the collector is re-enabled at its pre-block rate (BATCH_SIZE=24,
# LOOP_SLEEP_SECONDS=60 come from scripts/laptop-collector.ps1's own defaults).
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot\..
$env:AUTO_RESUME = "1"
node court-recovery-watch.js
exit $LASTEXITCODE
