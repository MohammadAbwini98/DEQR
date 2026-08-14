# DEQR Current Project State

**Current Phase**: Phase 1 — Milestone M1 (Stage 4: Optical Integration) + Milestone M2 Mobile Receiver
**Last Updated**: 2026-08-13
**Status**: IN_PROGRESS — packaged Electron gate conditionally verified with artifact evidence; physical iPhone gate fully unexecuted (no device). Release verdict remains **NOT ACCEPTED**.

> **PRIMARY ACTIVE WORKSTREAM: WEB-IOS (Mobile Web/PWA Receiver)**
> **DESKTOP MANUAL ACCEPTANCE: SUSPENDED — RELEASE GATE REMAINS OPEN**
> Desktop acceptance evidence remains bound to provisional artifact `C399CCC62C9DED16C81C44BDD5BC91E30BF9B48C87492EE8C7B7007105C1CAC3`; no desktop baseline promotion or release declaration is authorized.
> `codex/ios2-shell` was merged into `main` on 2026-08-12. The six conflicting desktop renderer files resolved to the `ios2-shell` versions, so every packaged and artifact-bound claim above predates that merge and must be re-earned.

## Active Milestones
- M1 desktop optical integration remains pending manual packaged camera/physical acceptance; its manual gate is temporarily suspended.
- ADR-007 is historical only. ADR-008 authorizes the active M2 mobile receiver architecture: the standalone Safari Web App/PWA in `mobile-web/`.
- M2 Stage IOS-2 / TSK-062 (.NET MAUI iOS) is **SUPERSEDED, NOT ACTIVE, and preserved for history/reference**. Its Mac/Xcode deployment dependency is unsuitable for the selected distribution model.
- M2 WEB-IOS is the active workstream: an installable iPhone Safari Web App/PWA. It shares the desktop v1 wire contract through browser-safe TypeScript code and requires no Xcode or native wrapper.

