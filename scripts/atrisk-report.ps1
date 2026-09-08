# Every 30 minutes after a resume: how many of today's cases still have no
# winning price. These vanish from the source at midnight KST, so this number
# falling to zero before then is the whole point of the run.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot\..
node collector-alert.js --quiet | Tee-Object -FilePath (Join-Path $PSScriptRoot '..\data\atrisk-latest.json')
exit 0
