<#
.SYNOPSIS
  Builds, verifies, and tracks DEQR release artifacts.

.DESCRIPTION
  Wraps `npm run dist` with the checks this project has learned the hard way:

  - `npm run package` passes `--dir` and refreshes only `release/win-unpacked`,
    so the portable `.exe` silently keeps whatever it was. That has shipped a
    stale artifact twice here, once carrying a crash that was already fixed.
    This script only ever calls `dist`.
  - A running `deqr.exe` locks `release/win-unpacked` and electron-builder dies
    with EBUSY, so any instance is stopped first.
  - An artifact nobody can tie to a commit is not a release, so the build
    refuses a dirty tree unless that is explicitly waived, and records the
    commit alongside the hashes.
  - Artifacts are opened afterwards rather than trusted: the packaged archive
    is checked for the receiver, the service worker, and the main-process
    lifecycle guards, so a build that quietly lost them cannot be published.

.PARAMETER Action
  build   Run the gates, build, verify, and write a manifest. Default.
  verify  Re-check the artifacts already in `release/` against their manifest.
  list    Show recorded releases, newest first.

.PARAMETER AllowDirty
  Build from an unclean tree. The manifest records it as untraceable.

.PARAMETER SkipGates
  Skip typecheck/tests/doctor/drift. For iterating only; the manifest records
  that the artifact is unvalidated.

.EXAMPLE
  npm run release
.EXAMPLE
  npm run release:verify
