# Hourly single-request check for whether the court block has lifted.
# Scheduled tasks do not carry environment variables, so AUTO_RESUME is set here.
# On recovery the collector is re-enabled at its pre-block rate (BATCH_SIZE=24,
# LOOP_SLEEP_SECONDS=60 come from scripts/laptop-collector.ps1's own defaults).
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot\..
# Auto-resume is OFF after the 11:01 KST block of 2026-09-09. Resuming on its own
# would restart at the request rate that earned that block (924/hour against the
# 691/hour that had been running for days). The watch reports; a human sets the
# rate and says go. Set AUTO_RESUME=1 here again once a safe rate is decided.
$env:AUTO_RESUME = "0"
node court-recovery-watch.js
exit $LASTEXITCODE
