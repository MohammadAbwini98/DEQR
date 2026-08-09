[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$PwaPort = 5174,
  [switch]$Https
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$npmCommand = Get-Command npm.cmd -ErrorAction Stop
$desktopPort = 5173
$logsDirectory = Join-Path $repoRoot '.local-run'

function Test-TcpPort {
  param([int]$Port)

  # Vite can bind to either IPv4 or IPv6 loopback. Check both so a listener on
  # ::1 is not mistaken for an available port when this launcher probes 127.0.0.1.
  foreach ($address in @([System.Net.IPAddress]::Loopback, [System.Net.IPAddress]::IPv6Loopback)) {
    $client = [System.Net.Sockets.TcpClient]::new($address.AddressFamily)
    try {
      # A local synchronous connect either succeeds immediately or fails quickly.
      # This avoids the unreliable Task.Wait result that prevented the original
      # launcher from observing Vite after it had started.
      $client.Connect($address, $Port)
      return $true
    } catch {
      continue
    } finally {
      $client.Dispose()
    }
  }

  return $false
}

function Get-PortListenerDetails {
  param([int]$Port)

  $listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  $details = foreach ($listener in $listeners) {
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    $name = if ($null -eq $process) { 'unknown process' } else { $process.ProcessName }
    "$($listener.LocalAddress):$Port (PID $($listener.OwningProcess), $name)"
  }

  return $details -join '; '
}

function Assert-PortAvailable {
  param(
    [int]$Port,
    [string]$Purpose
  )

  if (Test-TcpPort -Port $Port) {
    $details = Get-PortListenerDetails -Port $Port
    $suffix = if ([string]::IsNullOrWhiteSpace($details)) { '' } else { " Listener: $details." }
    throw "Port $Port is already in use. Stop the existing $Purpose before running this launcher.$suffix"
  }
}

function Get-LanIPv4Addresses {
  return @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*'
      } |
      Select-Object -ExpandProperty IPAddress -Unique)
}

function Invoke-NpmScript {
  param(
    [string]$ScriptName,
    [string]$Description
  )

  Write-Host "Preparing $Description ..."
  & $npmCommand.Source run $ScriptName
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE. Electron was not started."
  }
}

function Build-ElectronDevelopmentEntries {
  $mainEntry = Join-Path $repoRoot 'dist\main\index.js'
  $preloadEntry = Join-Path $repoRoot 'dist\preload\index.js'

  Invoke-NpmScript -ScriptName 'build:main' -Description 'Electron main-process entry'
  Invoke-NpmScript -ScriptName 'build:preload' -Description 'Electron preload entry'

  foreach ($entry in @($mainEntry, $preloadEntry)) {
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
      throw "Expected Electron entry was not generated: $entry"
    }
  }

  Write-Host "Electron entries are ready:"
  Write-Host "  Main:    $mainEntry"
  Write-Host "  Preload: $preloadEntry"
}

function Write-LauncherSummary {
  param([string]$Scheme)

  Write-Host ''
  Write-Host 'DEQR local development launcher'
  Write-Host "Repository: $repoRoot"
  Write-Host "Desktop renderer (Electron only): http://localhost:$desktopPort/"
  Write-Host "PWA local address:               $Scheme`://localhost:$PwaPort/"
  Write-Host "PWA bind address:                $Scheme`://0.0.0.0:$PwaPort/"

  $lanAddresses = Get-LanIPv4Addresses
  if ($lanAddresses.Count -eq 0) {
    Write-Warning "No non-loopback IPv4 address was detected. Connect to a LAN before testing on an iPhone."
  } else {
    foreach ($address in $lanAddresses) {
      Write-Host "PWA iPhone address:              $Scheme`://$address`:$PwaPort/"
    }
  }

  if ($Scheme -eq 'http') {
    Write-Warning 'HTTP is suitable for desktop-browser UI work only. iPhone camera, service worker, and installation require trusted HTTPS.'
  } else {
    Write-Host 'HTTPS certificate and key were found under mobile-web\.certs\.'
  }

  Write-Host "Server logs: $logsDirectory"
  Write-Host ''
}

