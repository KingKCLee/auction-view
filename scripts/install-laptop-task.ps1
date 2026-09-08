$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$collector = Join-Path $root "scripts\laptop-collector.ps1"
$taskName = "AuctionViewLaptopCollector"
$powerShell = (Get-Command powershell.exe).Source

if (-not (Test-Path $collector)) {
  throw "Collector script not found: $collector"
}

$action = New-ScheduledTaskAction `
  -Execute $powerShell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$collector`"" `
  -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Jibhyunjun court-auction laptop detail collector" `
  -Force | Out-Null

Write-Host "Installed scheduled task: $taskName"
Write-Host "It will start automatically when $env:USERNAME signs in."
Write-Host "Start now: Start-ScheduledTask -TaskName '$taskName'"
Write-Host "Stop now:  Stop-ScheduledTask -TaskName '$taskName'"
Write-Host "Status:    Get-ScheduledTask -TaskName '$taskName' | Get-ScheduledTaskInfo"