#>
[CmdletBinding()]
param(
  [ValidateSet('build', 'verify', 'list')]
  [string]$Action = 'build',
  [switch]$AllowDirty,
  [switch]$SkipGates
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $repoRoot 'release'
$manifestPath = Join-Path $releaseDir 'RELEASE-MANIFEST.json'
$historyPath = Join-Path $releaseDir 'RELEASE-HISTORY.jsonl'
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source

# The artifacts electron-builder is configured to emit, by `build.win.target`.
$artifactNames = @('deqr 0.1.0.exe', 'deqr Setup 0.1.0.exe')
$asarRelative = Join-Path 'win-unpacked' (Join-Path 'resources' 'app.asar')

function Write-Step { param([string]$Text) Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "    $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "    $Text" -ForegroundColor Yellow }

function Invoke-Npm {
  param([Parameter(Mandatory)][string[]]$Arguments, [Parameter(Mandatory)][string]$Label)

  Write-Host "    $Label" -ForegroundColor DarkGray
  & $npm @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

function Get-RepoState {
  Push-Location $repoRoot
  try {
    $commit = (& git rev-parse HEAD 2>$null)
    $short = (& git rev-parse --short HEAD 2>$null)
    $branch = (& git rev-parse --abbrev-ref HEAD 2>$null)
    $status = @(& git status --porcelain 2>$null)
    return [pscustomobject]@{
      Commit  = if ($commit) { $commit.Trim() } else { 'unknown' }
      Short   = if ($short) { $short.Trim() } else { 'unknown' }
      Branch  = if ($branch) { $branch.Trim() } else { 'unknown' }
      Dirty   = $status.Count -gt 0
      Changed = $status
    }
  } finally {
    Pop-Location
  }
}

function Stop-RunningApp {
  $running = @(Get-Process -Name deqr -ErrorAction SilentlyContinue)
  if ($running.Count -eq 0) {
    Write-Ok 'no running instance'
    return
  }

  # A live instance holds release/win-unpacked open and electron-builder fails
  # with EBUSY partway through, leaving a half-written output directory.
  Write-Warn "stopping $($running.Count) running deqr process(es)"
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 20 -and @(Get-Process -Name deqr -ErrorAction SilentlyContinue).Count -gt 0; $i++) {
    Start-Sleep -Milliseconds 500
  }
  if (@(Get-Process -Name deqr -ErrorAction SilentlyContinue).Count -gt 0) {
    throw 'A deqr process is still running and would lock release/win-unpacked.'
  }
  Write-Ok 'stopped'
}

function Get-ArtifactRecords {
  $records = @()
  foreach ($name in $artifactNames) {
    $path = Join-Path $releaseDir $name
    if (-not (Test-Path $path)) { throw "Expected artifact is missing: $name" }
    $item = Get-Item $path
    $records += [pscustomobject]@{
      Name   = $name
      Bytes  = $item.Length
      Sha256 = (Get-FileHash $path -Algorithm SHA256).Hash
    }
  }

  $asarPath = Join-Path $releaseDir $asarRelative
  if (Test-Path $asarPath) {
    $records += [pscustomobject]@{
      Name   = 'app.asar'
      Bytes  = (Get-Item $asarPath).Length
      Sha256 = (Get-FileHash $asarPath -Algorithm SHA256).Hash
    }
  }
  return $records
}

function Test-PackagedContents {
  # Opens the archive instead of trusting the build. Each check corresponds to
  # something that has actually gone missing or stale in this project before.
  $asarPath = Join-Path $releaseDir $asarRelative
  if (-not (Test-Path $asarPath)) { throw 'app.asar was not produced.' }

  $probe = Join-Path ([System.IO.Path]::GetTempPath()) ("deqr-release-probe-{0}.js" -f [guid]::NewGuid())
  $script = @'
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const repoRoot = process.argv[2];
const archive = process.argv[3];
const asar = createRequire(pathToFileURL(path.join(repoRoot, 'package.json')))('asar');
const read = (p) => asar.extractFile(archive, p).toString('utf8');
const files = asar.listPackage(archive).map((f) => f.replace(/\\/g, '/'));

const html = read(path.join('dist', 'pwa', 'index.html'));
const refs = [...html.matchAll(/assets\/[A-Za-z0-9_.-]+/g)].map((m) => m[0]);
const missing = refs.filter((ref) => !files.some((f) => f.endsWith(ref)));

const sw = read(path.join('dist', 'pwa', 'sw.js'));
const ipc = read(path.join('dist', 'main', 'ipc-handlers.js'));
const sessions = read(path.join('dist', 'main', 'session-manager.js'));

console.log(JSON.stringify({
  pwaShellRefs: refs,
  missingShellRefs: missing,
  serviceWorkerCache: (sw.match(/deqr-mobile-shell-v\d+/) || ['none'])[0],
  serviceWorkerNetworkFirst: sw.includes('documentStrategy'),
  rendererLivenessGuard: ipc.includes('isRendererAlive'),
  sessionDisposal: sessions.includes('disposeAll'),
}));
'@
  Set-Content -Path $probe -Value $script -Encoding utf8
  try {
    $json = & node $probe $repoRoot $asarPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the packaged archive.' }
  } finally {
    Remove-Item $probe -ErrorAction SilentlyContinue
  }

  $checks = $json | ConvertFrom-Json
  $failures = @()
  if ($checks.missingShellRefs.Count -gt 0) {
    $failures += "the packaged shell references assets that are not in the archive: $($checks.missingShellRefs -join ', ')"
  }
  if (-not $checks.serviceWorkerNetworkFirst) {
    $failures += 'the packaged service worker is not the network-first revision'
  }
  if (-not $checks.rendererLivenessGuard) {
    $failures += 'the main process is missing the renderer-liveness guard'
  }
  if (-not $checks.sessionDisposal) {
    $failures += 'the main process is missing session disposal on shutdown'
  }
  if ($failures.Count -gt 0) {
    throw "Packaged contents failed verification:`n  - " + ($failures -join "`n  - ")
  }

  Write-Ok "shell assets present ($($checks.pwaShellRefs.Count) referenced)"
  Write-Ok "service worker $($checks.serviceWorkerCache), network-first"
  Write-Ok 'main-process lifecycle guards present'
  return $checks
}

function Show-Manifest {
  param([Parameter(Mandatory)]$Manifest)

  Write-Host ''
  Write-Host "  commit    $($Manifest.commitShort) on $($Manifest.branch)$(if ($Manifest.dirty) { '  [DIRTY - not traceable]' })"
  Write-Host "  built     $($Manifest.builtAt)"
  Write-Host "  gates     $($Manifest.gates)"
  Write-Host ''
  foreach ($artifact in $Manifest.artifacts) {
    Write-Host ("  {0,-24} {1,14:N0} bytes" -f $artifact.name, $artifact.bytes)
    Write-Host ("      sha256 {0}" -f $artifact.sha256)
  }
  Write-Host ''
}

switch ($Action) {

  'list' {
    if (-not (Test-Path $historyPath)) {
      Write-Host 'No releases recorded yet.'
      break
    }
    $entries = Get-Content $historyPath | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json }
    foreach ($entry in ($entries | Sort-Object builtAt -Descending)) {
      $portable = $entry.artifacts | Where-Object { $_.name -like '*0.1.0.exe' -and $_.name -notlike '*Setup*' } | Select-Object -First 1
      Write-Host ("{0}  {1}  {2}{3}" -f $entry.builtAt, $entry.commitShort, $(if ($portable) { $portable.sha256.Substring(0, 16) + '...' } else { 'n/a' }), $(if ($entry.dirty) { '  [dirty]' } else { '' }))
    }
    break
  }

  'verify' {
    Write-Step 'Verifying the artifacts in release/'
    if (-not (Test-Path $manifestPath)) { throw "No manifest at $manifestPath. Build a release first." }
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

    $current = Get-ArtifactRecords
    $drifted = @()
    foreach ($recorded in $manifest.artifacts) {
      $actual = $current | Where-Object { $_.Name -eq $recorded.name } | Select-Object -First 1
      if (-not $actual) { $drifted += "$($recorded.name) is missing"; continue }
      if ($actual.Sha256 -ne $recorded.sha256) { $drifted += "$($recorded.name) no longer matches its recorded hash" }
    }
    if ($drifted.Count -gt 0) {
      throw "Artifacts have drifted from the manifest:`n  - " + ($drifted -join "`n  - ")
    }
    Write-Ok 'hashes match the manifest'

    Test-PackagedContents | Out-Null

    $state = Get-RepoState
    if ($state.Commit -ne $manifest.commit) {
      Write-Warn "built from $($manifest.commitShort); HEAD is now $($state.Short) - rebuild before publishing"
    } else {
      Write-Ok "matches HEAD ($($state.Short))"
    }
    Show-Manifest -Manifest $manifest
    break
  }

  'build' {
    Write-Step 'Checking the working tree'
    $state = Get-RepoState
    if ($state.Dirty -and -not $AllowDirty) {
      Write-Host ''
      $state.Changed | ForEach-Object { Write-Host "      $_" }
      throw 'The working tree is dirty. Commit first, or pass -AllowDirty to build an artifact nobody can trace to a commit.'
    }
    if ($state.Dirty) { Write-Warn 'building from a dirty tree; this artifact is not traceable' }
    Write-Ok "$($state.Short) on $($state.Branch)"

    Write-Step 'Releasing the output directory'
    Stop-RunningApp

    $gates = 'skipped'
    if ($SkipGates) {
      Write-Warn 'gates skipped; this artifact is unvalidated'
    } else {
      Write-Step 'Running the gates'
      Invoke-Npm -Arguments @('run', 'typecheck') -Label 'desktop typecheck'
      Invoke-Npm -Arguments @('run', 'mobile-web:typecheck') -Label 'pwa typecheck'
      Invoke-Npm -Arguments @('test') -Label 'desktop tests'
      Invoke-Npm -Arguments @('run', 'mobile-web:test') -Label 'pwa tests'
      Invoke-Npm -Arguments @('run', 'doctor') -Label 'doctor'
      Invoke-Npm -Arguments @('run', 'drift-check') -Label 'drift check'
      $gates = 'typecheck, tests, doctor, drift'
      Write-Ok 'all gates passed'
    }

    # `dist` and never `package`: package passes --dir and leaves the portable
    # exe untouched, which is how a stale artifact ships.
    Write-Step 'Building distributables (npm run dist)'
    Invoke-Npm -Arguments @('run', 'dist') -Label 'electron-builder'
    Write-Ok 'built'

    Write-Step 'Verifying packaged contents'
    Test-PackagedContents | Out-Null

    Write-Step 'Recording the manifest'
    $artifacts = Get-ArtifactRecords | ForEach-Object {
      [pscustomobject]@{ name = $_.Name; bytes = $_.Bytes; sha256 = $_.Sha256 }
    }
    $manifest = [pscustomobject]@{
      builtAt     = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
      commit      = $state.Commit
      commitShort = $state.Short
      branch      = $state.Branch
      dirty       = $state.Dirty
      gates       = $gates
      artifacts   = $artifacts
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding utf8
    Add-Content -Path $historyPath -Value ($manifest | ConvertTo-Json -Depth 6 -Compress) -Encoding utf8
    Write-Ok "manifest written to release/RELEASE-MANIFEST.json"

    Show-Manifest -Manifest $manifest
    Write-Host 'Paste these hashes into CURRENT-STATE.md and TASK-LOG.md when recording the release.' -ForegroundColor DarkGray
    break
  }
}