## Completed Tasks
- [x] M1 Stage 1: Verified architecture (doctor + drift pass).
- [x] M1 Stage 2: Implemented Optical Transfer Core (container, protocol, LT encoder/decoder, SHA-256, compression).
- [x] M1 Stage 3: Secured Electron desktop shell, restricted preload bridge, React renderer UI.
- [x] M1 Stage 3.1: Addressed Core security review findings (string/binary conversion patches).
- [x] M1 Stage 4 Phase 1: Validated independent static image `jsQR` decoding.
- [x] M1 Stage 4 Phase 2: Integrated React `CameraReceiver` loop with core `FountainDecoder`.
- [x] M1 Stage 4 Phase 2.1: Enforced strict receiver boundaries and permissions checks.
- [x] M1 Stage 4 Phase 2.2: Addressed trailing-byte vulnerabilities; explicitly validated 11-point permission security matrix.
- [x] M1 Stage 4 Phase 2.3: Fixed packaged Electron ESM/CommonJS collision.
- [x] M1 packaged renderer bootstrap fix merged via PR #1 (`52f03702c76deb24dfc1a5af7b1874fe6666775b`).
- [x] WEB-IOS-OPS-002: Isolated the desktop/PWA Vite optimizer caches; added deterministic launcher readiness, renderer diagnostic marker, PWA bounded decompression, receiver extension policy, and production URL-policy regression coverage. Local evidence is conditional only; see `.ai-team/reports/testing/WEB-IOS-STARTUP-REMEDIATION-QA-REPORT.md`.
- [x] M2 Stage IOS-1 / TSK-060: Deterministic TypeScript vector generator produces 15 binary vectors plus `expected.json`, including all five systematic K=5 frames, repair frames, deterministic PRNG/Soliton expectations, and malformed-input vectors.
- [x] M2 Stage IOS-1 / TSK-061: `DEQR.Core` C# engine targets `net10.0`; Stage IOS-1 Core Gate passed vector regeneration/reproducibility, .NET 10 restore/build, byte-parity tests, and AI doctor.
- [x] M2 Stage IOS-1 merged via PR #2 (`3aaf0bc0b3ced96863dcbdd7a4fbb42ea8b11b65`).
- [x] TSK-028 Desktop renderer accessibility remediation (`407a4b3`), plus the follow-up action-card contrast fix (`bcc0527`), fast-forwarded from `codex/desktop-accessibility-remediation` into `main` (`5bc1586..bcc0527`) on 2026-08-12. **MERGED AND PUSHED** — `main` was fast-forwarded to `origin/main` at `adb3491` on 2026-08-12; no history was rewritten and `main` now tracks `origin/main`. **Its renderer changes were then superseded on 2026-08-12 by the `codex/ios2-shell` merge; see Defensible Status.**
- [x] DESKTOP-UI-009: deleted the orphaned `src/renderer/ui-model.ts`. Two of its exports were dead and one of those also stale; the two that still mattered were duplicated in `App.tsx` in better form and now live in `app-model.ts`, the module the renderer already imports, with coverage moved alongside them.
- [x] DESKTOP-SEC-008: privileged renderer-to-main IPC now authenticates its caller. All 15 channels register through a `handleTrusted` wrapper backed by `src/main/ipc-sender-policy.ts`, which trusts the packaged `file:` renderer always and the exact development origin only when unpackaged, and rejects `data:`, `devtools:`, the PWA origin, subframes, and unreadable frames. Fail-closed with a sanitized error; see ADR-010.
- [x] DESKTOP-IPC-007: removed `loopback.saveVerifiedResult`, a preload method and type that no main handler ever answered and no caller ever used. Loopback is a self-test of a file already on disk and releases its session on completion, so there was never a verified artifact to save; `receive:saveReceivedFile` remains the only file-save path. A production-derived contract test now fails if any preload invoke channel lacks a main handler.
- [x] WEB-IOS-PWA-011: remediated the reported iPhone receiver failure. The receive path itself was cleared by evidence, not assumption; the defect that can strand a phone was the service worker, which pinned an installed receiver to the build it first cached. Added a desktop `GET /health` and a PWA host-availability indicator, made a failing scanner report itself, and aligned the secondary action in the dock. Physical iPhone re-scan remains open.
- [x] DESKTOP-PWA-HOST-006: the iPhone receiver is now user-controlled and off at launch (`831ddb8`, pushed to `origin/main` on 2026-08-13). Certificate generation, interface enumeration, and the socket bind all moved behind an explicit Start. A new `src/main/pwa-host-lifecycle.ts` owns the server handle and serializes start/stop; `pwaHost:start`, `pwaHost:stop`, and the app-scoped `pwaHost:status` broadcast join `pwaHost:getStatus`.