function Start-DevServer {
  param(
    [string]$Name,
    [string]$Command,
    [int]$Port
  )

  $stdoutLog = Join-Path $logsDirectory "$Name.stdout.log"
  $stderrLog = Join-Path $logsDirectory "$Name.stderr.log"
  Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue

  $process = Start-Process -FilePath $env:ComSpec -WorkingDirectory $repoRoot -PassThru `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog `
    -ArgumentList @('/d', '/c', $Command)

  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
      if ($process.HasExited) {
        $output = (Get-Content -Raw -LiteralPath $stdoutLog -ErrorAction SilentlyContinue) +
          (Get-Content -Raw -LiteralPath $stderrLog -ErrorAction SilentlyContinue)
        throw "$Name stopped before it became ready. Output:`n$output"
      }

      if (Test-TcpPort -Port $Port) {
        Write-Host "$Name is ready on port $Port."
        return $process
      }

      Start-Sleep -Milliseconds 250
    }

    throw "$Name did not become ready on localhost:$Port within 30 seconds. See $logsDirectory for its output."
  } catch {
    Stop-ProcessTree -Process $process
    throw
  }
}

function Start-Electron {
  $stdoutLog = Join-Path $logsDirectory 'electron.stdout.log'
  $stderrLog = Join-Path $logsDirectory 'electron.stderr.log'
  Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue

  $process = Start-Process -FilePath $env:ComSpec -WorkingDirectory $repoRoot -PassThru `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog `
    -ArgumentList @('/d', '/c', 'npm.cmd run start')

  Start-Sleep -Milliseconds 750
  if ($process.HasExited) {
    $output = (Get-Content -Raw -LiteralPath $stdoutLog -ErrorAction SilentlyContinue) +
      (Get-Content -Raw -LiteralPath $stderrLog -ErrorAction SilentlyContinue)
    throw "Electron stopped immediately after launch. Output:`n$output"
  }

  Write-Host 'CURRENT STATUS: RUNNING'
  Write-Host "  Electron launcher: http://localhost:$desktopPort/ (launcher PID $($process.Id))"
  Write-Host "  Desktop listener: $(Get-PortListenerDetails -Port $desktopPort)"
  Write-Host "  PWA listener:     $(Get-PortListenerDetails -Port $PwaPort)"
  Write-Host "  Electron logs:    $stdoutLog"
  Write-Host "  Electron errors:  $stderrLog"
  Write-Host 'Close the Electron window to stop both Vite servers.'

  return $process
}

function Stop-ProcessTree {
  param([System.Diagnostics.Process]$Process)

  if ($null -eq $Process -or $Process.HasExited) {
    return
  }

  & $env:ComSpec /d /c "taskkill /pid $($Process.Id) /t /f >nul 2>&1"
}

Assert-PortAvailable -Port $desktopPort -Purpose 'Vite/Electron development server'
Assert-PortAvailable -Port $PwaPort -Purpose 'PWA development server'

if ($Https) {
  $certificate = Join-Path $repoRoot 'mobile-web\.certs\deqr-dev.pem'
  $privateKey = Join-Path $repoRoot 'mobile-web\.certs\deqr-dev-key.pem'
  if (-not (Test-Path -LiteralPath $certificate) -or -not (Test-Path -LiteralPath $privateKey)) {
    throw 'HTTPS was requested, but the local mkcert certificate/key files were not found. See RUN-LOCAL.md for certificate setup.'
  }
  $env:DEQR_HTTPS_CERT = $certificate
  $env:DEQR_HTTPS_KEY = $privateKey
}

$desktopVite = $null
$pwaVite = $null
$electron = $null
New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null

try {
  $scheme = if ($Https) { 'https' } else { 'http' }
  Write-LauncherSummary -Scheme $scheme
  Build-ElectronDevelopmentEntries

  Write-Host "Starting desktop renderer on http://localhost:$desktopPort ..."
  $desktopVite = Start-DevServer -Name 'desktop-vite' -Command 'npm.cmd run dev -- --port 5173 --strictPort' -Port $desktopPort

  Write-Host "Starting PWA on $scheme`://0.0.0.0:$PwaPort ..."
  $pwaVite = Start-DevServer -Name 'pwa-vite' -Command "npm.cmd run mobile-web:dev -- --port $PwaPort --strictPort" -Port $PwaPort

  Write-Host ''
  Write-Host "Electron sender is starting at http://localhost:$desktopPort/."
  Write-Host "PWA is available at $scheme`://localhost:$PwaPort/ and the listed iPhone address(es)."
  $electron = Start-Electron
  Wait-Process -Id $electron.Id
} finally {
  Stop-ProcessTree -Process $pwaVite
  Stop-ProcessTree -Process $desktopVite
}
