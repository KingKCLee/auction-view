# Hourly: is what we pushed actually live, and is the web API's data keeping up.
# Read-only against git and HTTPS. No court traffic, so no gate involved.
#
# Why this exists (2026-09-15): the Pages Git connection was severed and nobody
# noticed for six days - pushes kept succeeding while the live site stayed on old
# code. Fixing it is a person's job; noticing it is not.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot\..

node deploy-watch.js
$code = $LASTEXITCODE

# 9 means the repo and the live site have been out of step past the threshold,
# or the data behind the web API has fallen behind. Detail: data/deploy-watch.json
if ($code -eq 9) { Write-Host "[deploy-watch] ATTENTION - see data/deploy-watch.json" }
exit $code