## Defensible Status
- Stage 4 Phase 1: PASS
- Stage 4 Phase 2.3 software implementation: PASS
- Desktop trailing-byte/container canonicality boundary: PASS
- Desktop permission-policy automated matrix: PASS
- Desktop privileged-IPC sender authentication: **PASS (automated)** — all 15 renderer-to-main channels reject an untrusted origin, every subframe, and any destroyed sender frame, proven by enumerating the real registration rather than a maintained list. Packaged builds do not trust the development origin. This is unit-level evidence; it has not been exercised against a running packaged binary.
- Desktop automated test suite after WEB-IOS-PWA-011 (2026-08-13): **260 PASS / 23 files**
- PWA automated suite after WEB-IOS-PWA-011 (2026-08-13): **47 PASS / 10 files**
- Desktop-sender-to-PWA compositional receive path: **PASS** — real container, fountain frames, painted byte-mode QR at the sender's own 400px/margin-4/EC-L settings, jsQR, `ReceiverSession`, exact size and SHA-256. Covers multi-frame reconstruction, repair-only recovery after missed systematic frames, duplicate oversampling, and a foreign session. This is a software-contract pass and is **not** a substitute for the optical gate.
- Shipped PWA decoder worker: **PASS in a live browser** — the built chunk returned a real 532-byte desktop frame byte-exact. `worker.format` is now `es`, matching its `{ type: 'module' }` constructor; it was previously emitted as an IIFE.
- Installed-shell update path: **PASS (source + executed worker)** — see BUG-005. A phone still holding the pre-fix `deqr-mobile-shell-v1` must be confirmed on device.
- Desktop `GET /health` and PWA host indicator: **PASS (local runtime)** — verified over the real HTTPS listener on 5174 across Start/Stop/restart, and in a browser where stopping the host flipped the indicator while the page stayed rendered. Not yet seen on a physical iPhone or under VoiceOver.
- Desktop automated test suite on `main` at `831ddb8` (2026-08-13): **252 PASS / 23 files** (earlier checkpoints were 220 PASS / 21 files immediately post-merge, 131 PASS on `main` at `bcc0527`, 131 PASS in the 2026-08-09 remediation verification, and 126 PASS at the earlier accepted Stage 4 checkpoint)
- PWA automated suite post-merge: **25 PASS / 7 files**
- Desktop and PWA typecheck post-merge: **PASS**
- Desktop renderer build post-merge: **PASS**
- AI doctor and adapter drift post-merge: **PASS (0 warnings) / zero drift**
- Post-merge packaged artifact: **NOT REBUILT** — no packaged or portable evidence exists for the merged tree
- Desktop portable packaging/source-to-artifact evidence: previously PASS at accepted Stage 4 checkpoint
- Packaged renderer source fix: **MERGED — MANUAL PORTABLE REBUILD/VISUAL RETEST REQUIRED**
- Desktop packaged camera lifecycle smoke test: **BLOCKED UNTIL NEW PORTABLE BUILD IS VISUALLY CONFIRMED**
- TSK-028 desktop renderer remediation: **SUPERSEDED BY THE 2026-08-12 MERGE.** The six conflicting renderer files resolved to `codex/ios2-shell`, which carries its own, more extensive accessibility markup. `407a4b3`'s renderer changes are no longer in the tree, so the earlier TSK-028 rendering, contrast, and assistive-technology findings describe code that no longer ships. They are retained in TASK-LOG as history only.
- TSK-028 surviving contributions: `frame: false` in `src/main/index.ts` (auto-merged) and the `.gitignore` entries. **`src/renderer/ui-model.ts` was deleted on 2026-08-14 by DESKTOP-UI-009**, having been stranded by the merge: `407a4b3` both created and imported it, and `b4eb147` resolved `App.tsx` to the `ios2-shell` version, which carries its own helpers. Two of its four exports were dead (`getQrRasterSize` targeted a DPR rasterization path that no longer ships; `estimateMinimumStreamSeconds` was also stale, defaulting to 30 FPS against a shipped 10). The other two were duplicated in `App.tsx` in better form, so they moved to the live `app-model.ts` and are covered in `tests/renderer/app-model.test.ts`.
- Merged desktop renderer accessibility: **UNVERIFIED AGAINST ASSISTIVE TECHNOLOGY.** The suite still has no desktop a11y assertions, so ARIA, focus order, and screen-reader behaviour remain unexercised. The `ios2-shell` renderer has more ARIA than the superseded one by static count, which is not evidence that it works.
- Merged window chrome: **PASS (2026-08-14, DESKTOP-UI-010).** Verified against `release/win-unpacked/deqr.exe`. Exactly one header renders and the native frame contributes zero pixels (restored client rect equals window rect). The drag region hit-tests as `HTCAPTION` and all three controls as `HTCLIENT`. Minimize, maximize/restore and close were driven by real clicks through Chromium's input pipeline and confirmed by `IsIconic`/`IsZoomed`/process exit; maximized, the client rect matches the work area exactly, so nothing is clipped. Real `Tab` traverses the three controls with a rendered focus ring. Caveat: the click/keyboard run had `--remote-debugging-port` attached, so it is not the shipping launch configuration, and screen-reader announcement remains untested.
- Superseded note — merged window chrome was previously recorded as: **UNVERIFIED.** `frame: false` now applies to the `ios2-shell` renderer, which has a custom title bar with drag regions but previously ran with Electron's native frame as well. Nobody has confirmed the merged combination renders exactly one header or that dragging and the window controls work.
- iPhone receiver default posture: **OFF AT LAUNCH — VERIFIED (2026-08-13).** A launched app emitted no `DEQR_PWA_HOST_*` marker and held no listener on 5174. Enforced as the absence of a startup call rather than a flag, and held there by a source-text assertion in `tests/main/package-security-contract.test.ts`.
- Receiver start/stop lifecycle: **PASS (2026-08-13).** 13 lifecycle tests cover the in-flight guard, including double-start coalescing, stop-during-start, and start-during-stop. The real path was additionally driven outside the tests, which all fake the listen: generated a certificate, bound 5174, closed it, and restarted onto `certificate=stored`, with socket-level checks either side of each transition.
- Receiver control click-through: **PASS (2026-08-14, DESKTOP-UI-011).** Start and Stop pressed by real keyboard input against the packaged binary; the receiver bound `0.0.0.0:5174`, answered `/health` over real HTTPS with `no-store`, and released the port on stop. `aria-busy` toggled correctly and the control was not remounted. Verification found a focus defect — the control is disabled during the transition, which blurred it to `<body>` with no restore — now fixed by `shouldRestoreActionFocus` and re-verified against a rebuilt package. **Screen-reader announcement remains UNVERIFIED**; the live region and `aria-busy` are wired, which is the machinery rather than the announcement.
- Superseded note — receiver control click-through and screen-reader pass were previously recorded as: **UNVERIFIED.** Window captures were taken with `PrintWindow` against a locked session, which reads the surface without exercising input. Nobody has pressed Start in the running app, observed `starting -> running`, or confirmed that keyboard focus survives the transition.
- Desktop physical optical-transfer acceptance: **PENDING / OPEN**
- ADR-007 MAUI mobile architecture: **HISTORICAL / SUPERSEDED FOR ACTIVE WORK**
- ADR-008 Safari PWA mobile architecture: **APPROVED / ACTIVE**
- TSK-060 deterministic vector generator: **PASS**
- Golden vectors: **15 binary vectors + expected.json**
- Vector reproducibility: **PASS**
- `DEQR.Core` target: **net10.0**
- C# restore/build: **PASS**
- C# byte-for-byte container/frame/encoder parity: **PASS**
- PRNG/Soliton parity: **PASS**
- Mandatory decoder completion/reconstruction parity: **PASS**
- Malformed-input rejection coverage: **PASS**
- AI doctor: **PASS**
- Stage IOS-1 / TSK-061: **COMPLETED**
- TSK-062 / IOS-2: **HISTORICAL / SUPERSEDED FOR ACTIVE WORK**

