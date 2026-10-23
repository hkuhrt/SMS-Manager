Set-StrictMode -Version 2.0

$script:AllowedReleaseRoots = @(
  'src', 'public', 'bridge', 'scripts',
  'package.json', '.env.example', '.gitignore', 'README.md',
  'MEDICAL OFFICE SMS.cmd', 'SMSReminder starten.cmd',
  'SMSReminderService.xml', 'release-manifest.json'
)
$script:RequiredManagedPaths = @(
  'src', 'public', 'bridge', 'scripts',
  'package.json', '.env.example', '.gitignore', 'README.md',
  'MEDICAL OFFICE SMS.cmd', 'SMSReminder starten.cmd', 'SMSReminderService.xml'
)

function ConvertTo-SmsVersion {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value -notmatch '^v?(\d+)\.(\d+)\.(\d+)$') {
    throw "Ungueltige Versionsnummer: $Value"
  }
  return [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
}

function Compare-SmsVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Current,
    [Parameter(Mandatory = $true)][string]$Latest
  )
  return (ConvertTo-SmsVersion $Current).CompareTo((ConvertTo-SmsVersion $Latest))
}

function ConvertTo-SafeStatusMessage {
  param([Parameter(Mandatory = $true)][string]$Message)
  $safe = ($Message -replace '[\x00-\x1f\x7f]', ' ' -replace '\s+', ' ').Trim()
  if ($safe.Length -gt 240) { $safe = $safe.Substring(0, 240) }
  return $safe
}

function Write-UpdateLog {
  param(
    [Parameter(Mandatory = $true)][string]$DataDirectory,
    [Parameter(Mandatory = $true)][string]$State,
    [Parameter(Mandatory = $true)][string]$Message
  )
  New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null
  $logPath = Join-Path $DataDirectory 'update.log'
  if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 1MB) {
    $archivePath = Join-Path $DataDirectory 'update.log.1'
    Move-Item -LiteralPath $logPath -Destination $archivePath -Force
  }
  $line = '{0} [{1}] {2}{3}' -f ([DateTime]::UtcNow.ToString('o')), $State, (ConvertTo-SafeStatusMessage $Message), [Environment]::NewLine
  [IO.File]::AppendAllText($logPath, $line, [Text.UTF8Encoding]::new($false))
}

function Write-UpdateState {
  param(
    [Parameter(Mandatory = $true)][string]$DataDirectory,
    [Parameter(Mandatory = $true)][string]$CurrentVersion,
    [AllowNull()][string]$LatestVersion,
    [Parameter(Mandatory = $true)][ValidateSet('current', 'updated', 'blocked', 'failed', 'never-checked')][string]$State,
    [Parameter(Mandatory = $true)][string]$Message,
    [AllowNull()][string]$InstalledAt
  )
  New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null
  $payload = [ordered]@{
    currentVersion = $CurrentVersion
    latestVersion = $LatestVersion
    state = $State
    checkedAt = [DateTime]::UtcNow.ToString('o')
    installedAt = $InstalledAt
    message = ConvertTo-SafeStatusMessage $Message
  }
  $target = Join-Path $DataDirectory 'update-status.json'
  $temporary = "$target.tmp"
  [IO.File]::WriteAllText($temporary, ($payload | ConvertTo-Json -Depth 3), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $target -Force
  Write-UpdateLog -DataDirectory $DataDirectory -State $State -Message $Message
}

function Get-DotEnvValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*)\s*$')) {
      return $Matches[1].Trim().Trim('"').Trim("'")
    }
  }
  return $null
}

function Test-AutoUpdateEnabled {
  param([Parameter(Mandatory = $true)][string]$EnvPath)
  $value = Get-DotEnvValue -Path $EnvPath -Name 'AUTO_UPDATE'
  if ([string]::IsNullOrWhiteSpace($value)) { return $true }
  return @('0', 'false', 'no', 'off') -notcontains $value.ToLowerInvariant()
}

function Get-ApplicationVersion {
  param([Parameter(Mandatory = $true)][string]$ApplicationDirectory)
  $packagePath = Join-Path $ApplicationDirectory 'package.json'
  if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "package.json fehlt in $ApplicationDirectory."
  }
  $metadata = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
  [void](ConvertTo-SmsVersion ([string]$metadata.version))
  return [string]$metadata.version
}

