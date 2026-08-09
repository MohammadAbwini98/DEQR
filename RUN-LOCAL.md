# DEQR local run commands

This runbook uses the active, isolated iOS/PWA worktree:

```powershell
cd D:\Projects\DEQR-ios2
```

Use `npm.cmd` in PowerShell on this workstation. Run the desktop sender and the
mobile PWA from this same worktree so both use the same DEQR v1 protocol code.

## One-command launcher

This starts the desktop renderer on port `5173`, the PWA on port `5174`, waits
for both servers, and opens Electron. It stops both servers when Electron exits.

```powershell
cd D:\Projects\DEQR-ios2
npm.cmd run run:local
```

This workstation blocks direct `.ps1` execution. To launch without npm, use
the policy-safe Windows wrapper instead:

```powershell
.\scripts\run-local.cmd
```

For a locally trusted HTTPS PWA, after completing the certificate setup below:

```powershell
npm.cmd run run:local -- -Https
```

The iPhone PWA address is `http://<YOUR-PC-LAN-IP>:5174/` or, with `-Https`,
`https://<YOUR-PC-LAN-IP>:5174/`. Use `ipconfig` to find the PC LAN address.
Choose a different PWA port with `-PwaPort 5175` if required.

## Electron desktop sender

Open **two** PowerShell windows.

First window â€” start the desktop renderer development server:

```powershell
cd D:\Projects\DEQR-ios2
npm.cmd run dev
```

Second window â€” start Electron after Vite reports that it is listening:

```powershell
cd D:\Projects\DEQR-ios2
npm.cmd start
```

Select a file in Electron, then press **Start transfer**. Keep the Electron
window visible while the iPhone scans its animated QR stream.

To stop either process, press `Ctrl+C` in its own window.

## iPhone web app / PWA

### Desktop-browser development

```powershell
cd D:\Projects\DEQR-ios2
npm.cmd run mobile-web:dev
```

Open the local URL Vite prints (normally `http://localhost:5173/`). This is
useful for UI work, but iPhone camera access needs HTTPS.

### iPhone camera testing on the local network

Create a locally trusted certificate once `mkcert` is installed and C: has free
space:

```powershell
cd D:\Projects\DEQR-ios2
New-Item -ItemType Directory -Force mobile-web\.certs
mkcert -install
mkcert -cert-file mobile-web\.certs\deqr-dev.pem -key-file mobile-web\.certs\deqr-dev-key.pem localhost 127.0.0.1 ::1 <YOUR-PC-LAN-IP>
```

Start the HTTPS server in the same PowerShell session:

```powershell
$env:DEQR_HTTPS_CERT = "$PWD\mobile-web\.certs\deqr-dev.pem"
$env:DEQR_HTTPS_KEY = "$PWD\mobile-web\.certs\deqr-dev-key.pem"
npm.cmd run mobile-web:dev:https
```

On the iPhone, browse to `https://<YOUR-PC-LAN-IP>:5173/`. Install the local
CA certificate/profile on the iPhone and enable it under **Settings > General
> About > Certificate Trust Settings** before accepting the browser warning.
Then use **Share > Add to Home Screen**, enable **Open as Web App**, and open
the new icon. Tap **Receive** to request camera permission.

`mobile-web/.certs/` is ignored by Git. Do not commit private certificate keys.

## Useful validation commands

```powershell
cd D:\Projects\DEQR-ios2
npm.cmd run mobile-web:test
npm.cmd run mobile-web:build
npm.cmd test
npm.cmd run doctor
```

The `mobile-web:dev` and Electron `dev` server both use port 5173. Do not run
them at the same time unless you deliberately change one port.
