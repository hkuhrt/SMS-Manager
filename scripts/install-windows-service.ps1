[CmdletBinding()]
param(
  [string]$TargetDirectory = 'C:\ProgramData\PraxisRecker\SMSReminder',
  [string]$NodeExecutable = 'C:\Users\h.kuhrt\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe',
  [string]$WinSwExecutable = (Join-Path $PSScriptRoot '..\tools\WinSW-x64.exe')
)

$ErrorActionPreference = 'Stop'
$sourceDirectory = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$expectedTarget = [System.IO.Path]::GetFullPath('C:\ProgramData\PraxisRecker\SMSReminder')
$resolvedTarget = [System.IO.Path]::GetFullPath($TargetDirectory)
$updaterDirectory = 'C:\ProgramData\PraxisRecker\SMSReminderUpdater'
if ($resolvedTarget -ne $expectedTarget) {
  throw "Das Installationsziel muss $expectedTarget sein."
}
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
  throw 'Die lokale Node.js-Laufzeit wurde nicht gefunden.'
}
if (-not (Test-Path -LiteralPath $WinSwExecutable -PathType Leaf)) {
  throw 'WinSW-x64.exe fehlt im Ordner tools. Benoetigt wird WinSW 2.12.x von https://github.com/winsw/winsw/releases.'
}
if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory '.env') -PathType Leaf)) {
  throw 'Die konfigurierte .env-Datei fehlt.'
}
$existingListener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
if ($existingListener) {
  throw 'Port 4173 ist bereits belegt. Bitte zuerst das manuell gestartete SMSReminder-Fenster schliessen.'
}

New-Item -ItemType Directory -Force -Path $resolvedTarget | Out-Null
foreach ($directory in @('src', 'public', 'bridge', 'scripts')) {
  $sourcePart = Join-Path $sourceDirectory $directory
  $targetPart = Join-Path $resolvedTarget $directory
  if (Test-Path -LiteralPath $targetPart) { Remove-Item -LiteralPath $targetPart -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $targetPart | Out-Null
  Get-ChildItem -LiteralPath $sourcePart -Force | Copy-Item -Destination $targetPart -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $resolvedTarget 'runtime') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $resolvedTarget 'data') | Out-Null
Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $resolvedTarget 'runtime\node.exe') -Force
Copy-Item -LiteralPath $WinSwExecutable -Destination (Join-Path $resolvedTarget 'SMSReminderService.exe') -Force
Copy-Item -LiteralPath (Join-Path $sourceDirectory 'service\SMSReminderService.xml') -Destination (Join-Path $resolvedTarget 'SMSReminderService.xml') -Force
foreach ($file in @('package.json', '.env.example', '.gitignore', 'README.md', 'MEDICAL OFFICE SMS.cmd', 'SMSReminder starten.cmd')) {
  Copy-Item -LiteralPath (Join-Path $sourceDirectory $file) -Destination $resolvedTarget -Force
}
Copy-Item -LiteralPath (Join-Path $sourceDirectory '.env') -Destination $resolvedTarget -Force

New-Item -ItemType Directory -Force -Path $updaterDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceDirectory 'scripts\update.ps1') -Destination $updaterDirectory -Force
Copy-Item -LiteralPath (Join-Path $sourceDirectory 'scripts\update-lib.psm1') -Destination $updaterDirectory -Force

$identity = "$env:USERDOMAIN\$env:USERNAME"
& icacls.exe $resolvedTarget /inheritance:r /grant:r `
  '*S-1-5-18:(OI)(CI)F' `
  '*S-1-5-32-544:(OI)(CI)F' `
  '*S-1-5-19:(OI)(CI)M' `
  "${identity}:(OI)(CI)RX" | Out-Null
& icacls.exe $updaterDirectory /inheritance:r /grant:r `
  '*S-1-5-18:(OI)(CI)F' `
  '*S-1-5-32-544:(OI)(CI)F' `
  "${identity}:(OI)(CI)RX" | Out-Null

$serviceExecutable = Join-Path $resolvedTarget 'SMSReminderService.exe'
& $serviceExecutable stop 2>$null
& $serviceExecutable uninstall 2>$null
& $serviceExecutable install
& $serviceExecutable start

$updateScript = Join-Path $updaterDirectory 'update.ps1'
$taskArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$updateScript`" -Mode Service -ApplicationDirectory `"$resolvedTarget`""
$taskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArguments
$startupTrigger = New-ScheduledTaskTrigger -AtStartup
$startupTrigger.Delay = 'PT2M'
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At '03:00'
$taskPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'PraxisReckerSMSReminderUpdate' -Action $taskAction `
  -Trigger @($startupTrigger, $dailyTrigger) -Principal $taskPrincipal -Settings $taskSettings `
  -Description 'Installiert stabile SMSReminder-Releases beim Windows-Start und taeglich um 03:00 Uhr.' -Force | Out-Null

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'SMS Terminerinnerungen.lnk'))
$shortcut.TargetPath = (Join-Path $env:WINDIR 'explorer.exe')
$shortcut.Arguments = 'http://127.0.0.1:4173/'
$shortcut.Save()

Write-Host "SMSReminder wurde als Windows-Dienst installiert: $resolvedTarget"
Write-Host "MEDICAL-OFFICE-Programmziel: $(Join-Path $resolvedTarget 'MEDICAL OFFICE SMS.cmd')"
Write-Host 'Automatische Updates: beim Windows-Start und taeglich um 03:00 Uhr.'
