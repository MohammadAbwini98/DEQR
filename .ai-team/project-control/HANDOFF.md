# DEQR Session Handoff

## Current status

- **Date**: 2026-08-10
- **Active workstream**: WEB-IOS Safari PWA receiver (`mobile-web/`)
- **Local remediation gate**: CONDITIONAL PASS
- **Release / physical acceptance**: OPEN — no promotion authorized

### 2026-08-11 receiver address selection (corrected)

- **Prefer the Tailscale address, not the LAN address.** The first cut of the
  host ranked 192.168/10/172.16-31 above mesh-VPN addresses and regressed the
  established workflow, which used `https://100.95.40.3:5174/`.
- On this host the LAN default cannot work: the Ethernet adapter holding
  `192.168.100.41` is on the **Public** firewall profile with **no inbound rule
  for port 5174**, while the iPhone is already an enrolled tailnet node.
- HTTPS was never the problem. The certificate covers all addresses
  (`DNS:localhost, IP:127.0.0.1, IP:192.168.100.41, IP:100.95.40.3`) and the
  server binds every interface. The receiver was verified loading over
  `https://100.95.40.3:5174/`.
- The dashboard now shows every address with a Tailscale / Local network switch
  instead of silently guessing. Startup logs `preferred=overlay`.
- If someone deliberately chooses **Local network**, they must add an inbound
  Windows Firewall rule for port 5174 and keep the phone on that subnet.

### 2026-08-11 packaged iPhone receiver hosting

- The packaged desktop app now **publishes the iPhone receiver itself** over LAN
  HTTPS on port 5174 and shows the address on its dashboard as a scannable QR
  code and as text. Starting a Vite development server is no longer required to
  use a phone.
- The receiver builds to `dist/pwa` and ships inside `app.asar`. `npm run package`
  and `npm run dist` build it automatically; a contract test fails if that wiring
  is removed.
- The TLS certificate is generated on first run and stored under `userData`, then
  reused, so the iPhone only has to trust it once. `DEQR_HTTPS_CERT`/`DEQR_HTTPS_KEY`
  still override it.
- The server is read-only and confined: `GET`/`HEAD` only, containment enforced
  inside the served directory, and rejection of encoded traversal, encoded
  backslashes, drive-qualified paths, null bytes, and undecodable escapes.
- **`frame-ancestors 'none'` is now actually enforced** because the policy ships as
  a real response header. That closes the response-header half of
  `WEB-IOS-SEC-003` for the shipping path.
- **New exposure to keep in mind:** the packaged app now accepts inbound LAN
  connections. It serves only static application assets — no transferred payload
  passes through it — but Windows Firewall prompts on first run, and the network
  posture is now "no outbound external access plus one deliberate read-only
  inbound service", not "no sockets at all". Do not restate the older
  no-listener claim.
- Physical validation of installing and running the receiver from this hosted
  origin on an iPhone is **still open** under `WEB-IOS-10`.

### 2026-08-10 physical + packaged acceptance

- **Verdict: NOT ACCEPTED.** `DESKTOP-SEC-050` is **CONDITIONAL**; `WEB-IOS-10` is **BLOCKED**.
- **`WEB-IOS-10` was not executed at all.** No physical iPhone was available. Do not
  record any part of the physical matrix as passed, and do not treat the packaged smoke
  test, the Node proxy benchmark, or any local browser review as a substitute for it.
- **`DESKTOP-SEC-050` passed every criterion that does not need a device.** The package was
  built and hashed; all six required Electron fuses were read out of the built binary with
  `scripts/ci/inspect-packaged-fuses.js`; ASAR structure was verified with nothing
  unpacked; ASAR runtime integrity was proven by four targeted tamper cases, each rejected
  before readiness; the packaged renderer and preload load cleanly and exit clean; the
  packaged CSP carries no development allowance; network isolation, permission policy, and
  the preload boundary all hold. Only the packaged optical transfer to a real iPhone is
  missing.
