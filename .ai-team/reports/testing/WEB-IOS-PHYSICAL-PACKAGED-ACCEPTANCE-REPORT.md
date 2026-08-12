# WEB-IOS Physical + Packaged Acceptance Report

**Date:** 2026-08-10
**Worktree:** `D:\Projects\DEQR-ios2` (git worktree of `D:\Projects\DEQR`)
**Branch / HEAD:** `codex/ios2-shell` / `be2816d99220218214dcb0d9731f2452a6cc3f43`
**Verdict:** **NOT ACCEPTED**

---

## 1. Executive Summary

Gate B (`DESKTOP-SEC-050`, packaged Electron security/runtime) was executed in full
except for its one device-dependent criterion. Gate A (`WEB-IOS-10`, physical iPhone
acceptance) was **not executed at all**: no physical iPhone was available to this
session. Every criterion in Gate A requires a real device, camera, and optical path.

Because §47 forbids downgrading an unexecuted gate to a "limitation", the verdict
remains **NOT ACCEPTED**.

What was actually established this session:

- A real Windows package was produced (NSIS + portable + unpacked) and hashed.
- All six required Electron fuses were read **directly out of the built binary**, not
  inferred from `package.json`. All six match policy.
- ASAR integrity is **enforced at runtime**, proven by four targeted tamper tests that
  were each rejected before the renderer became ready.
- The packaged renderer reaches full readiness (dashboard + preload bridge) and exits
  cleanly; the portable artifact was proven ready via a controlled experiment.
- Packaged CSP is genuinely strict and carries no development allowances.
- No external network dependency exists in the packaged renderer.
- **One real defect was found and fixed**: the Electron permission-policy test was
  validating a hand-copied duplicate of the handler logic that had diverged from the
  shipped code (see §16).
- Deterministic 5 KiB–1 MiB fixtures were generated so Gate A is turnkey once a device
  is available.

---

## 2. Tested Source Identity

| Item | Value |
| --- | --- |
| Worktree | `D:\Projects\DEQR-ios2` |
| Branch | `codex/ios2-shell` |
| HEAD | `be2816d99220218214dcb0d9731f2452a6cc3f43` |
| Commit created | None — no commit, no push, no reset, no checkout |

### Evidence fingerprint (§39)

The tested tree is dirty and uncommitted. Two immutable fingerprints were captured.

| Snapshot | Artifact | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Before this session's source change | `acceptance-evidence/03-worktree.patch` | 270,396 | `46C16542839E01D9F58645FF9543A8FF96757725C137051D1EF9E9DD4A7A0235` |
| After this session's source change | `acceptance-evidence/92-final-worktree.patch` | 282,058 | `DE66BC062C072A6A0F9935E992A7F23DB0770CD8702F19D2D603B461246B365C` |

| Companion record | SHA-256 |
| --- | --- |
| `91-final-status.txt` (`git status --porcelain=v1`) | `6F7625BC354E4172CFBDA0B33C00BFF81C7DCA34384D67A23B0A77DB2044A9CB` |
| `93-untracked-manifest.txt` (per-file hashes of untracked sources) | `F6E9867CBADB6029C90441AE26BC092FEE62C12A0D05F57E355DCB2748D89A42` |

`git diff --binary` does not capture untracked files, so `93-untracked-manifest.txt`
records a SHA-256 per untracked file. Together the three records pin the exact tested
bytes without creating a commit.

### Source changed by this session

| File | Change |
| --- | --- |
| `src/main/development-request-policy.ts` | Added `isTrustedRendererOrigin` and `evaluateMediaPermission` (single shared permission decision) |
| `src/main/index.ts` | Both Electron permission handlers now delegate to `evaluateMediaPermission` |
| `tests/main/permissions.test.ts` | Rewritten to exercise the production function instead of a divergent local copy |
| `scripts/ci/inspect-packaged-fuses.js` | New — reads the fuse wire out of a built executable |
| `scripts/ci/generate-acceptance-fixtures.js` | New — deterministic acceptance fixtures |

No protocol bytes, IPC contracts, sender FPS, ROI dimensions, or CSP strings were changed.

---

