$ErrorActionPreference = 'Stop'

$desktopRoot = Split-Path -Parent $PSScriptRoot
$electronManifestPath = Join-Path $desktopRoot 'node_modules/electron/package.json'
$electronManifest = Get-Content -LiteralPath $electronManifestPath -Raw | ConvertFrom-Json
$electronVersion = [string]$electronManifest.version
if ($electronVersion -ne '43.4.0') {
  throw "Unsupported Electron version: $electronVersion; expected 43.4.0"
}

$electronRoot = Split-Path -Parent (Resolve-Path -LiteralPath $electronManifestPath).Path
$archiveName = "electron-v$electronVersion-win32-x64.zip"
$checksumsPath = Join-Path $electronRoot 'checksums.json'
$checksums = Get-Content -LiteralPath $checksumsPath -Raw | ConvertFrom-Json -AsHashtable
$expectedChecksum = [string]$checksums[$archiveName]
if ($expectedChecksum -notmatch '^[0-9a-f]{64}$') {
  throw "Electron checksum is missing for $archiveName"
}

$cacheRoot = Join-Path $env:RUNNER_TEMP 'dsh-electron'
$archivePath = Join-Path $cacheRoot $archiveName
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null

function Test-ArchiveChecksum {
  if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    return $false
  }
  $actualChecksum = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
  return [string]::Equals($actualChecksum, $expectedChecksum, [StringComparison]::OrdinalIgnoreCase)
}

if (-not (Test-ArchiveChecksum)) {
  Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
  gh release download "v$electronVersion" `
    --repo electron/electron `
    --pattern $archiveName `
    --output $archivePath
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to download the official Electron release asset: $archiveName"
  }
}
if (-not (Test-ArchiveChecksum)) {
  throw "Electron release asset checksum does not match checksums.json: $archiveName"
}

$distPath = Join-Path $electronRoot 'dist'
$temporaryDistPath = Join-Path $electronRoot ".dist-win32-x64-$PID"
Remove-Item -LiteralPath $temporaryDistPath -Recurse -Force -ErrorAction SilentlyContinue
try {
  Expand-Archive -LiteralPath $archivePath -DestinationPath $temporaryDistPath
  $temporaryExecutable = Join-Path $temporaryDistPath 'electron.exe'
  $temporaryVersionPath = Join-Path $temporaryDistPath 'version'
  if (-not (Test-Path -LiteralPath $temporaryExecutable -PathType Leaf)) {
    throw 'The verified Electron archive does not contain electron.exe'
  }
  $distVersion = (Get-Content -LiteralPath $temporaryVersionPath -Raw).Trim().TrimStart('v')
  if ($distVersion -ne $electronVersion) {
    throw "Electron archive version is $distVersion; expected $electronVersion"
  }

  if (Test-Path -LiteralPath $distPath) {
    $distItem = Get-Item -LiteralPath $distPath -Force
    if (($distItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to replace a linked Electron dist directory: $distPath"
    }
    Remove-Item -LiteralPath $distPath -Recurse -Force
  }
  Move-Item -LiteralPath $temporaryDistPath -Destination $distPath
  Set-Content -LiteralPath (Join-Path $electronRoot 'path.txt') -Value 'electron.exe' -NoNewline -Encoding utf8NoBOM

  $reportedVersion = (& (Join-Path $distPath 'electron.exe') --version | Out-String).Trim().TrimStart('v')
  if ($LASTEXITCODE -ne 0 -or $reportedVersion -ne $electronVersion) {
    throw "Provisioned electron.exe reported $reportedVersion; expected $electronVersion"
  }
} finally {
  Remove-Item -LiteralPath $temporaryDistPath -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output "Provisioned verified Electron v$electronVersion for win32-x64."
