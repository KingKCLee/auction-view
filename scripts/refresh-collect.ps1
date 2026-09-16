# 기일 임박 사건 재수집 — 2026-09-14 에 새로 저장하기로 한 필드를 채운다.
#
# 왜 필요한가: 접수일·개시결정일·배당요구종기·권리관계·감정 요항·점유/임차인현황은
# 전에는 응답에서 버리고 있었다. 원문을 저장하지 않으므로 소급 재추출이 불가능하고
# 재수집만이 방법이다.
#
# 관문을 공유한다 - 상세 수집기·사진 수집기와 같은 속도(약 360 req/h) 안에서 순번을 받는다.
# 그래서 셋이 함께 돌면 각자 느려진다. 그것이 의도다 - 법원 부하는 합산이기 때문이다.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot\..

if (-not $env:COURT_MIN_INTERVAL_MS) { $env:COURT_MIN_INTERVAL_MS = "10000" }
if (-not $env:COURT_JITTER_MS)       { $env:COURT_JITTER_MS = "1200" }
# 다른 수집기가 락을 쥐고 있는 동안 기다린다. 없으면 매번 COURT_BUSY 로 끝난다.
if (-not $env:COURT_LOCK_WAIT_MS)    { $env:COURT_LOCK_WAIT_MS = "300000" }
if (-not $env:REFRESH_DAYS)          { $env:REFRESH_DAYS = "7" }
# 12 -> 18 (2026-09-16). 실측: 한 회차 12건에 407초(건당 33초)가 걸리고 주기는 12분이라
# 약 5분이 남았다. 18건이면 약 10분으로 창을 채운다.
# ★법원에 가는 속도는 그대로다 - 관문이 요청 간격(3.4초)을 강제하므로 회차 크기는
#   속도가 아니라 **한 번 잡은 순번을 얼마나 쓰느냐**만 바꾼다. 병목은 유휴가 아니라
#   다른 수집기와의 관문 경합이었다.
if (-not $env:REFRESH_BATCH)         { $env:REFRESH_BATCH = "18" }

$env:NODE_OPTIONS = "--require ./court-gate-enforce.js"

node refresh-worker.js
$code = $LASTEXITCODE
Write-Host "[refresh] exit $code"
# 12 = 관문이 멈춰 세웠다. 발행하지 않고 다음 회차를 기다린다.
exit 0
