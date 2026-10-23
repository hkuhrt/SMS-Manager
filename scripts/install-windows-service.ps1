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
if ($resolvedTarget -ne $expectedTarget) {
  throw "Das Installationsziel muss $expectedTarget sein."
}
if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
  throw 'Die lokale Node.js-Laufzeit wurde nicht gefunden.'
}
if (-not (Test-Path -LiteralPath $WinSwExecutable -PathType Leaf)) {
  throw 'WinSW-x64.exe fehlt im Ordner tools. Benötigt wird WinSW 2.12.x von https://github.com/winsw/winsw/releases.'
}
if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory '.env') -PathType Leaf)) {
  throw 'Die konfigurierte .env-Datei fehlt.'
}
$existingListener = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue
if ($existingListener) {
  throw 'Port 4173 ist bereits belegt. Bitte zuerst das manuell gestartete SMSReminder-Fenster schließen.'
}

New-Item -ItemType Directory -Force -Path $resolvedTarget | Out-Null
foreach ($directory in @('src', 'public', 'bridge')) {
  $sourcePart = Join-Path $sourceDirectory $directory
  $targetPart = Join-Path $resolvedTarget $directory
  New-Item -ItemType Directory -Force -Path $targetPart | Out-Null
  Get-ChildItem -LiteralPath $sourcePart -Force | Copy-Item -Destination $targetPart -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $resolvedTarget 'runtime') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $resolvedTarget 'data') | Out-Null
Copy-Item -LiteralPath $NodeExecutable -Destination (Join-Path $resolvedTarget 'runtime\node.exe') -Force
Copy-Item -LiteralPath $WinSwExecutable -Destination (Join-Path $resolvedTarget 'SMSReminderService.exe') -Force
Copy-Item -LiteralPath (Join-Path $sourceDirectory 'service\SMSReminderService.xml') -Destination (Join-Path $resolvedTarget 'SMSReminderService.xml') -Force
Copy-Item -LiteralPath (Join-Path $sourceDirectory 'MEDICAL OFFICE SMS.cmd') -Destination $resolvedTarget -Force
Copy-Item -LiteralPath (Join-Path $sourceDirectory '.env') -Destination $resolvedTarget -Force

$identity = "$env:USERDOMAIN\$env:USERNAME"
& icacls.exe $resolvedTarget /inheritance:r /grant:r `
  '*S-1-5-18:(OI)(CI)F' `
  '*S-1-5-32-544:(OI)(CI)F' `
  '*S-1-5-19:(OI)(CI)M' `
  "${identity}:(OI)(CI)RX" | Out-Null

$serviceExecutable = Join-Path $resolvedTarget 'SMSReminderService.exe'
& $serviceExecutable stop 2>$null
& $serviceExecutable uninstall 2>$null
& $serviceExecutable install
& $serviceExecutable start

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'SMS Terminerinnerungen.lnk'))
$shortcut.TargetPath = (Join-Path $env:WINDIR 'explorer.exe')
$shortcut.Arguments = 'http://127.0.0.1:4173/'
$shortcut.Save()

Write-Host "SMSReminder wurde als Windows-Dienst installiert: $resolvedTarget"
Write-Host "MEDICAL-OFFICE-Programmziel: $(Join-Path $resolvedTarget 'MEDICAL OFFICE SMS.cmd')"