## 3. Physical Device Environment

**NOT EXECUTED — no physical iPhone available to this session.**

Nothing in §7 (model, iOS version, Safari version, network topology, CA trust, firewall
reachability, Safari reachability, Home Screen installability) could be established.
No values are inferred or estimated.

One prerequisite *was* observed from the host side: the launcher advertised the PWA at
`https://100.95.40.3:5174/` with certificate SAN `100.95.40.3`. The launcher explicitly
warned that it cannot verify that an iPhone trusts the issuing CA or can reach this host,
and that the certificate does not cover `localhost`. That is a host-side observation only,
not a device gate.

---

## 4. Trusted HTTPS / PWA Installation

**NOT EXECUTED.** Requires a physical device (§42 items 1–3).

---

## 5. Camera Permission and Recovery

**NOT EXECUTED on device.** Requires a physical device and camera (§10).

Source-level policy was verified independently and is reported in §16.

---

## 6. Physical Optical Transfer Matrix

**NOT EXECUTED.**

The required table is reproduced with every cell unexecuted. It is deliberately **not**
populated with proxy numbers; §41 forbids mixing Node proxy values with physical results.

| Size | FPS | Runs | Success | Mean Time | P95 Time | Useful KiB/s | Unique frames/s | Duplicates | Hash |
| ---: | --: | ---: | ------: | --------: | -------: | -----------: | --------------: | ---------: | ---- |
| 5 KiB | — | 0 | — | — | — | — | — | — | NOT EXECUTED |
| 25 KiB | — | 0 | — | — | — | — | — | — | NOT EXECUTED |
| 100 KiB | — | 0 | — | — | — | — | — | — | NOT EXECUTED |
| 500 KiB | — | 0 | — | — | — | — | — | — | NOT EXECUTED |
| 1 MiB | — | 0 | — | — | — | — | — | — | NOT EXECUTED |

### Fixtures prepared (§12, §13)

Deterministic, non-sensitive fixtures were generated so the matrix can be run without
further preparation. `scripts/ci/generate-acceptance-fixtures.js` is seeded and was
verified byte-identical across two consecutive runs.

Output: `.local-run/acceptance-fixtures/` (+ `MANIFEST.txt`).

| Fixture | Bytes | SHA-256 |
| --- | ---: | --- |
| `deqr-fixture-5KiB.bin` | 5,120 | `54d9ab36f14c5c39c5b05e2b3da2215871643dee6c92cd87f00443122674f036` |
| `deqr-fixture-25KiB.bin` | 25,600 | `beb0bb1cc68ed4112540564da7be8537e8f9048842fd35ce8fbb561a510ed21c` |
| `deqr-fixture-100KiB.bin` | 102,400 | `366e6649897c762f61b8cdecc8e40d1bcea3d241e16cd9b644f96ef44ce18b66` |
| `deqr-fixture-500KiB.bin` | 512,000 | `6fa8d6a54d195d51d64107a465c85de3bb0013840266b7241da7cd607da6ce25` |
| `deqr-fixture-1MiB.bin` | 1,048,576 | `1040c907399b8dde54111a10198be6a6aae23f83687d9c6351efc2f3c49080a0` |

Representative-extension fixtures (25 KiB each, identical byte class, extension only):
`.bin` `.txt` `.pdf` `.xlsx` `.docx` `.zip` `.log` — digests in `MANIFEST.txt`.

---

## 7. Sender FPS Calibration

**NOT EXECUTED.** The 6/8/10/12/15 FPS sweep requires on-device useful-decode
measurement.

Per §49 the sender default remains **10 FPS, unchanged**. It stays an unvalidated
conservative hypothesis, not a device-derived optimum.

---

## 8. Sustained Camera / Thermal / Memory Results

**NOT EXECUTED.** Requires a physical device (§19).

---

## 9. Lifecycle and Session Isolation

**NOT EXECUTED on device** (§20, §21).

One relevant source behavior was read while assessing `WEB-IOS-DATA-004`: `requestCamera`
in `mobile-web/src/App.tsx` calls `receiver.current.reset()` before every new session, so
a subsequent transfer cannot inherit a previous session's blocks. That is a source
reading, **not** a substitute for the physical interrupt-A-then-run-B test.

