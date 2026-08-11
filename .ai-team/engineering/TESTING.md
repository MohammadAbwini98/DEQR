# DEQR Testing & Evidence Policy

## Testing Matrix

```text
Unit Tests (src/core/*, src/main/*, src/renderer/*)
├── Fountain coding LT transform block encoding & decoding
├── Protocol header parsing & frame capacity calculation
├── Zlib compression vs uncompressed payload selection
├── AES-256-GCM encryption & key derivation
└── SHA-256 binary verifier pass/fail scenarios

Integration & Protocol Golden Vectors
├── Byte-perfect reconstruction of synthetic binary fixtures (TXT, PDF, XLSX, ZIP, EXE)
├── Dropped frame recovery (reconstruction with 15% missing sequence frames)
├── Out-of-order frame decoding
└── Corrupted frame header rejection

Security & Sandbox Tests
├── Electron fuse verification
├── Content Security Policy restriction (denial of network protocols)
└── IPC preload bridge context isolation
```

## Evidence Requirements
No test check may be marked PASSED without pasting or referencing the raw command execution log in `.ai-team/reports/testing/`.

## WEB-IOS startup-remediation verification

Run these deterministic checks from the repository root with `npm.cmd`:

```powershell
npm.cmd test
npm.cmd run mobile-web:test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run mobile-web:build
npm.cmd run doctor
```

For process-level validation, first confirm that ports `5173` and `5174` have
no existing listeners, then run each mode from clean ports:

```powershell
.\scripts\run-local.cmd
.\scripts\run-local.cmd -Https
.\scripts\run-local.cmd -StartupDiagnostics
```

Each successful launcher run must confirm both expected desktop/PWA server
responses and emit exactly:

```text
DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available
```

After closing only the Electron instance created by that launcher, verify the
launcher has performed its child cleanup and that ports `5173` and `5174` are
no longer listening. `-StartupDiagnostics` may add redacted lifecycle
categories; it must not emit DOM contents, resource URLs, filenames, or payload
data.

The following remain **NOT EXECUTED** until separately evidenced; none is
implied by the checks above:

- Packaged ASAR and Electron-fuse verification (requires a freshly built
  unpacked/package artifact).
- Physical iPhone trusted-HTTPS reachability and CA trust.
- Installed-PWA and offline startup behavior.
- Physical camera permission, raw QR acquisition, export/save, SHA-256
  byte verification, and desktop-to-iPhone optical-transfer acceptance.

Passing the automated and local-launch checks is a remediation gate only. It
does not constitute packaged acceptance, physical-device acceptance, or release
approval.