## Web/PWA Status
- TSK-062 / IOS-2 MAUI: **SUPERSEDED — PRESERVED, NO FURTHER DEVELOPMENT AUTHORIZED**
- WEB-IOS-1 Architecture + PWA shell: **AUTOMATED PASS**
- WEB-IOS-2 Offline/installability: **IMPLEMENTED; BROWSER/iPHONE OFFLINE RUNTIME NOT EXECUTED.** The offline shell is retained deliberately — an installed receiver is meant to open with no host at all — but it is no longer allowed to pin the build. See BUG-005 and WEB-IOS-PWA-011.
- WEB-IOS-PWA-011 receiver remediation: **AUTOMATED + COMPOSITIONAL + LOCAL-RUNTIME PASS; PHYSICAL iPHONE RE-SCAN NOT EXECUTED**
- WEB-IOS-3 Camera subsystem: **PHYSICAL iPHONE CAMERA + RAW QR ACQUISITION OBSERVED; STANDALONE/OFFLINE NOT EXECUTED**
- WEB-IOS-4 Raw QR byte fidelity: **AUTOMATED PASS**
- WEB-IOS-5 Protocol integration: **AUTOMATED PASS**
- WEB-IOS-6 Multi-frame reconstruction: **AUTOMATED PASS**
- WEB-IOS-7 Integrity + temporary storage: **AUTOMATED PASS**
- WEB-IOS-8 Browser export: **IMPLEMENTED; PHYSICAL iPHONE NOT EXECUTED**
- WEB-IOS-OPS-002 local startup remediation: **CONDITIONAL PASS** — three clean local launcher runs (HTTP, HTTPS, diagnostics) mounted the Electron dashboard and cleaned ports 5173/5174; this is not an iPhone or release pass.
- WEB-IOS receiver decompression and blocked-extension policy: **AUTOMATED PASS** — bounded gzip expansion and blocked received-file extensions have regression coverage.
- Packaged portable/ASAR verification: **PASS (2026-08-10)** — package produced; fuses read from the binary; ASAR structure and runtime integrity independently verified.
- WEB-IOS-9 Desktop/browser interoperability: **AUTOMATED NODE/QR PASS; PHYSICAL iPHONE BLOCKED BY DESKTOP SENDER CONTAINER DEFECT (FIX IMPLEMENTED, RETEST REQUIRED)**
- WEB-IOS-10 Physical iPhone acceptance: **BLOCKED — NO PHYSICAL DEVICE; GATE FULLY UNEXECUTED**
- DESKTOP-SEC-050 packaged Electron security/runtime: **CONDITIONAL** — every non-device criterion passed; held open only by packaged optical transfer to a real iPhone.