---

## 10. Export / Files Validation

**NOT EXECUTED.** Requires a physical device (§22).

Blocked-extension policy (§23) has automated coverage — `tests/main/receive-handler.test.ts`
rejects a blocked extension before prompting or writing — but the on-device Share/Files
workflow was not exercised.

---

## 11. VoiceOver and Accessibility Matrix

**NOT EXECUTED.** VoiceOver, Dynamic Type, Reduce Motion, Reduce Transparency, Increase
Contrast, light/dark, orientation, safe areas, and installed-icon/splash review (§24–§26)
all require the device. The prior local 390×844 browser review explicitly does not satisfy
this gate.

---

## 12. PWA Offline / Standalone Validation

**NOT EXECUTED on device** (§8, §9).

**Update — the development-only distribution posture has been removed.** The packaged
desktop app now builds in the receiver and serves it itself over LAN HTTPS; no Vite or
Node development server is involved. See §21.

Offline *shell* caching and *optical transfer* remain distinct concerns, and neither was
validated on a device.

---

## 13. Packaged Electron Artifact

**EXECUTED — PASS.**

Command: `npm run dist` (`npm run build && electron-builder`), exit code 0.
Targets built: `nsis`, `portable`, plus `win-unpacked`. Electron 36.9.5, x64.

Final artifacts (after the §16 source fix; these supersede the first build):

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `release/deqr 0.1.0.exe` (portable) | 84,230,670 | `80D4202254FD83B74814BD3076ACEB0BAA9A66911A9AFAD78DBCEFBC8142B66A` |
| `release/deqr Setup 0.1.0.exe` (NSIS) | 84,397,647 | `9C10F2EDCE464B62305BAF7210E7726F5AB2875DF66EBC815E28F6D20CCA1DAA` |
| `release/win-unpacked/deqr.exe` | 202,690,560 | `FCC88E748B8B599884EE8D8E3B69BCDC8C2A07E8AD6259024AF00D7E40980C45` |
| `release/win-unpacked/resources/app.asar` | 2,128,604 | `F0ADAC534F489BDE379DCCC8493F67A3732FB917D5F9033D6B516C2EE5B59280` |

The artifact is **not** promoted or published. Build log: `acceptance-evidence/50-repackage-build.log`.

### Packaged runtime smoke test (§28) — PASS

`release/win-unpacked/deqr.exe` with `DEQR_PACKAGED_ACCEPTANCE_AUTOCLOSE=1`:

```
DEQR_RENDERER_LOAD_FINISHED source=packaged-file
DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available
DEQR_PACKAGED_ACCEPTANCE_COMPLETE readiness=ready exit=clean
```

Exited on its own in 4.08 s. No blank renderer, no `DEQR_RENDERER_LOAD_FAILED`, no
`PRELOAD_FAILED`, no `PROCESS_GONE`, no `NOT_READY`, and zero
`DEQR_NETWORK_REQUEST_BLOCKED` warnings.

Benign Chromium `disk_cache`/`gpu_disk_cache` stderr warnings appear; they are unrelated
to DEQR and do not affect readiness.

### Portable artifact readiness — PASS (by controlled experiment)

The portable target's launcher stub does not forward its child's stdout, so no marker is
directly observable. Readiness was established by controlled comparison instead:

| Run | `DEQR_PACKAGED_ACCEPTANCE_AUTOCLOSE` | Result |
| --- | --- | --- |
| Portable | `1` | Self-exited after 6.80 s |
| Portable | unset | Still running at 30 s (4 `deqr` + 1 stub process), had to be terminated |

`app.quit()` is reachable **only** inside the `readiness.dashboard && readiness.preloadBridge`
success branch of `waitForRendererReady`. A failed probe would log `NOT_READY` after its
15 s deadline and leave the window open — exactly the control behavior. The portable
build therefore reached full dashboard + preload readiness.

---

## 14. Electron Fuse Results

**EXECUTED — PASS.** Read directly from the built executable with
`@electron/fuses`'s `getCurrentFuseWire` via `scripts/ci/inspect-packaged-fuses.js`.
Values are artifact evidence, not a restatement of `package.json`.

