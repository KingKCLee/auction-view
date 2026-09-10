# Hourly: who wrote to origin/main, and did the settings we fixed stay fixed.
# Read-only against git. No court traffic, so no gate involved.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot\..

node identity-watch.js
$code = $LASTEXITCODE

# 11 means an unknown identity appeared or a policy came undone. The detail is in
# data/identity-alert.json; the exit code is what the scheduled task records.
if ($code -eq 11) { Write-Host "[identity] ATTENTION - see data/identity-alert.json" }
exit $code