## Receiver Address Selection (2026-08-11, corrected)

- The first implementation ranked ordinary LAN addresses (192.168/10/172.16-31) above mesh-VPN addresses, which **regressed the established Tailscale workflow** the previous launcher used (`https://100.95.40.3:5174/`, SAN `100.95.40.3`).
- Evidence that the LAN default was wrong on this host: the Ethernet adapter carrying `192.168.100.41` is on the **Public** firewall profile and **no inbound rule exists for port 5174**, so an iPhone cannot reach it; meanwhile `iphone-13-mini` is an enrolled node on the tailnet.
- Ranking corrected: mesh-VPN addresses in `100.64.0.0/10` are now preferred, because they reach an enrolled phone from any network and do not depend on an inbound firewall rule for the physical adapter.
- The dashboard now lists **every** reachable address with a Tailscale / Local network switch, so the choice is explicit rather than a heuristic guess. The choice is logged when the receiver is started: `DEQR_PWA_HOST_READY ... preferred=overlay`. Since `831ddb8` that happens on the Start press rather than at app startup, which also means the certificate covers the network the user is actually on at that moment.
- HTTPS was never the blocker: the certificate SAN is `DNS:localhost, IP:127.0.0.1, IP:192.168.100.41, IP:100.95.40.3`, and the receiver was verified loading over `https://100.95.40.3:5174/`.

## Packaged iPhone Receiver Hosting (2026-08-11)