Fuse wire version 1, artifact `release/win-unpacked/deqr.exe`:

| Fuse | State | Required | Verdict |
| --- | --- | --- | --- |
| `RunAsNode` | DISABLE | DISABLE | PASS |
| `EnableCookieEncryption` | ENABLE | ENABLE | PASS |
| `EnableNodeOptionsEnvironmentVariable` | DISABLE | DISABLE | PASS |
| `EnableNodeCliInspectArguments` | DISABLE | DISABLE | PASS |
| `EnableEmbeddedAsarIntegrityValidation` | ENABLE | ENABLE | PASS |
| `OnlyLoadAppFromAsar` | ENABLE | ENABLE | PASS |
| `LoadBrowserProcessSpecificV8Snapshot` | DISABLE | not required | informational |
| `GrantFileProtocolExtraPrivileges` | ENABLE | not required | informational (see §19) |

Evidence: `acceptance-evidence/52-final-fuses.txt`.

---

## 15. ASAR and Integrity Results

**EXECUTED — PASS.**

### Structure

- `resources/app.asar` exists (2,128,604 bytes).
- All application code is inside the archive: `dist/main`, `dist/preload`, `dist/renderer`,
  `dist/core`, `dist/shared`, plus `package.json`.
- `resources/app.asar.unpacked` is **absent** — nothing was unintentionally left
  outside the archive.
- `npm run test:packaged` PASS (required entries present, relative `./assets/` paths,
  correct `main` entry).
- No DEQR source maps, no DEQR test material, no fixtures, and no project-control content
  are present in the archive.

### Integrity enforcement — independently verified

The header carries per-file SHA-256 integrity metadata. Enforcement was proven by
tampering a copy of the packaged app (the shipped artifact was never modified) and
confirming each case was rejected **before** renderer readiness:

| Tampered target | Result | Runtime signal |
| --- | --- | --- |
| `dist/main/index.js` | REJECTED (170 ms) | `ASAR Integrity Violation: got a hash mismatch` |
| `dist/renderer/index.html` | REJECTED (1,218 ms) | `FATAL asar_file_validator.cc: Failed to validate block` |
| `dist/preload/index.js` | REJECTED (2,477 ms) | `ASAR Integrity Violation: got a hash mismatch` |
| ASAR header (offset 200) | REJECTED (178 ms) | `FATAL asar_util.cc: Integrity check failed for asar archive` |

`DEQR_RENDERER_READY` was absent in all four. Restoring the pristine archive restored the
original digest and a clean boot. The test was repeated against the **final** artifact
after the §16 fix and again rejected the tampered main process.

**Nuance worth recording:** an initial tamper at an arbitrary mid-file offset booted
normally. That offset fell inside vendored data never read at runtime (`pngjs` coverage
report / `yargs` locales). Electron validates file blocks lazily **on read**, so bytes in
never-loaded files are not validated at startup. The archive *header* is hash-checked, so
structure and file digests cannot be altered undetected. This is expected Electron
behavior, not a DEQR defect, but it means "ASAR integrity" should be understood as
"validated on read + header-verified", not "whole-file verified at launch".

### Package hygiene finding (non-blocking)

The archive ships third-party development residue pulled in transitively by `qrcode`:

- `node_modules/pngjs/coverage/lcov-report/**` — a full HTML coverage report (~30 files)
- `node_modules/pngjs/.eslintrc.json`, `.eslintignore`, `.prettierignore`
- `node_modules/get-caller-file/index.js.map` — one third-party source map
- `node_modules/qrcode/bin/qrcode` + `yargs`/`cliui`/`y18n` CLI dependencies, unused by the app

No DEQR-private material and no secrets. Classification: **accepted documented residual**
(bloat and hygiene, not a security boundary). A `files`/`asarUnpack` filter would remove it.

---

## 16. CSP / Network / Permission Results

### Packaged CSP (§31) — PASS

