# DEQR Mobile Web Receiver

This is the active iPhone receiver implementation. It is an installable PWA,
not an Electron renderer and not a replacement for the preserved MAUI history
under `mobile/`.

The receiver consumes raw `Uint8Array` QR payloads, validates the DEQR v1
frame/container contract, reconstructs the fountain stream, verifies SHA-256,
and only then enables a user-controlled Share/Download action.

## Commands

Run these from the repository root:

```powershell
npm.cmd run mobile-web:typecheck
npm.cmd run mobile-web:test
npm.cmd run mobile-web:build
npm.cmd run mobile-web:dev -- --host
```

## HTTPS device development

Camera and service-worker APIs require HTTPS on the iPhone. Use a trusted
certificate for a LAN hostname (for example, a locally managed development
certificate whose root certificate is installed and trusted on the iPhone).
Keep the certificate/key under `mobile-web/.certs/`; that directory is ignored.
Start Vite with `DEQR_HTTPS_CERT` and `DEQR_HTTPS_KEY` environment variables:

```powershell
$env:DEQR_HTTPS_CERT = "$PWD\mobile-web\.certs\deqr-dev.pem"
$env:DEQR_HTTPS_KEY = "$PWD\mobile-web\.certs\deqr-dev-key.pem"
npm.cmd run mobile-web:dev:https
```

Do not bypass certificate warnings.

The first connected launch registers the service worker and precaches the
locally bundled shell. After an online reload has completed, disconnecting the
network must not affect optical reception: no transfer operation makes a
network request.

## iPhone installation

Open the trusted HTTPS origin in Safari, then choose **Share > Add to Home
Screen**, enable **Open as Web App**, and add it. Physical Safari and installed
web-app validation remain separate acceptance gates.
