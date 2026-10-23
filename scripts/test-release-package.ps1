[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'update-lib.psm1') -Force

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('sms-release-validation-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temporary | Out-Null
try {
  $manifest = Expand-SmsRelease -ArchivePath $ArchivePath -DestinationPath $temporary -ExpectedVersion $ExpectedVersion
  if ([string]$manifest.version -ne $ExpectedVersion) { throw 'Manifestversion stimmt nicht.' }
  foreach ($required in @('src\server.js', 'public\index.html', 'scripts\update.ps1', 'package.json', 'SMSReminderService.xml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $temporary $required) -PathType Leaf)) {
      throw "Pflichtdatei fehlt: $required"
    }
  }
  foreach ($forbidden in @('.env', 'data', 'runtime', 'tools', 'test')) {
    if (Test-Path -LiteralPath (Join-Path $temporary $forbidden)) { throw "Verbotener Releaseinhalt: $forbidden" }
  }
  Write-Output 'Releasepaket erfolgreich validiert.'
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