Applied when `app.isPackaged` is true:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none';
media-src 'self' blob:; worker-src 'self' blob:; object-src 'none';
base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none';
manifest-src 'self'
```

- No `'unsafe-eval'` anywhere.
- `script-src 'self'` with **no** `'unsafe-inline'`. Confirmed compatible: the packaged
  `index.html` extracted from the ASAR contains no inline `<script>`, only an external
  module and stylesheet with relative `./assets/` paths.
- The development CSP (which does carry `'unsafe-inline'` for scripts and
  `ws://localhost:5173`) is selected only when `app.isPackaged` is false. No development
  allowance reaches the package.
- `webSecurity: true`, `allowRunningInsecureContent: false`, `nodeIntegration: false`,
  `contextIsolation: true`, `sandbox: true`. No global TLS bypass and no
  `certificate-error` override exists in the main process.

Residual: `style-src 'unsafe-inline'` remains, required by Vite/React inline styles.
Risk is limited to style injection, and with `script-src 'self'`, `object-src 'none'`, and
`connect-src 'none'` there is no script-execution or exfiltration path. Classification:
**accepted documented residual risk**.

### Runtime network isolation (§32) — PASS, with a deliberate inbound listener

**Posture change:** the packaged app now binds an inbound LAN HTTPS listener on port
5174 to publish the iPhone receiver (§21). Outbound isolation is unchanged and the
renderer's boundary is unchanged; the findings below still hold. What is new is that the
application accepts connections, so "network isolation" now means *no outbound external
access, plus one deliberate read-only inbound service*, not "no sockets at all".

- `isAllowedRendererRequest` is fail-closed when packaged: only `file:` (empty hostname),
  `data:`, and `devtools:` are permitted; the loopback development origin is added **only**
  when `!isPackaged`.
- Static scan of every packaged `.js`/`.html`/`.css` found four URL-shaped strings:
  `http://localhost` (the gated development constant), `http://www.w3.org` (XML namespace),
  `https://feross.org` (buffer package attribution), `https://react.dev` (React error link).
  None is a fetch target.
- Zero matches for CDN, font, analytics, telemetry, Sentry, jsdelivr, unpkg, or cloudflare tokens.
- The packaged smoke run logged **zero** `DEQR_NETWORK_REQUEST_BLOCKED` warnings, i.e. the
  renderer never attempted a request outside the allowlist.
- Navigation is denied via `will-navigate` `preventDefault()`; popups denied via
  `setWindowOpenHandler → { action: 'deny' }`.

### Permission policy (§33) — DEFECT FOUND AND FIXED

`tests/main/permissions.test.ts` did not test the shipped handlers. It re-declared their
logic inside the test file, and that copy had drifted after production moved from
prefix matching to parsed-URL policy. Reproduced divergence:

| URL | Test's copy | Production | |
| --- | --- | --- | --- |
| `file:///C:/app/index.html` | trusted | trusted | agree |
| `file://evil.com/C:/app/index.html` | **trusted** | **rejected** | **diverges** |
| `file://attacker.example/payload.html` | **trusted** | **rejected** | **diverges** |
| `http://localhost:5173/` | trusted | trusted | agree |
| `http://localhost:5174/` | rejected | rejected | agree |
| `http://user:pass@localhost:5173/` | rejected | rejected | agree |

Production was the **stricter** of the two, so no shipped vulnerability existed. The
defect is one of test validity: the 11-point permission matrix was certifying code that
is not shipped, and would not have caught a real regression.

Smallest correct remediation applied (§40):

1. Added `evaluateMediaPermission()` to `src/main/development-request-policy.ts` as the
   single deny-by-default decision (media only, main frame only, trusted frame URL, and —
   for the check handler — trusted requesting origin, video without audio).
2. Both `setPermissionRequestHandler` and `setPermissionCheckHandler` in
   `src/main/index.ts` now delegate to it, so policy and tests cannot drift again.
3. Rewrote `tests/main/permissions.test.ts` to import the production function, retaining
   every original case and adding the host-bearing `file://` cases, credentialed origins,
   null/unparseable frame URLs, and the packaged `file://` requesting origin.

Behavior preserved: `file://` and `file:///` both parse to an empty hostname and remain
trusted, so packaged camera permission is unaffected. Verified before changing the code.

