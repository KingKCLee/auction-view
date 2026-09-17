# Hourly single-request check for whether the court block has lifted.
# Scheduled tasks do not carry environment variables, so recovery settings are
# set here. This is not a block bypass: the watcher sends one normal case-detail
# request and resumes only after the official endpoint returns populated data.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot\..

# The collector may be stopped while this watcher keeps running, so pull the
# latest safety policy before probing. Failure to pull must not cause extra court
# traffic; the existing local policy remains in force for this one check.
try {
  git pull --rebase origin main | Out-Host
} catch {
  Write-Host "[recovery] git pull skipped: $($_.Exception.Message)"
}

# Safe post-block pacing. The 3.4s gate could approach ~900 requests/hour and a
# live block was observed after the effective rate rose above the previously
# stable ~691/hour. Resume materially below that level: 6.0s minimum plus up to
# 1.2s jitter, shared by every gated process on the laptop.
$env:COURT_MIN_INTERVAL_MS = "6000"
$env:COURT_JITTER_MS = "1200"
$env:LOOP_SLEEP_SECONDS = "0"
$env:ERROR_BACKOFF_SECONDS = "60"
# [2026-09-17 대표님 지시] 자동 재기동을 끈다.
# 관문이 풀렸다고 이 감시기가 수집기를 자기 판단으로 다시 띄우지 않는다 -
# 재개는 대표님이 명시적으로 지시할 때만 한다. 0 이면 court-recovery-watch.js 가
# resumeCollector() 를 부르지 않고 {started:false, why:"AUTO_RESUME is off"} 만 기록한다.
$env:AUTO_RESUME = "0"

node court-recovery-watch.js
exit $LASTEXITCODE