- **One real defect was found and fixed.** `tests/main/permissions.test.ts` was validating a
  hand-copied duplicate of the Electron permission handlers, and that copy had diverged
  from the shipped parsed-URL policy — it trusted host-bearing `file://` URLs that
  production correctly rejects. Production was the stricter side, so nothing shipped was
  vulnerable, but the 11-point permission matrix was certifying code that is not shipped.
  `evaluateMediaPermission` now lives in `src/main/development-request-policy.ts` and both
  handlers plus the tests share it.
- **Regression after the fix**: desktop 19 files / 168 tests PASS; PWA 7 files / 25 tests
  PASS; both typechecks, both builds, `test:packaged`, doctor (0 warnings), drift,
  `git diff --check`, and the combined HTTPS launcher all PASS.
- **Sender FPS is unchanged at 10.** It stays an unvalidated hypothesis until measured on a
  device. Do not change it without physical evidence.
- Full evidence: `.ai-team/reports/testing/WEB-IOS-PHYSICAL-PACKAGED-ACCEPTANCE-REPORT.md`
  and the raw logs in `.ai-team/reports/testing/acceptance-evidence/`.

### 2026-08-10 UX/performance validation

- WEB-IOS-UXPERF-003 completed its bounded source implementation and local validation. The final verdict is **NOT ACCEPTED** because corrected physical-iPhone and packaged-runtime gates remain open.
- Desktop: 17 test files / 141 tests, typecheck, production build, doctor, drift check, diff check, and the actual combined launcher passed. The launcher emitted `DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available` and cleaned ports 5173/5174.
- PWA: 7 test files / 25 tests, typecheck, production build, deterministic serialized-frame QR fidelity, and a local 390x844 home/camera-recovery visual review passed. The test browser had no camera.
- The sender now serializes the complete v1 container before fountain encoding. PWA camera/worker work is bounded and backpressured; React metrics are coalesced; terminal verification is immediate and single-flight.
- PWA and Electron flows now have explicit actions and terminal states, meaningful focus, concise live announcements, inline camera recovery, high-contrast static scan surfaces, and restrained reduced-preference-aware motion.
- The existing SVG logo is unchanged; deterministic PNGs exist at 16/32/64/180/192/512 pixels.
- Full evidence and the 5 KiB-1 MiB proxy matrix are in `.ai-team/reports/testing/WEB-IOS-UXPERF-003-FINAL-REPORT.md`.

## Product direction

ADR-008 is the active mobile decision. The preserved `mobile/` .NET MAUI
sources and ADR-007 are historical/reference material only. Do not restart,
extend, or require a Mac/Xcode path for current WEB-IOS work.

The desktop sender and PWA share the DEQR v1 raw-byte protocol contract, but
their local development origins are intentionally separate:

- Electron renderer: `http://localhost:5173/` (exact loopback development exception)
- PWA: port `5174`, HTTP for desktop-browser UI work and trusted HTTPS over a
  certificate-SAN-covered LAN host for physical iPhone work

## Completed in this remediation

- Reproduced the white Electron client area with the exact launcher command.
  The root cause was a shared Vite optimizer cache: the PWA server replaced the
  desktop cache metadata, leaving Electron's static `buffer` dependency at a
  `504 Outdated Optimize Dep` URL before React could evaluate.
- Isolated the desktop and PWA Vite caches; retained the browser Buffer
  optimization; moved Buffer loading into a guarded renderer bootstrap; added a
  visible bootstrap failure path and React error boundary.
- Hardened the launcher with response/content readiness, Buffer dependency
  readiness, renderer-ready verification, process-tree cleanup, port collision
  rejection, PIDs/URLs/log paths, and certificate-SAN-aware HTTPS advertising.
- Kept Electron on loopback HTTP. No global certificate bypass, insecure-content
  setting, disabled web security, or TLS validation override was introduced.