- The packaged desktop app **can serve the iPhone receiver itself** over LAN HTTPS on port 5174 and shows the URL on its dashboard as a scannable QR code plus text. The Vite development server is no longer required to use a phone, which removes the development-only distribution posture. Since `831ddb8` this is opt-in per session: the dashboard card starts stopped and publishes nothing until Start is pressed.
- The PWA builds to `dist/pwa` and ships inside `app.asar`; `npm run package` and `npm run dist` build it automatically.
- TLS material resolves as env override -> stored certificate that still covers the current LAN addresses -> freshly generated, persisted under `userData`. Verified reuse: first run reported `certificate=generated`, the next reported `certificate=stored`, so the iPhone only trusts it once.
- Server is read-only: `GET`/`HEAD` only, lexical containment inside the served directory, and rejection of percent-encoded traversal, encoded backslashes, drive-qualified paths, null bytes, and undecodable escapes.
- **`frame-ancestors 'none'` is now genuinely enforced** because the policy is delivered as a real response header, which a `<meta>` tag cannot do. This closes the response-header half of `WEB-IOS-SEC-003` for the shipping path.
- ~~New residual: the packaged app accepts inbound LAN connections (static application assets only; no transferred payload passes through it) and Windows Firewall prompts on first run.~~ **RETIRED 2026-08-13 by `831ddb8`.** The receiver is off at launch and binds nothing until someone presses Start, so an unattended app opens no inbound port and raises no firewall prompt. When it is running the original characterisation still holds: static assets only, no transferred payload through it.
- Renderer boundary unchanged: `connect-src 'none'` and the fail-closed request policy still prevent the Electron renderer from reaching this server.
- Regression: desktop **20 files / 205 tests PASS**; PWA 7 files / 25 tests PASS; typechecks, doctor, drift, `test:packaged`, diff-check, and the fuse verdict all PASS.

## Packaged Acceptance Results (2026-08-10)

- Artifacts: portable `deqr 0.1.0.exe` SHA-256 `80D4202254FD83B74814BD3076ACEB0BAA9A66911A9AFAD78DBCEFBC8142B66A`; NSIS `9C10F2ED…1DAA`; `app.asar` `F0ADAC53…9280`.
- Electron fuses read directly from `release/win-unpacked/deqr.exe`: `RunAsNode` DISABLE, `EnableCookieEncryption` ENABLE, `EnableNodeOptionsEnvironmentVariable` DISABLE, `EnableNodeCliInspectArguments` DISABLE, `EnableEmbeddedAsarIntegrityValidation` ENABLE, `OnlyLoadAppFromAsar` ENABLE — all six PASS.
- ASAR runtime integrity **enforced**: tampering `dist/main/index.js`, `dist/renderer/index.html`, `dist/preload/index.js`, and the archive header was rejected in every case before renderer readiness. Validation is lazy/per-block on read, so bytes in never-loaded vendor files are not checked at launch; the header hash still protects structure.
- Packaged runtime emitted `DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available` and exited clean in 4.08 s with zero blocked-network warnings and zero lifecycle failures.
- Packaged CSP is `default-src 'none'` / `script-src 'self'` (no inline script in the packaged HTML) / `connect-src 'none'`; no development allowance reaches the package.
- Defect found and fixed: `tests/main/permissions.test.ts` was validating a hand-copied duplicate of the permission handlers that had diverged from the shipped parsed-URL policy (the copy trusted host-bearing `file://` URLs that production correctly rejects). Both handlers and the tests now share `evaluateMediaPermission`.
- Regression after the fix: desktop **19 files / 168 tests PASS**; PWA **7 files / 25 tests PASS**; typechecks, builds, `test:packaged`, doctor (0 warnings), drift, `git diff --check`, and the combined HTTPS launcher all PASS.
- Full evidence: `.ai-team/reports/testing/WEB-IOS-PHYSICAL-PACKAGED-ACCEPTANCE-REPORT.md`.

## WEB-IOS-UXPERF-003 Final Source Gate

- Verdict: **NOT ACCEPTED** - corrected physical-iPhone and packaged Electron gates were not executed.
- Source evidence: desktop 17 files/141 tests and PWA 7 files/25 tests passed; both typechecks and production builds passed; doctor, drift, diff check, compositional container/frame/QR validation, and the combined local launcher passed.
- Local PWA review: 390x844 home and camera-recovery layouts rendered without horizontal overflow; the test browser had no camera.
- Completed source remediation: sender v1 containerization, bounded/backpressured PWA scan path, coalesced UI metrics, explicit PWA/Electron async and terminal states, user-initiated camera recovery, state focus/live-status controls, contrast/motion/safe-area fixes, and deterministic platform PNG icons.
- Full evidence: `.ai-team/reports/testing/WEB-IOS-UXPERF-003-FINAL-REPORT.md`.

