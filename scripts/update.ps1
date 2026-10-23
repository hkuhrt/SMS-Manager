[CmdletBinding()]
param(
  [ValidateSet('Auto', 'Checkout', 'Service', 'CheckOnly')][string]$Mode = 'Auto',
  [string]$ApplicationDirectory = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Import-Module (Join-Path $PSScriptRoot 'update-lib.psm1') -Force

$repository = 'hkuhrt/SMS-Manager'
$serviceName = 'PraxisReckerSMSReminder'
$serviceDefaultDirectory = 'C:\ProgramData\PraxisRecker\SMSReminder'
$userAgent = 'SMSReminder-Updater/0.3.0'
$installedAt = $null
$latestVersion = $null
$lockStream = $null

function Resolve-ApplicationDirectory {
  if (-not [string]::IsNullOrWhiteSpace($ApplicationDirectory)) {
    return [IO.Path]::GetFullPath($ApplicationDirectory).TrimEnd('\')
  }
  $candidate = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
  if (Test-Path -LiteralPath (Join-Path $candidate 'package.json') -PathType Leaf) { return $candidate }
  return $serviceDefaultDirectory
}

function Get-InstalledAt {
  param([string]$DataDirectory)
  $path = Join-Path $DataDirectory 'update-status.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try { return [string]((Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).installedAt) } catch { return $null }
}

function Set-Status {
  param(
    [string]$State,
    [string]$Message,
    [AllowNull()][string]$LatestVersion,
    [AllowNull()][string]$NewInstalledAt = $installedAt
  )
  Write-UpdateState -DataDirectory $script:dataDirectory -CurrentVersion $script:currentVersion `
    -LatestVersion $LatestVersion -State $State -Message $Message -InstalledAt $NewInstalledAt
}

function Get-LatestStableRelease {
  $headers = @{
    'Accept' = 'application/vnd.github+json'
    'User-Agent' = $userAgent
  }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases/latest" `
    -Headers $headers -Method Get -TimeoutSec 20
  if ($release.draft -or $release.prerelease) { throw 'GitHub lieferte kein stabiles Release.' }
  $tag = [string]$release.tag_name
  $version = $tag.TrimStart('v')
  [void](ConvertTo-SmsVersion $tag)
  return [pscustomobject]@{ Raw = $release; Tag = $tag; Version = $version }
}

function Invoke-Git {
  param([string[]]$Arguments, [switch]$AllowFailure)
  $output = @(& git -C $script:appDirectory @Arguments 2>&1)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "Git-Befehl fehlgeschlagen: $($Arguments -join ' ')"
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = ($output -join [Environment]::NewLine).Trim() }
}

function Update-Checkout {
  param([pscustomobject]$Release, [bool]$CheckOnly)
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Set-Status blocked 'Git wurde nicht gefunden; das automatische Update wurde uebersprungen.' $Release.Version
    return
  }
  $prefix = (Invoke-Git @('rev-parse', '--show-prefix')).Output
  if (-not [string]::IsNullOrWhiteSpace($prefix)) {
    Set-Status blocked 'Das Projekt ist kein eigenstaendiger Git-Checkout; das Update wurde uebersprungen.' $Release.Version
    return
  }
  $branch = (Invoke-Git @('branch', '--show-current')).Output
  if ($branch -ne 'main') {
    Set-Status blocked 'Das automatische Update ist nur auf dem Branch main moeglich.' $Release.Version
    return
  }
  $changes = (Invoke-Git @('status', '--porcelain=v1', '--untracked-files=normal')).Output
  if (-not [string]::IsNullOrWhiteSpace($changes)) {
    Set-Status blocked 'Lokale Aenderungen verhindern das automatische Update. Es wurde nichts ueberschrieben.' $Release.Version
    return
  }
  if ($CheckOnly) {
    Set-Status blocked "Version $($Release.Version) ist verfuegbar; CheckOnly hat nichts veraendert." $Release.Version
    return
  }

  Invoke-Git @('fetch', '--no-tags', 'origin', "refs/tags/$($Release.Tag):refs/tags/$($Release.Tag)") | Out-Null
  Invoke-Git @('fetch', 'origin', 'main') | Out-Null
  $tagOnMain = Invoke-Git @('merge-base', '--is-ancestor', "refs/tags/$($Release.Tag)", 'origin/main') -AllowFailure
  $fastForward = Invoke-Git @('merge-base', '--is-ancestor', 'HEAD', "refs/tags/$($Release.Tag)") -AllowFailure
  if ($tagOnMain.ExitCode -ne 0 -or $fastForward.ExitCode -ne 0) {
    Set-Status blocked 'Der Release-Tag ist kein sicherer Fast-Forward von main; das Update wurde uebersprungen.' $Release.Version
    return
  }

  $oldCommit = (Invoke-Git @('rev-parse', 'HEAD')).Output
  try {
    Invoke-Git @('merge', '--ff-only', "refs/tags/$($Release.Tag)") | Out-Null
    $updatedVersion = Get-ApplicationVersion $script:appDirectory
    if ($updatedVersion -ne $Release.Version) { throw 'Die installierte Version stimmt nicht mit dem Release ueberein.' }
  } catch {
    & git -C $script:appDirectory reset --hard $oldCommit 2>&1 | Out-Null
    throw
  }
  $script:currentVersion = $Release.Version
  $now = [DateTime]::UtcNow.ToString('o')
  Set-Status updated "Update auf Version $($Release.Version) wurde installiert." $Release.Version $now
}

