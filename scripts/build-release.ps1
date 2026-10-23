[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [string]$Commit = 'unknown'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ($Commit -eq 'unknown') {
  $Commit = (& git -C $root rev-parse HEAD 2>$null).Trim()
}
if ($Commit -notmatch '^[a-fA-F0-9]{40}$') { throw "Ungueltiger Release-Commit: $Commit" }
$version = [string]((Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version)
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Ungueltige Paketversion: $version" }

$outputFull = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputFull | Out-Null
$staging = Join-Path $outputFull ('.staging-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $staging | Out-Null

$managedPaths = @(
  'src', 'public', 'bridge', 'scripts',
  'package.json', '.env.example', '.gitignore', 'README.md',
  'MEDICAL OFFICE SMS.cmd', 'SMSReminder starten.cmd', 'SMSReminderService.xml'
)

try {
  foreach ($directory in @('src', 'public', 'bridge', 'scripts')) {
    Copy-Item -LiteralPath (Join-Path $root $directory) -Destination (Join-Path $staging $directory) -Recurse -Force
  }
  foreach ($file in @('package.json', '.env.example', '.gitignore', 'README.md', 'MEDICAL OFFICE SMS.cmd', 'SMSReminder starten.cmd')) {
    Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $staging $file) -Force
  }
  Copy-Item -LiteralPath (Join-Path $root 'service\SMSReminderService.xml') -Destination (Join-Path $staging 'SMSReminderService.xml') -Force

  $stagingPrefix = $staging.TrimEnd('\') + '\'
  $files = @(Get-ChildItem -LiteralPath $staging -File -Recurse | Sort-Object FullName | ForEach-Object {
    [ordered]@{
      path = $_.FullName.Substring($stagingPrefix.Length).Replace('\', '/')
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  })
  $manifest = [ordered]@{
    schemaVersion = 1
    version = $version
    commit = $Commit
    managedPaths = $managedPaths
    files = $files
  }
  [IO.File]::WriteAllText(
    (Join-Path $staging 'release-manifest.json'),
    ($manifest | ConvertTo-Json -Depth 6),
    [Text.UTF8Encoding]::new($false)
  )

  $assetName = "SMSReminder-v$version.zip"
  $archivePath = Join-Path $outputFull $assetName
  if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
  $archive = [IO.Compression.ZipFile]::Open($archivePath, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in Get-ChildItem -LiteralPath $staging -File -Recurse | Sort-Object FullName) {
      $relative = $file.FullName.Substring($stagingPrefix.Length).Replace('\', '/')
      $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
      $entry.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
      $input = [IO.File]::OpenRead($file.FullName)
      $output = $entry.Open()
      try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
    }
  } finally {
    $archive.Dispose()
  }
  $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText("$archivePath.sha256", "$hash  $assetName`n", [Text.UTF8Encoding]::new($false))
  Write-Output $archivePath
} finally {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
