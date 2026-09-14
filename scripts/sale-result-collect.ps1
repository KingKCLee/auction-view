# Daily winning-price collection from 매각결과검색.
#
# This is the only source of 낙찰가 - the case detail endpoint carries 최저매각가 and
# a result code but dspslAmt is always null. The window reaches back about a week
# and the server decides it, so there is no same-day race: once a day is enough,
# and a missed day is recoverable as long as the next run happens within the week.
#
# Measured 2026-09-13: nothing had been scheduled, the last run was a one-off on
# 09-10, and winning prices sat frozen at 1,794 for three days while 1,247 more
# cases passed their 기일 uncaptured. That is what this task exists to prevent.
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot\..

# Same shared rate the other court processes use. One pass is ~308 requests over
# 48 courts, about 20 minutes.
if (-not $env:COURT_MIN_INTERVAL_MS) { $env:COURT_MIN_INTERVAL_MS = "10000" }
if (-not $env:COURT_JITTER_MS)       { $env:COURT_JITTER_MS = "1200" }
# The detail collector holds the gate lock through its own pacing wait, so a
# fail-fast run would only ever see COURT_BUSY. Wait for a turn.
if (-not $env:COURT_LOCK_WAIT_MS)    { $env:COURT_LOCK_WAIT_MS = "600000" }

# An un-gated court request throws instead of going out.
$env:NODE_OPTIONS = "--require ./court-gate-enforce.js"

node sale-result-collect.js
$code = $LASTEXITCODE
Write-Host "[saleresult] exit $code"

# The delta goes out with the detail collector's own commit; it already stages
# data/worker-deltas every cycle. Nothing to push from here.
exit $code