function Get-ReleaseAsset {
  param([object]$Release, [string]$Name)
  $asset = @($Release.assets | Where-Object { [string]$_.name -eq $Name }) | Select-Object -First 1
  if ($null -eq $asset) { throw "Release-Datei fehlt: $Name" }
  return $asset
}

function Copy-ManagedPath {
  param([string]$SourceRoot, [string]$DestinationRoot, [string]$RelativePath)
  if (-not (Test-SafeReleasePath $RelativePath)) { throw "Unzulaessiger verwalteter Pfad: $RelativePath" }
  $source = Join-Path $SourceRoot $RelativePath
  $destination = Join-Path $DestinationRoot $RelativePath
  if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
  if (Test-Path -LiteralPath $source) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
  }
}

function Wait-ServiceVersion {
  param([string]$ExpectedVersion)
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    try {
      $status = Invoke-RestMethod -Uri 'http://127.0.0.1:4173/api/update-status' -Method Get -TimeoutSec 3
      if ([string]$status.currentVersion -eq $ExpectedVersion) { return $true }
    } catch { }
    Start-Sleep -Seconds 1
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Update-ServiceInstallation {
  param([pscustomobject]$Release, [bool]$CheckOnly)
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($null -eq $service) {
    Set-Status blocked 'Der Windows-Dienst ist nicht installiert; das Dienstupdate wurde uebersprungen.' $Release.Version
    return
  }
  if ($CheckOnly) {
    Set-Status blocked "Version $($Release.Version) ist verfuegbar; CheckOnly hat nichts veraendert." $Release.Version
    return
  }

  $updaterRoot = 'C:\ProgramData\PraxisRecker\SMSReminderUpdater'
  New-Item -ItemType Directory -Force -Path $updaterRoot | Out-Null
  $workRoot = Join-Path $updaterRoot ('work-' + [guid]::NewGuid().ToString('N'))
  $staging = Join-Path $workRoot 'staging'
  $backup = Join-Path $workRoot 'backup'
  New-Item -ItemType Directory -Force -Path $workRoot, $staging, $backup | Out-Null
  $assetName = "SMSReminder-$($Release.Tag).zip"
  $archivePath = Join-Path $workRoot $assetName
  $checksumPath = "$archivePath.sha256"
  $deploymentStarted = $false
  $serviceWasRunning = $service.Status -eq 'Running'
  $manifest = $null

  try {
    $archiveAsset = Get-ReleaseAsset $Release.Raw $assetName
    $checksumAsset = Get-ReleaseAsset $Release.Raw "$assetName.sha256"
    Invoke-WebRequest -Uri $archiveAsset.browser_download_url -OutFile $archivePath -UseBasicParsing -TimeoutSec 60
    Invoke-WebRequest -Uri $checksumAsset.browser_download_url -OutFile $checksumPath -UseBasicParsing -TimeoutSec 30
    $checksumText = (Get-Content -LiteralPath $checksumPath -Raw).Trim()
    if ($checksumText -notmatch '^([a-fA-F0-9]{64})\s{2}(.+)$' -or $Matches[2] -ne $assetName) {
      throw 'Die Release-Pruefsummendatei ist ungueltig.'
    }
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($actualHash -ne $Matches[1]) { throw 'Die Release-Pruefsumme stimmt nicht ueberein.' }
    $manifest = Expand-SmsRelease -ArchivePath $archivePath -DestinationPath $staging -ExpectedVersion $Release.Version

    foreach ($managedPath in @($manifest.managedPaths)) {
      $source = Join-Path $script:appDirectory ([string]$managedPath)
      if (Test-Path -LiteralPath $source) {
        $destination = Join-Path $backup ([string]$managedPath)
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
      }
    }

    if ($serviceWasRunning) { Stop-Service -Name $serviceName -Force; (Get-Service $serviceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20)) }
    $deploymentStarted = $true
    foreach ($managedPath in @($manifest.managedPaths)) {
      Copy-ManagedPath -SourceRoot $staging -DestinationRoot $script:appDirectory -RelativePath ([string]$managedPath)
    }
    Start-Service -Name $serviceName
    (Get-Service $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(20))
    if (-not (Wait-ServiceVersion $Release.Version)) { throw 'Der neue Dienst hat den Versionscheck nicht bestanden.' }
    if (-not $serviceWasRunning) {
      Stop-Service -Name $serviceName -Force
      (Get-Service $serviceName).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
    }

    foreach ($updaterFile in @('update.ps1', 'update-lib.psm1')) {
      Copy-Item -LiteralPath (Join-Path $staging "scripts\$updaterFile") -Destination (Join-Path $updaterRoot $updaterFile) -Force
    }
    $script:currentVersion = $Release.Version
    $now = [DateTime]::UtcNow.ToString('o')
    Set-Status updated "Update auf Version $($Release.Version) wurde installiert." $Release.Version $now
  } catch {
    $failure = $_.Exception.Message
    if ($deploymentStarted -and $null -ne $manifest) {
      Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
      foreach ($managedPath in @($manifest.managedPaths)) {
        $target = Join-Path $script:appDirectory ([string]$managedPath)
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        $saved = Join-Path $backup ([string]$managedPath)
        if (Test-Path -LiteralPath $saved) {
          New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
          Copy-Item -LiteralPath $saved -Destination $target -Recurse -Force
        }
      }
      if ($serviceWasRunning) { Start-Service -Name $serviceName -ErrorAction SilentlyContinue }
      $failure = "Update wurde zurueckgerollt: $failure"
    }
    throw $failure
  } finally {
    if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

$appDirectory = Resolve-ApplicationDirectory
if (-not (Test-Path -LiteralPath $appDirectory -PathType Container)) {
  throw "Anwendungsverzeichnis fehlt: $appDirectory"
}
$currentVersion = Get-ApplicationVersion $appDirectory
$envPath = Join-Path $appDirectory '.env'
$configuredDataDirectory = Get-DotEnvValue -Path $envPath -Name 'DATA_DIR'
if ([string]::IsNullOrWhiteSpace($configuredDataDirectory)) {
  $dataDirectory = Join-Path $appDirectory 'data'
} else {
  $dataDirectory = [Environment]::ExpandEnvironmentVariables($configuredDataDirectory)
}
$installedAt = Get-InstalledAt $dataDirectory

try {
  New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
  $lockPath = Join-Path $dataDirectory 'update.lock'
  try {
    $lockStream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    Set-Status blocked 'Eine andere Updatepruefung laeuft bereits.' $null
    exit 10
  }
  if (-not (Test-AutoUpdateEnabled $envPath)) {
    Set-Status current 'Automatische Updates sind in der lokalen Konfiguration deaktiviert.' $currentVersion
    exit 0
  }

  $release = Get-LatestStableRelease
  $latestVersion = $release.Version
  if ((Compare-SmsVersion $currentVersion $release.Version) -ge 0) {
    Set-Status current "Version $currentVersion ist aktuell." $release.Version
    exit 0
  }

  $checkOnly = $Mode -eq 'CheckOnly'
  $effectiveMode = $Mode
  if ($Mode -eq 'Auto' -or $Mode -eq 'CheckOnly') {
    $effectiveMode = if (Test-Path -LiteralPath (Join-Path $appDirectory '.git')) { 'Checkout' } else { 'Service' }
  }
  if ($effectiveMode -eq 'Checkout') { Update-Checkout -Release $release -CheckOnly $checkOnly }
  else { Update-ServiceInstallation -Release $release -CheckOnly $checkOnly }
} catch {
  $safeFailure = ConvertTo-SafeStatusMessage $_.Exception.Message
  try { Set-Status failed "Updatepruefung fehlgeschlagen: $safeFailure" $latestVersion } catch { }
  Write-Warning "Updatepruefung fehlgeschlagen: $safeFailure"
  exit 20
} finally {
  if ($null -ne $lockStream) { $lockStream.Dispose() }
}
