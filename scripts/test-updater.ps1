$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'update-lib.psm1') -Force
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Test fehlgeschlagen: $Message" }
}

Assert-True ((Compare-SmsVersion '0.3.0' '0.3.1') -lt 0) 'neuere Patchversion'
Assert-True ((Compare-SmsVersion '1.0.0' '0.9.9') -gt 0) 'kein Downgrade'
Assert-True ((Compare-SmsVersion '1.2.3' '1.2.3') -eq 0) 'gleiche Version'
try { ConvertTo-SmsVersion 'v1.2.3-beta' | Out-Null; throw 'Vorabversion wurde akzeptiert.' } catch {
  Assert-True ($_.Exception.Message -like '*Ungueltige Versionsnummer*') 'Vorabversion ablehnen'
}
Assert-True (Test-SafeReleasePath 'src/server.js') 'erlaubter Releasepfad'
Assert-True (-not (Test-SafeReleasePath '../src/server.js')) 'Pfad traversal ablehnen'
Assert-True (-not (Test-SafeReleasePath 'data/history.sqlite')) 'persistente Daten ablehnen'

$temporary = Join-Path ([IO.Path]::GetTempPath()) ('sms-updater-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temporary | Out-Null
try {
  Write-UpdateState -DataDirectory $temporary -CurrentVersion '0.3.0' -LatestVersion '0.3.1' -State blocked -Message "Lokale`nAenderungen" -InstalledAt $null
  $status = Get-Content -LiteralPath (Join-Path $temporary 'update-status.json') -Raw | ConvertFrom-Json
  Assert-True ($status.state -eq 'blocked') 'Status schreiben'
  Assert-True ($status.message -eq 'Lokale Aenderungen') 'Statusmeldung bereinigen'
  Assert-True ((Get-Item -LiteralPath (Join-Path $temporary 'update.log')).Length -gt 0) 'Updateprotokoll schreiben'

  $envFile = Join-Path $temporary '.env'
  [IO.File]::WriteAllText($envFile, "AUTO_UPDATE=false`n", [Text.UTF8Encoding]::new($false))
  Assert-True (-not (Test-AutoUpdateEnabled $envFile)) 'Updates per Konfiguration deaktivieren'

  $badArchive = Join-Path $temporary 'bad.zip'
  $archive = [IO.Compression.ZipFile]::Open($badArchive, [IO.Compression.ZipArchiveMode]::Create)
  try {
    $entry = $archive.CreateEntry('../escape.txt')
    $writer = [IO.StreamWriter]::new($entry.Open())
    try { $writer.Write('unsafe') } finally { $writer.Dispose() }
  } finally {
    $archive.Dispose()
  }
  $expanded = Join-Path $temporary 'expanded'
  try {
    Expand-SmsRelease -ArchivePath $badArchive -DestinationPath $expanded -ExpectedVersion '0.3.0' | Out-Null
    throw 'Unsicheres Archiv wurde akzeptiert.'
  } catch {
    Assert-True ($_.Exception.Message -like '*Unzulaessiger Archivpfad*') 'Archivpfad traversal ablehnen'
  }
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force
}

Write-Output 'Updater-Tests erfolgreich.'