Packaged verification: `evaluateMediaPermission` is present in `dist/main/index.js` inside
the final `app.asar`.

**Still open:** an actual on-device camera grant/deny/recover cycle in the packaged app
(§33 runtime, §10) was not executed — that needs a camera and a user gesture.

### Preload / renderer boundary (§34) — PASS

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
- `src/preload/index.ts` exposes exactly one frozen namespace via
  `contextBridge.exposeInMainWorld('deqr', api)`.
- No general-purpose `ipcRenderer` is exposed; no arbitrary filesystem bridge. Channels
  are a fixed set (`windowControls:*`, `files:*`, `transfer:*`, `loopback:*`,
  `receive:saveReceivedFile`).
- Packaged runtime confirmed `preload=available` with no `PRELOAD_FAILED`.

Minor residual: `transfer.subscribe`/`loopback.subscribe` build channel names from a
renderer-supplied numeric `sessionId` (`transfer:frame:${sessionId}`). These are
listen-only within the renderer's own process and expose no new capability, but the
session id is not validated at the bridge. Classification: **accepted documented residual**.

---

## 17. Packaged Optical Transfer Results

**NOT EXECUTED** (§35).

The packaged Electron sender was never pointed at a physical iPhone, so the required
5 KiB / 100 KiB / 1 MiB packaged subset is entirely open. This is a mandatory
`DESKTOP-SEC-050` criterion and is the single reason Gate B cannot be recorded as a
full PASS.

---

## 18. Regression Test Results

All commands run in `D:\Projects\DEQR-ios2` after the §16 source change.

| Gate | Command | Result |
| --- | --- | --- |
| Desktop tests | `npm.cmd test` | **PASS — 19 files / 168 tests** |
| PWA tests | `npm.cmd run mobile-web:test` | **PASS — 7 files / 25 tests** |
| Desktop typecheck | `npm.cmd run typecheck` | PASS |
| PWA typecheck | `npm.cmd run mobile-web:typecheck` | PASS |
| Desktop build | `npm.cmd run build` (via `dist`) | PASS — 100 modules transformed |
| PWA build | `npm.cmd run mobile-web:build` | PASS |
| Packaged ASAR verify | `npm.cmd run test:packaged` | PASS |
| AI doctor | `npm.cmd run doctor` | PASS — 0 warnings |
| Adapter drift | `npm.cmd run drift-check` | PASS — zero drift |
| Whitespace | `git diff --check` | PASS |
| Combined launcher | `.\scripts\run-local.cmd -Https` | PASS |

Desktop test count moved 158 → 168 because the rewritten permission suite adds 10 real
cases against production code. The previously reported "17 files / 141 tests" figure
predates the untracked test files now present in this worktree.

### Combined launcher detail

First invocation **correctly refused to start**: port 5173 was held by a stale Vite server
(PID 2092) left over from a launcher run at 21:04, before this session. This demonstrates
the launcher's port-collision guard working as designed, and also shows the earlier run's
cleanup did not complete. With product-owner approval the stale listeners on 5173/5174
were stopped and the launcher was re-run.

Second invocation PASS:

- Desktop sender ready on `http://localhost:5173/`
- PWA ready on `https://100.95.40.3:5174/` (certificate SAN `100.95.40.3`)
- Electron emitted `DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available`
- On shutdown the launcher's cleanup left **0** listeners on 5173/5174 and **0** Electron
  processes; launcher exit code 0

The launcher warned that the certificate does not cover `localhost` and that it cannot
verify iPhone CA trust or reachability.

---

## 21. Packaged iPhone Receiver Hosting (added after initial acceptance)

**EXECUTED — PASS on the host side. Device validation still open.**

The desktop app now publishes the iPhone receiver itself, removing the requirement for a
Vite development server. This changes the distribution posture recorded in §12 and the
network posture recorded in §16.

### Implementation