function Test-SafeReleasePath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $normalized = $Path.Replace('\', '/').TrimEnd('/')
  if ([string]::IsNullOrWhiteSpace($normalized)) { return $false }
  if ($normalized.StartsWith('/') -or $normalized -match '^[a-zA-Z]:') { return $false }
  $segments = @($normalized.Split('/'))
  if ($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }) { return $false }
  return $script:AllowedReleaseRoots -contains $segments[0]
}

function Expand-SmsRelease {
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$DestinationPath,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion
  )
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null
  $destinationFull = [IO.Path]::GetFullPath($DestinationPath).TrimEnd('\') + '\'
  $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    if ($archive.Entries.Count -gt 500) { throw 'Das Releasearchiv enthaelt zu viele Eintraege.' }
    $totalSize = 0L
    foreach ($entry in $archive.Entries) {
      $relative = $entry.FullName.Replace('\', '/')
      if (-not (Test-SafeReleasePath $relative)) { throw "Unzulaessiger Archivpfad: $relative" }
      $totalSize += $entry.Length
      if ($totalSize -gt 100MB) { throw 'Das Releasearchiv ist entpackt zu gross.' }
      $target = [IO.Path]::GetFullPath((Join-Path $DestinationPath $relative))
      if (-not $target.StartsWith($destinationFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Archivpfad verlaesst das Zielverzeichnis: $relative"
      }
      if ($relative.EndsWith('/')) {
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        continue
      }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
  } finally {
    $archive.Dispose()
  }

  $manifestPath = Join-Path $DestinationPath 'release-manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'release-manifest.json fehlt.' }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ([int]$manifest.schemaVersion -ne 1) { throw 'Die Manifestversion wird nicht unterstuetzt.' }
  if ([string]$manifest.version -ne $ExpectedVersion) { throw 'Release- und Manifestversion stimmen nicht ueberein.' }
  [void](ConvertTo-SmsVersion ([string]$manifest.version))
  if ([string]$manifest.commit -notmatch '^[a-fA-F0-9]{40}$') { throw 'Der Release-Commit ist ungueltig.' }

  $manifestFiles = @($manifest.files)
  $expectedPaths = @{}
  foreach ($file in $manifestFiles) {
    $relative = ([string]$file.path).Replace('\', '/')
    if (-not (Test-SafeReleasePath $relative) -or $relative -eq 'release-manifest.json') {
      throw "Unzulaessiger Manifestpfad: $relative"
    }
    if ($expectedPaths.ContainsKey($relative)) { throw "Doppelter Manifestpfad: $relative" }
    if ([string]$file.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "Ungueltige Pruefsumme fuer $relative" }
    $expectedPaths[$relative] = ([string]$file.sha256).ToLowerInvariant()
  }

  $actualFiles = Get-ChildItem -LiteralPath $DestinationPath -File -Recurse | ForEach-Object {
    $_.FullName.Substring($destinationFull.Length).Replace('\', '/')
  } | Where-Object { $_ -ne 'release-manifest.json' }
  if (@($actualFiles).Count -ne $expectedPaths.Count) { throw 'Dateiliste und Manifest stimmen nicht ueberein.' }
  foreach ($relative in $actualFiles) {
    if (-not $expectedPaths.ContainsKey($relative)) { throw "Unerwartete Datei im Release: $relative" }
    $actualHash = (Get-FileHash -LiteralPath (Join-Path $DestinationPath $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedPaths[$relative]) { throw "Pruefsumme stimmt nicht: $relative" }
  }

  $managedPaths = @($manifest.managedPaths | ForEach-Object { [string]$_ })
  foreach ($managedPath in $managedPaths) {
    if (-not (Test-SafeReleasePath ([string]$managedPath)) -or [string]$managedPath -eq 'release-manifest.json') {
      throw "Unzulaessiger verwalteter Pfad: $managedPath"
    }
  }
  $requiredManaged = @($script:RequiredManagedPaths | Sort-Object)
  $actualManaged = @($managedPaths | Sort-Object -Unique)
  if ($actualManaged.Count -ne $requiredManaged.Count -or (Compare-Object $requiredManaged $actualManaged)) {
    throw 'Die verwalteten Releasepfade sind unvollstaendig oder unerwartet.'
  }
  return $manifest
}

Export-ModuleMember -Function @(
  'Compare-SmsVersion', 'ConvertTo-SmsVersion', 'ConvertTo-SafeStatusMessage',
  'Write-UpdateLog', 'Write-UpdateState', 'Get-DotEnvValue',
  'Test-AutoUpdateEnabled', 'Get-ApplicationVersion', 'Test-SafeReleasePath',
  'Expand-SmsRelease'
)
