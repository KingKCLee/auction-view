# Hourly: is what the screens read (Cloudflare KV) as fresh as the repo's canonical.
# No court traffic, so no gate involved - this runs even while the collectors are blocked.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot\..
. "$PSScriptRoot\_load-cf-env.ps1"

git fetch --quiet origin
node web-refresh.js
$code = $LASTEXITCODE

# 8 = Cloudflare 자격 없음(사람이 넣어야 한다) · 9 = 내보내기/업로드 실패
if ($code -eq 8) { Write-Host "[web-refresh] ops/cf.env 에 Cloudflare 자격이 필요하다" }
if ($code -eq 9) { Write-Host "[web-refresh] ATTENTION - see data/web-refresh-status.json" }
exit $code