| Component | Purpose |
| --- | --- |
| `src/main/lan-addresses.ts` | Selects advertisable IPv4 addresses; excludes loopback and 169.254/16, and ranks ordinary LAN ranges above overlay ranges such as 100.64/10 |
| `src/main/pwa-certificate.ts` | Resolves TLS material: `DEQR_HTTPS_CERT`/`DEQR_HTTPS_KEY`, else a stored certificate that still covers the current addresses, else a generated one persisted to `userData` |
| `src/main/pwa-host.ts` | Read-only static HTTPS server for the packaged receiver |
| `src/renderer/components/PwaHostCard.tsx` | Dashboard card showing the LAN URL as a scannable QR code and as text |

The PWA now builds to `dist/pwa`, covered by the existing `dist/**/*` packaging rule, and
`npm run package` / `npm run dist` build it automatically.

### Verified behavior

Live probe against the **packaged** application, serving from inside `app.asar`:

| Request | Result |
| --- | --- |
| `GET /` | 200, serves the receiver shell (`id="root"` present) |
| `GET /manifest.webmanifest` | 200, `application/manifest+json` |
| `GET /sw.js` | 200, `text/javascript` |
| `GET /icons/deqr-192.png` | 200, `image/png` |
| `GET /icons/deqr.svg` | 200, `image/svg+xml` |
| `GET /some/deep/route` | 200, single-page fallback to the shell |
| `GET /assets/nope.js` | 404 — a missing asset never returns HTML |
| `POST /` | 405 with `Allow: GET, HEAD` |
| `GET /..%5c..%5cpackage.json` | 400 — rejected |

Main-process markers: `DEQR_PWA_HOST_READY port=5174 certificate=generated interfaces=2`
on first run and `certificate=stored` on the next, confirming the certificate is reused so
the iPhone only has to trust it once. Ports were released on exit (0 listeners on 5174).

### Security properties

- **Read-only.** Only `GET`/`HEAD`; every other method is 405.
- **Confined.** Requests resolve lexically inside the served directory. Percent-encoded
  traversal, encoded backslashes, drive-qualified absolute paths, embedded null bytes, and
  undecodable escapes are rejected. A property test asserts containment across four
  traversal encodings at depths 1–8.
- **Real CSP headers.** Responses carry the receiver's policy as a header, so
  `frame-ancestors 'none'` is finally enforced — a `<meta>` tag cannot do this. A test
  asserts the served header matches the PWA's meta CSP exactly. Also sends
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  and `Permissions-Policy: camera=(self), microphone=(), geolocation=()`.
- **No sniffing.** Unknown extensions are served as `application/octet-stream`.
- **Key hygiene.** Generated private keys are written with mode `0600`; certificate
  lifetime is 397 days, under Safari's 398-day ceiling.
- **Renderer boundary unchanged.** The Electron renderer still cannot reach this server:
  `connect-src 'none'` plus the fail-closed `isAllowedRendererRequest` policy are untouched.
- **Fails open for the desktop.** If hosting fails, the sender still starts and the
  dashboard reports a redacted message; no path or key material is surfaced.

### New residual risks

1. **Inbound LAN listener.** The packaged app accepts connections from the local network.
   Anyone on the same network can fetch the receiver's static assets — these are public
   application files, not user data, and no transferred payload passes through this server.
   Still, it is a new exposure and Windows Firewall will prompt on first run.
2. **Self-signed trust.** The iPhone must trust a locally generated certificate. This is
   inherent to LAN HTTPS without a public CA and matches the previously documented workflow.
3. **Fixed port 5174.** Startup fails if the port is taken, reported as unavailable rather
   than falling back to another port.
4. **Device validation still open.** Installing and running the receiver from this hosted
   origin on a physical iPhone has not been tested. `WEB-IOS-10` remains BLOCKED.

## 19. Remaining Risks

### Release blockers

1. **Gate A `WEB-IOS-10` entirely unexecuted.** No physical iPhone was available. Every
   criterion in §42 — trusted HTTPS, Safari launch, installed standalone launch, camera
   permission/denial/recovery, real QR acquisition, container reconstruction, size and
   SHA-256 equality, the repeatability matrix, lifecycle recovery, session isolation,
   export/Files, offline shell, sustained scanning, VoiceOver, the appearance/accessibility
   matrix, safe areas/orientation, icon/splash review, and evidence-based sender FPS —
   remains open.