## Stage IOS-1 Evidence
- GitHub Actions workflow: `.github/workflows/ios1-core.yml`
- Final clean-history passing run: **31215064432** (`core-parity`)
- Earlier diagnostic passing run after compile remediation: `31214720792`
- Final validation included deterministic vector regeneration with `git diff --exit-code`, .NET 10 restore/build, xUnit parity tests, and AI doctor.
- PR #2 was normalized to a single commit directly on the renderer-fixed `main` baseline before final CI and merge.

## Next Recommended Task

**A physical iPhone is the only blocker for both open release gates. The 2026-08-12 merge adds one desktop item that is not device-dependent: item 6.**

0. **Do this before anything else on the phone.** Confirm the iPhone actually picks up the rebuilt shell (BUG-005). Start the desktop receiver, open the installed PWA, and check that the topbar reads **Receiver online** and that scan details list "QR codes read" and "Other transfer" — those exist only in the new build. If the old shell persists, clear the site data or reinstall the PWA, then repeat. Every result below is meaningless until this passes, because a stale shell silently reproduces the original report.
1. Perform trusted physical Safari/installed-PWA acceptance: CA/firewall reachability, camera permission/denial/recovery, standalone launch, offline shell, export/Files, VoiceOver and the appearance/accessibility matrix, and corrected desktop-to-iPhone byte/hash reconstruction. Fixtures with recorded SHA-256 digests are staged at `.local-run/acceptance-fixtures/`. During the scan, read "QR codes read" in scan details: if it stays at 0 while scans climb, the failure is optical or scanner-side, not protocol — the protocol path is now covered by a compositional test.
2. Run the 6/8/10/12/15 FPS sweep on the device and set the sender rate from measured useful unique payload throughput. The current 10 FPS default remains an unvalidated hypothesis and was deliberately left unchanged.
3. Repeat the 5 KiB / 100 KiB / 1 MiB subset using the packaged portable artifact to close the last `DESKTOP-SEC-050` criterion. **Use the 2026-08-14 rebuild, not the 2026-08-10 one.** `release/deqr 0.1.0.exe` is now SHA-256 `16976EE1A2042E4DB425E0776A212F69D371D41015539900B3D918EAA3DE9E9D`, rebuilt at HEAD `b669246` on 2026-08-14 20:41. It supersedes both the `80D42022…B66A` artifact, which predates the merge, the receiver lifecycle, the PWA shell fix and the IPC sender policy, and the intermediate `135A15FC…` set from 02:59 the same day, which predates the receiver-control focus fix. Note that `npm run package` uses `--dir` and refreshes only `release/win-unpacked/`, so the portable goes stale silently unless `npm run dist` is run — that is exactly how a week-old portable came to be sitting beside a current unpacked build.
4. Before any real PWA deployment, resolve `WEB-IOS-SEC-003`'s response-header boundary — `frame-ancestors` is ignored when CSP is delivered via `<meta>`.
5. Do not revive MAUI work.
6. Confirm the merged desktop window chrome on an unlocked desktop. `frame: false` from `407a4b3` auto-merged onto the `ios2-shell` renderer, which previously ran with Electron's native frame on top of its own custom title bar. Verify title-bar dragging, minimize/maximize/close, and that exactly one header renders.
7. On the same unlocked pass, exercise the receiver control from `831ddb8`: press Start and confirm the label disables immediately, that first use prompts the firewall once, that the QR and address switcher appear, that Stop releases port 5174, and that keyboard focus stays on the button across `starting -> running`. Physical-iPhone step 1 now depends on this, because the receiver no longer publishes itself.
