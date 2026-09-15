# Cloudflare 자격을 환경변수로 올린다. 값은 절대 화면에 내지 않는다 - 이 파일이
# 출력하는 것은 "몇 개를 올렸다"뿐이다.
#
# 자격은 ops/cf.env 에 KEY=VALUE 한 줄씩 둔다(이 파일은 .gitignore 에 있다):
#   CF_API_TOKEN=...
#   CF_ACCOUNT_ID=...
#   CF_KV_NAMESPACE_ID=...
$envFile = Join-Path $PSScriptRoot "..\ops\cf.env"
if (-not (Test-Path $envFile)) { Write-Host "[cf-env] ops/cf.env 없음 - 자격 없이 진행"; return }
$n = 0
foreach ($line in Get-Content $envFile) {
  $t = $line.Trim()
  if ($t -eq "" -or $t.StartsWith("#")) { continue }
  $i = $t.IndexOf("=")
  if ($i -lt 1) { continue }
  $k = $t.Substring(0, $i).Trim()
  $v = $t.Substring($i + 1).Trim()
  if ($k -eq "" -or $v -eq "") { continue }
  Set-Item -Path ("env:" + $k) -Value $v
  $n++
}
Write-Host "[cf-env] $n 개 배선 완료"