2. **Packaged optical transfer to a physical iPhone unexecuted** (§35). Mandatory for
   `DESKTOP-SEC-050`.
3. **Sender FPS is not evidence-based.** 10 FPS remains an unvalidated hypothesis,
   deliberately left unchanged.

### Backlog classification (§37)

| Item | Classification | Rationale |
| --- | --- | --- |
| `WEB-IOS-SEC-003` (CSP hardening) | **Largely resolved; narrow residual** | Its stated criteria are met in source: packaged Electron and the PWA both ship `script-src 'self'` with no `'unsafe-inline'`, and both tighten `form-action`/`frame-src`/`frame-ancestors`/`object-src`. **The response-header gap is now closed for the shipping path**: the packaged app serves the receiver with the CSP as a real header (§21), so `frame-ancestors 'none'` is actually enforced rather than silently ignored as it is in a `<meta>` tag. One residual remains: `style-src 'unsafe-inline'`, required by Vite/React, with no script-execution path given `script-src 'self'` + `connect-src 'none'`. Any *other* future deployment of the PWA (a public web host) would still need its own response headers. |
| `WEB-IOS-DATA-004` (terminal-state privacy/retention) | **Accepted documented residual risk** | On `FAILED`, `mobile-web/src/App.tsx` stops the camera and publishes the terminal snapshot but does not call `receiver.reset()`, so failed-session blocks stay in memory until the user resets or starts a new capture. Session isolation is nonetheless preserved because `requestCamera` resets the receiver before every new session, and no payload is written to disk. Residual is in-memory retention duration, not cross-session contamination or persistence. Metadata-only history remains an open product decision with no payload storage. |

Neither item is closed, and neither was reclassified to make this task pass.

### Other residuals

4. Third-party development residue inside the ASAR (§15) — hygiene/bloat.
5. `GrantFileProtocolExtraPrivileges` is ENABLE because the packaged renderer loads via
   `loadFile(file://)`. Already an accepted, documented decision pending a move to a
   privileged custom protocol.
6. `sessionId` is unvalidated at the preload subscribe bridge (§16).
7. Optical payloads remain unencrypted by the accepted M1 decision. Confidentiality is
   not claimed.
8. Evidence remains bound to an uncommitted dirty worktree; fingerprints in §2 provide
   traceability but no immutable commit exists.

---

## 20. Final Verdict

**NOT ACCEPTED.**

Gate B (`DESKTOP-SEC-050`) passed every criterion that does not require a physical
device: the package was produced and hashed, all six required fuses were verified from
the binary itself, ASAR structure and runtime integrity enforcement were independently
proven by tamper testing, the packaged renderer and preload load cleanly with no blank
window, packaged CSP carries no development allowance, network isolation holds, the
renderer/preload boundary is narrow, and exit/cleanup is clean. One real defect — a
permission test validating a divergent copy of the shipped policy — was found, fixed, and
regression-tested. Gate B is therefore **CONDITIONAL**, held open solely by §35.

Gate A (`WEB-IOS-10`) is **BLOCKED** and entirely unexecuted; no physical iPhone was
available to this session.

Per §47, an unexecuted mandatory gate cannot be downgraded to a documented limitation.
The question in §48 — whether the packaged Windows sender reliably and securely transfers
byte-perfect files through animated QR to a real installed iPhone PWA — remains
**unanswered**, because no proxy, unit test, or packaged smoke test can answer it.

No commit, push, reset, checkout, rebase, or promotion was performed. The dirty worktree
is preserved. Product-owner authorization remains required before any promotion.

### To close the remaining gates

1. Run `.\scripts\run-local.cmd -Https` from a clean environment; install and trust the
   issuing CA on the iPhone; confirm SAN reachability.
2. Execute §42 against the prepared fixtures in `.local-run/acceptance-fixtures/`,
   comparing received size and SHA-256 to `MANIFEST.txt`.
3. Run the 6/8/10/12/15 FPS sweep and set the sender rate from measured useful unique
   payload throughput.
4. Repeat the 5 KiB / 100 KiB / 1 MiB subset with `release/deqr 0.1.0.exe`
   (SHA-256 `80D42022…B66A`) to close §35.
