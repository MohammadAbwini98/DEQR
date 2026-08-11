# DEQR local development launcher

> **The packaged desktop app no longer needs this launcher.** The receiver is
> built into the application, so launching DEQR publishes the iPhone receiver
> over LAN HTTPS automatically and shows a scannable QR code on the dashboard.
> See [Packaged iPhone receiver](#packaged-iphone-receiver). This launcher stays
> the tool for working on PWA source with fast rebuilds.

Run the desktop sender and the active `mobile-web/` PWA from the same worktree
so they use the same DEQR v1 protocol code. The preserved `mobile/` MAUI
sources are not started by this workflow.

## Packaged iPhone receiver

The built application serves `dist/pwa` over HTTPS on port `5174` and advertises
`https://<host-ip>:5174/` on its dashboard as both a QR code and plain text.

### Which address it advertises

The certificate covers every detected address, and the server binds all
interfaces, so any of them works over HTTPS. The dashboard picks a default and
lets you switch:

| Kind | Example | When it works |
| --- | --- | --- |
| **Tailscale** (100.64.0.0/10) | `https://100.95.40.3:5174/` | Whenever the iPhone is signed in to the same tailnet, on any network. Does not need an inbound Windows Firewall rule for the physical adapter. **Preferred default.** |
| **Local network** | `https://192.168.100.41:5174/` | Only when the iPhone is on this same subnet *and* Windows Firewall allows inbound on port 5174. An adapter on the **Public** profile blocks this by default. |

Mesh-VPN addresses are preferred because an ordinary LAN address silently fails
in the common case where the wired/Wi-Fi adapter sits on the Public firewall
profile. Use the **Local network** button on the dashboard if you want the LAN
address instead; if you do, add an inbound firewall rule for port 5174.

- The TLS certificate is generated on first run and stored under the app's
  `userData` directory, so the iPhone only has to trust it once. It is reused
  until it nears expiry or the machine's LAN address changes.
- Set `DEQR_HTTPS_CERT` and `DEQR_HTTPS_KEY` to supply your own certificate.
- Windows Firewall prompts the first time the app binds the LAN interface. Allow
  it on private networks, or the phone cannot reach the receiver.
- Only `GET` and `HEAD` are served, strictly from the packaged receiver
  directory. Every response carries the receiver's CSP as a real header, which
  is the only way `frame-ancestors` is actually enforced.
- If publication fails, the desktop sender still starts and the dashboard
  reports that the receiver is unavailable.

The PWA build output moved to `dist/pwa` so electron-builder's existing
`dist/**/*` rule ships it; `npm run package` and `npm run dist` build it
automatically.

```powershell
cd D:\Projects\DEQR-ios2
```

Use `npm.cmd` from PowerShell on this workstation.

## One-command startup

```powershell
npm.cmd run run:local
```

Direct PowerShell script execution can be disabled by workstation policy. The
same policy-safe wrapper is available when npm is not convenient:

```powershell
.\scripts\run-local.cmd
```

The launcher builds the Electron main and preload entries, starts both Vite
servers with strict ports, verifies their expected HTML/module/dependency
responses, then opens Electron. It waits for this main-process marker before
declaring success:

```text
DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available
```

Closing Electron stops the child Vite processes. If startup fails, the launcher
stops its own child process trees and prints the relevant log tail.

## Ports and protocol boundary

| Component | Address | Purpose |
| --- | --- | --- |
| Electron renderer | `http://localhost:5173/` | Desktop development only. Electron allows only exact loopback HTTP/WebSocket requests on this port. |
| PWA default | `http://localhost:5174/` | Desktop-browser PWA UI development only. |
| PWA with `-Https` | `https://<certificate-SAN-host>:5174/` | Required for physical iPhone camera, installability, and service-worker acceptance. |

The PWA port must differ from `5173`. Change it explicitly if necessary:

```powershell
npm.cmd run run:local -- -PwaPort 5175
```

The command window reports the actual launcher, Electron, and listener PIDs;
the desktop/PWA URLs; and stdout/stderr log paths under `.local-run/`. HTTP
launches clear inherited `DEQR_HTTPS_CERT` and `DEQR_HTTPS_KEY` values so a
previous HTTPS session cannot silently alter the PWA server.

## HTTPS for an iPhone

The PWA server does not use Electron's development URL. It binds on the LAN
only to make the PWA reachable from a phone; Electron remains loopback HTTP.
Create a certificate with SANs for every hostname/IP address that will be used.
For example, with `mkcert`:

```powershell
New-Item -ItemType Directory -Force mobile-web\.certs
mkcert -install
mkcert -cert-file mobile-web\.certs\deqr-dev.pem -key-file mobile-web\.certs\deqr-dev-key.pem localhost 127.0.0.1 ::1 <YOUR-PC-LAN-IP>
```

Then start the trusted-HTTPS test path:

```powershell
npm.cmd run run:local -- -Https
```

The launcher uses `certutil` to read the certificate Subject Alternative Names
and advertises only `localhost` and LAN IP URLs covered by those SANs. It does
not advertise `0.0.0.0` as a browser URL. It can verify SAN coverage locally,
but it cannot prove that an iPhone trusts the issuing CA, can reach the PC
through the firewall, or will grant camera permission. Install the issuing CA
on the iPhone and enable full trust in **Settings > General > About >
Certificate Trust Settings** before recording physical acceptance evidence.

Certificate and key files are ignored by Git. Never commit private keys.

## Diagnostic launch and failure triage

Normal startup emits only concise lifecycle markers. To add redacted renderer
startup signals (without logging DOM, resource URLs, or selected filenames):

```powershell
npm.cmd run run:local -- -StartupDiagnostics
```

For a failed run, review the exact paths printed by the launcher, normally:

```text
.local-run\desktop-vite.stdout.log
.local-run\desktop-vite.stderr.log
.local-run\pwa-vite.stdout.log
.local-run\pwa-vite.stderr.log
.local-run\electron.stdout.log
.local-run\electron.stderr.log
```

If Electron does not produce `DEQR_RENDERER_READY`, the launcher exits with
the Electron log tail. `DEQR_RENDERER_LOAD_FAILED`,
`DEQR_RENDERER_PRELOAD_FAILED`, `DEQR_RENDERER_PROCESS_GONE`, and
`DEQR_RENDERER_NOT_READY` identify the lifecycle stage without printing page
contents or filesystem paths. Resolve the recorded failure; do not bypass TLS,
disable Electron isolation, or weaken the network policy as a workaround.

## Separate manual startup

Use the one-command launcher for repeatable readiness checks. For focused
desktop troubleshooting only, build the Electron entries first and then use
two PowerShell windows:

```powershell
# Window 1
npm.cmd run build:main
npm.cmd run build:preload
npm.cmd run dev -- --port 5173 --strictPort
```

```powershell
# Window 2, after the desktop Vite server is ready
npm.cmd start
```

For a standalone PWA browser session, choose a port that is not occupied by
the desktop server:

```powershell
npm.cmd run mobile-web:dev -- --port 5174 --strictPort
```

For HTTPS, use the launcher so certificate SAN verification, environment
handling, and PWA readiness checks remain consistent.

## Validation commands

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run mobile-web:test
npm.cmd run mobile-web:build
npm.cmd run doctor
```