- Replaced prefix-based Electron request allowlisting with parsed exact URL
  policy; added redacted lifecycle markers and actual-policy tests.
- Added PWA bounded streaming gzip output, blocked received-file extensions,
  restrictive local-only CSP, and explicit camera retry/return-home recovery.
- Applied matching desktop receive extension enforcement, container-size limit,
  and in-memory session release on terminal paths.

## Independent evidence

- Desktop suite: **14 files / 131 tests PASS**
- PWA suite: **3 files / 16 tests PASS**
- Type checks, desktop build, PWA build, and doctor (**0 warnings**) PASS
- Three clean launcher runs PASS: HTTP, HTTPS, and `-StartupDiagnostics`.
  Each emitted `DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER
  preload=available` and left ports 5173/5174 closed after the test window
  exited.
- Detailed QA evidence: `.ai-team/reports/testing/WEB-IOS-STARTUP-REMEDIATION-QA-REPORT.md`
- Security review: `.ai-team/reports/security/WEB-IOS-STARTUP-SECURITY-REVIEW.md`
- Architecture topology: `.ai-team/engineering/ARCHITECTURE.md`

## Open gates and risks — do not relabel as passed

1. Physical iPhone: trusted CA installation, firewall/reachability, camera
   permission/retry, installed standalone PWA, offline shell, export, VoiceOver,
   the appearance/accessibility matrix, sustained/thermal behavior, lifecycle and
   session isolation, and the corrected desktop-to-iPhone optical transfer with
   byte/hash comparison are **NOT EXECUTED**. No device was available.
2. Packaged optical transfer from the packaged sender to a physical iPhone is
   **NOT EXECUTED**. This is the only remaining `DESKTOP-SEC-050` criterion.
   Packaging, fuses, ASAR structure, and ASAR integrity are now **verified**
   against the artifact itself and no longer open.
3. `WEB-IOS-SEC-003` and `WEB-IOS-DATA-004` are classified **accepted documented
   residual risk**, not closed. The PWA still delivers CSP via `<meta>`, where
   `frame-ancestors` is ignored per spec — an HTTP response header is required
   before any real deployment. Failed PWA sessions retain receiver blocks in
   memory until reset or the next capture; session isolation still holds because
   `requestCamera` resets first, and nothing is written to disk.
4. Optical payloads remain unencrypted by the accepted M1 decision. Do not
   claim confidentiality.
5. The ASAR ships third-party development residue pulled in transitively by
   `qrcode` (a `pngjs` HTML coverage report, lint/prettier dotfiles, one vendor
   source map, the `qrcode` CLI and its `yargs` chain). No DEQR-private material
   and no secrets — hygiene and bloat only.
6. ASAR integrity is validated lazily on read, plus a header hash. Bytes inside
   files that are never loaded are not checked at launch. Expected Electron
   behavior; state it accurately rather than claiming whole-file verification.

## Safe next task

A physical iPhone is the only blocker for both open gates.

Use the updated launcher from a clean environment:

```powershell
cd D:\Projects\DEQR-ios2
.\scripts\run-local.cmd -Https
```

The launcher refuses to start if ports 5173/5174 are already held; stop stale
Vite servers first. Only use an HTTPS URL the launcher advertises. On the
physical iPhone, install and trust the issuing CA, then record
Safari/installed-PWA/manual evidence without exposing file contents or
certificate keys.

Deterministic fixtures are already staged — regenerate or verify with:

```powershell
node scripts/ci/generate-acceptance-fixtures.js
```

They land in `.local-run/acceptance-fixtures/` with a `MANIFEST.txt` of exact
sizes and SHA-256 digests to compare received files against. Also repeat the
5 KiB / 100 KiB / 1 MiB subset against the packaged portable artifact
`release/deqr 0.1.0.exe` to close `DESKTOP-SEC-050`.

Do not commit or push the current remediation unless the product owner
separately authorizes it.
