[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)]
  [int]$PwaPort = 5174,
  [switch]$Https,
  [switch]$StartupDiagnostics
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$npmCommand = Get-Command npm.cmd -ErrorAction Stop
$desktopPort = 5173
$logsDirectory = Join-Path $repoRoot '.local-run'
$desktopUrl = "http://localhost:$desktopPort/"
$pwaScheme = if ($Https) { 'https' } else { 'http' }
$originalHttpsCertificate = $env:DEQR_HTTPS_CERT
$originalHttpsKey = $env:DEQR_HTTPS_KEY
$originalStartupDiagnostics = $env:DEQR_STARTUP_DIAGNOSTICS

function Test-TcpPort {
  param([int]$Port)

  # Vite can bind to IPv4 or IPv6 loopback. Probe both so an ::1 listener is
  # never mistaken for an available port.
  foreach ($address in @([System.Net.IPAddress]::Loopback, [System.Net.IPAddress]::IPv6Loopback)) {
    $client = [System.Net.Sockets.TcpClient]::new($address.AddressFamily)
    try {
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

  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  $details = foreach ($listener in $listeners) {
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    $name = if ($null -eq $process) { 'unknown' } else { $process.ProcessName }
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

function Get-ProcessTree {
  param([int]$RootProcessId)

  $pending = [System.Collections.Generic.Queue[int]]::new()
  $seen = [System.Collections.Generic.HashSet[int]]::new()
  $pending.Enqueue($RootProcessId)
  $null = $seen.Add($RootProcessId)
  $processes = @()

  while ($pending.Count -gt 0) {
    $parentProcessId = $pending.Dequeue()
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentProcessId" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
      $childProcessId = [int]$child.ProcessId
      if ($seen.Add($childProcessId)) {
        $processes += [pscustomobject]@{
          Id = $childProcessId
          ParentId = $parentProcessId
          Name = $child.Name
        }
        $pending.Enqueue($childProcessId)
      }
    }
  }

  return $processes
}

function Get-ProcessDetails {
  param([System.Diagnostics.Process]$Launcher)

  if ($null -eq $Launcher) {
    return 'not started'
  }

  $descendants = @(Get-ProcessTree -RootProcessId $Launcher.Id)
  $electronProcesses = @($descendants | Where-Object { $_.Name -ieq 'electron.exe' })
  if ($electronProcesses.Count -gt 0) {
    return ($electronProcesses | ForEach-Object { "PID $($_.Id) ($($_.Name))" }) -join '; '
  }

  return "launcher PID $($Launcher.Id); Electron child not yet observed"
}

function Get-LogTail {
  param(
    [string[]]$Paths,
    [int]$LineCount = 40
  )

  $lines = foreach ($path in $Paths) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      "--- $path ---"
      Get-Content -LiteralPath $path -Tail $LineCount -ErrorAction SilentlyContinue
    }
  }

  return $lines -join [Environment]::NewLine
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

  Write-Host 'Electron entries: ready'
  Write-Host "  Main:    $mainEntry"
  Write-Host "  Preload: $preloadEntry"
}

function Get-ExpectedResponseContent {
  param(
    [uri]$Uri,
    [string]$Description
  )

  try {
    $response = Invoke-WebRequest -Uri $Uri.AbsoluteUri -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
  } catch {
    throw "$Description is not serving its expected HTTP(S) response: $($_.Exception.Message)"
  }

  if ($response.StatusCode -ne 200) {
    throw "$Description returned HTTP $($response.StatusCode), expected HTTP 200."
  }

  return [string]$response.Content
}

function Assert-ResponseContains {
  param(
    [string]$Content,
    [string]$Pattern,
    [string]$Description
  )

  if ($Content -notmatch $Pattern) {
    throw "$Description did not contain its expected DEQR entry marker."
  }
}

function Assert-DesktopServerReady {
  param([string]$Scheme, [int]$Port, [string]$HostName = 'localhost')

  $baseUrl = "$Scheme`://$HostName`:$Port"
  $root = Get-ExpectedResponseContent -Uri ([uri]"$baseUrl/") -Description 'Desktop Vite root'
  Assert-ResponseContains -Content $root -Pattern 'id="root"' -Description 'Desktop Vite root'
  Assert-ResponseContains -Content $root -Pattern 'src="\./index\.tsx"' -Description 'Desktop Vite root'

  $entry = Get-ExpectedResponseContent -Uri ([uri]"$baseUrl/index.tsx") -Description 'Desktop renderer entry'
  Assert-ResponseContains -Content $entry -Pattern 'buffer' -Description 'Desktop renderer entry'

  $dependencyMatch = [regex]::Match(
    $entry,
    '["''](?<path>/(?:@fs/|node_modules/)[^"'']*buffer\.js\?[^"'']+)["'']'
  )
  if (-not $dependencyMatch.Success) {
    throw 'Desktop renderer entry did not expose the optimized Buffer dependency URL.'
  }

  $dependency = Get-ExpectedResponseContent -Uri ([uri]"$baseUrl$($dependencyMatch.Groups['path'].Value)") -Description 'Desktop Buffer dependency'
  Assert-ResponseContains -Content $dependency -Pattern 'Buffer' -Description 'Desktop Buffer dependency'
}

function Assert-PwaServerReady {
  param([string]$Scheme, [int]$Port, [string]$HostName = 'localhost')

  $baseUrl = "$Scheme`://$HostName`:$Port"
  $root = Get-ExpectedResponseContent -Uri ([uri]"$baseUrl/") -Description 'PWA root'
  Assert-ResponseContains -Content $root -Pattern 'id="root"' -Description 'PWA root'
  Assert-ResponseContains -Content $root -Pattern 'DEQR Receive' -Description 'PWA root'

  $entry = Get-ExpectedResponseContent -Uri ([uri]"$baseUrl/src/main.tsx") -Description 'PWA entry'
  Assert-ResponseContains -Content $entry -Pattern 'createRoot' -Description 'PWA entry'
  Assert-ResponseContains -Content $entry -Pattern 'serviceWorker' -Description 'PWA entry'

  $worker = Get-ExpectedResponseContent -Uri ([uri]"$baseUrl/sw.js") -Description 'PWA service worker'
  Assert-ResponseContains -Content $worker -Pattern 'PRECACHE_URLS' -Description 'PWA service worker'
}

function Start-DevServer {
  param(
    [string]$Name,
    [string]$Command,
    [string]$Scheme,
    [int]$Port,
    [string]$ReadinessHost,
    [scriptblock]$ReadinessCheck
  )

  $stdoutLog = Join-Path $logsDirectory "$Name.stdout.log"
  $stderrLog = Join-Path $logsDirectory "$Name.stderr.log"
  Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue

  $process = Start-Process -FilePath $env:ComSpec -WorkingDirectory $repoRoot -PassThru `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog `
    -ArgumentList @('/d', '/c', $Command)

  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $lastReadinessError = $null
    while ([DateTime]::UtcNow -lt $deadline) {
      if ($process.HasExited) {
        $tail = Get-LogTail -Paths @($stdoutLog, $stderrLog)
        throw "$Name stopped before it became ready. Log tail:`n$tail"
      }

      if (Test-TcpPort -Port $Port) {
        try {
          & $ReadinessCheck $Scheme $Port $ReadinessHost
          Write-Host "$Name is ready: expected entry and dependency responses confirmed on $Scheme`://$ReadinessHost`:$Port/."
          return $process
        } catch {
          $lastReadinessError = $_
        }
      }

      Start-Sleep -Milliseconds 250
    }

    $tail = Get-LogTail -Paths @($stdoutLog, $stderrLog)
    $reason = if ($null -eq $lastReadinessError) { 'no TCP listener became available' } else { $lastReadinessError.Exception.Message }
    throw "$Name did not become ready within 45 seconds: $reason`nLog tail:`n$tail"
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

  try {
    $readyMarker = 'DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available'
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    while ([DateTime]::UtcNow -lt $deadline) {
      if ($process.HasExited) {
        $tail = Get-LogTail -Paths @($stdoutLog, $stderrLog)
        throw "Electron stopped before the renderer became ready. Log tail:`n$tail"
      }

      $output = (Get-Content -Raw -LiteralPath $stdoutLog -ErrorAction SilentlyContinue) +
        (Get-Content -Raw -LiteralPath $stderrLog -ErrorAction SilentlyContinue)
      if ($output -match [regex]::Escape($readyMarker)) {
        Write-Host 'CURRENT STATUS: RUNNING'
        Write-Host "  Electron main:      $(Get-ProcessDetails -Launcher $process)"
        Write-Host "  Electron launcher:  PID $($process.Id)"
        Write-Host "  Desktop URL:        $desktopUrl"
        Write-Host "  Desktop listener:   $(Get-PortListenerDetails -Port $desktopPort)"
        Write-Host "  PWA listener:       $(Get-PortListenerDetails -Port $PwaPort)"
        Write-Host "  Electron stdout:    $stdoutLog"
        Write-Host "  Electron stderr:    $stderrLog"
        return $process
      }

      Start-Sleep -Milliseconds 250
    }

    $tail = Get-LogTail -Paths @($stdoutLog, $stderrLog)
    throw "Electron did not emit the renderer-ready marker within 25 seconds. Log tail:`n$tail"
  } catch {
    Stop-ProcessTree -Process $process
    throw
  }
}

function Stop-ProcessTree {
  param([System.Diagnostics.Process]$Process)

  if ($null -eq $Process) {
    return
  }

  # taskkill /t reaches descendants even when the cmd/npm parent has already
  # exited. It is restricted to the explicit launcher PID created above.
  # Use cmd's local stderr handling so an already-exited launcher is idempotent
  # and cannot prevent cleanup of the remaining child launchers in finally.
  & $env:ComSpec /d /c "taskkill /pid $($Process.Id) /t /f >nul 2>&1"
}

function Get-CertificateSubjectAlternativeNames {
  param([string]$CertificatePath)

  $certutil = Get-Command certutil.exe -ErrorAction Stop
  $certificateDump = @(& $certutil.Source -dump $CertificatePath 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw 'Unable to inspect the HTTPS certificate Subject Alternative Names with certutil.'
  }

  $subjectAlternativeNames = foreach ($line in $certificateDump) {
    $match = [regex]::Match([string]$line, '^\s*(?:DNS Name|IP Address)=(?<name>.+?)\s*$')
    if ($match.Success) {
      $match.Groups['name'].Value.Trim()
    }
  }

  $uniqueNames = @($subjectAlternativeNames | Sort-Object -Unique)
  if ($uniqueNames.Count -eq 0) {
    throw 'The HTTPS certificate has no readable DNS/IP Subject Alternative Names. Generate it with localhost and the intended LAN IP address.'
  }

  return $uniqueNames
}

function Test-CertificateSubjectAlternativeName {
  param(
    [string]$HostName,
    [string[]]$SubjectAlternativeNames
  )

  return @($SubjectAlternativeNames | Where-Object { $_.Equals($HostName, [System.StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
}

function Get-HttpsReadinessHost {
  param([string[]]$CertificateSubjectAlternativeNames)

  if (Test-CertificateSubjectAlternativeName -HostName 'localhost' -SubjectAlternativeNames $CertificateSubjectAlternativeNames) {
    return 'localhost'
  }

  foreach ($address in Get-LanIPv4Addresses) {
    if (Test-CertificateSubjectAlternativeName -HostName $address -SubjectAlternativeNames $CertificateSubjectAlternativeNames) {
      return $address
    }
  }

  throw 'The HTTPS certificate covers neither localhost nor a detected LAN IPv4 address, so the launcher cannot perform a certificate-valid PWA readiness check.'
}

function Write-LauncherSummary {
  param(
    [string]$Scheme,
    [string[]]$CertificateSubjectAlternativeNames
  )

  Write-Host ''
  Write-Host 'DEQR local development launcher'
  Write-Host "Repository: $repoRoot"
  Write-Host "Desktop sender: $desktopUrl (loopback HTTP only; port $desktopPort)"
  Write-Host "PWA listener:  $Scheme on 0.0.0.0:$PwaPort"
  Write-Host "Server logs:   $logsDirectory"

  $lanAddresses = Get-LanIPv4Addresses
  if ($Scheme -eq 'https') {
    Write-Host "Certificate SANs: $($CertificateSubjectAlternativeNames -join ', ')"
    if (Test-CertificateSubjectAlternativeName -HostName 'localhost' -SubjectAlternativeNames $CertificateSubjectAlternativeNames) {
      Write-Host "PWA local URL: https://localhost:$PwaPort/"
    } else {
      Write-Warning 'The certificate does not cover localhost; no localhost HTTPS URL is advertised.'
    }

    $advertisedLanAddress = $false
    foreach ($address in $lanAddresses) {
      if (Test-CertificateSubjectAlternativeName -HostName $address -SubjectAlternativeNames $CertificateSubjectAlternativeNames) {
        Write-Host "PWA iPhone URL: https://$address`:$PwaPort/"
        $advertisedLanAddress = $true
      }
    }

    if (-not $advertisedLanAddress) {
      Write-Warning 'No detected LAN IPv4 address is covered by this certificate; no iPhone HTTPS URL is advertised.'
    }
    Write-Warning 'Certificate SAN coverage is verified locally. This launcher cannot verify that an iPhone trusts the issuing CA or can reach this PC.'
  } else {
    Write-Host "PWA local URL: http://localhost:$PwaPort/"
    if ($lanAddresses.Count -eq 0) {
      Write-Warning 'No non-loopback IPv4 address was detected. Connect to a LAN before testing on an iPhone.'
    } else {
      foreach ($address in $lanAddresses) {
        Write-Host "PWA LAN URL: http://$address`:$PwaPort/"
      }
    }
    Write-Warning 'HTTP is suitable for desktop-browser UI work only. iPhone camera, service worker, and installation require a trusted HTTPS origin.'
  }

  Write-Host ''
}

if ($PwaPort -eq $desktopPort) {
  throw "PwaPort $PwaPort collides with the fixed desktop Vite port $desktopPort. Choose a different PWA port, for example -PwaPort 5174."
}

Assert-PortAvailable -Port $desktopPort -Purpose 'desktop Vite/Electron development server'
Assert-PortAvailable -Port $PwaPort -Purpose 'PWA development server'

$certificateSubjectAlternativeNames = @()
$pwaReadinessHost = 'localhost'
if ($Https) {
  $certificate = Join-Path $repoRoot 'mobile-web\.certs\deqr-dev.pem'
  $privateKey = Join-Path $repoRoot 'mobile-web\.certs\deqr-dev-key.pem'
  if (-not (Test-Path -LiteralPath $certificate -PathType Leaf) -or -not (Test-Path -LiteralPath $privateKey -PathType Leaf)) {
    throw 'HTTPS was requested, but the local certificate/key files were not found. See RUN-LOCAL.md for certificate setup.'
  }

  $certificateSubjectAlternativeNames = Get-CertificateSubjectAlternativeNames -CertificatePath $certificate
  $pwaReadinessHost = Get-HttpsReadinessHost -CertificateSubjectAlternativeNames $certificateSubjectAlternativeNames
  $env:DEQR_HTTPS_CERT = $certificate
  $env:DEQR_HTTPS_KEY = $privateKey
} else {
  # Prevent inherited HTTPS configuration from silently changing an HTTP run.
  Remove-Item Env:DEQR_HTTPS_CERT -ErrorAction SilentlyContinue
  Remove-Item Env:DEQR_HTTPS_KEY -ErrorAction SilentlyContinue
}

if ($StartupDiagnostics) {
  $env:DEQR_STARTUP_DIAGNOSTICS = '1'
} else {
  Remove-Item Env:DEQR_STARTUP_DIAGNOSTICS -ErrorAction SilentlyContinue
}

$desktopVite = $null
$pwaVite = $null
$electron = $null
New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null

try {
  Write-LauncherSummary -Scheme $pwaScheme -CertificateSubjectAlternativeNames $certificateSubjectAlternativeNames
  Build-ElectronDevelopmentEntries

  Write-Host "Starting desktop renderer on $desktopUrl ..."
  $desktopVite = Start-DevServer -Name 'desktop-vite' -Command 'npm.cmd run dev -- --port 5173 --strictPort' -Scheme 'http' -Port $desktopPort -ReadinessHost 'localhost' -ReadinessCheck ${function:Assert-DesktopServerReady}

  Write-Host "Starting PWA on $pwaScheme`://0.0.0.0:$PwaPort ..."
  $pwaVite = Start-DevServer -Name 'pwa-vite' -Command "npm.cmd run mobile-web:dev -- --port $PwaPort --strictPort" -Scheme $pwaScheme -Port $PwaPort -ReadinessHost $pwaReadinessHost -ReadinessCheck ${function:Assert-PwaServerReady}

  Write-Host ''
  Write-Host "Electron sender is starting at $desktopUrl."
  $electron = Start-Electron
  Wait-Process -Id $electron.Id
} finally {
  Stop-ProcessTree -Process $electron
  Stop-ProcessTree -Process $pwaVite
  Stop-ProcessTree -Process $desktopVite

  if ($null -eq $originalHttpsCertificate) {
    Remove-Item Env:DEQR_HTTPS_CERT -ErrorAction SilentlyContinue
  } else {
    $env:DEQR_HTTPS_CERT = $originalHttpsCertificate
  }
  if ($null -eq $originalHttpsKey) {
    Remove-Item Env:DEQR_HTTPS_KEY -ErrorAction SilentlyContinue
  } else {
    $env:DEQR_HTTPS_KEY = $originalHttpsKey
  }
  if ($null -eq $originalStartupDiagnostics) {
    Remove-Item Env:DEQR_STARTUP_DIAGNOSTICS -ErrorAction SilentlyContinue
  } else {
    $env:DEQR_STARTUP_DIAGNOSTICS = $originalStartupDiagnostics
  }
}
