# DEQR Current Project State

**Current Phase**: Phase 1 — Milestone M1 (Stage 4: Optical Integration) + Milestone M2 Mobile Receiver
**Last Updated**: 2026-08-12
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

## Defensible Status
- Stage 4 Phase 1: PASS
- Stage 4 Phase 2.3 software implementation: PASS
- Desktop trailing-byte/container canonicality boundary: PASS
- Desktop permission-policy automated matrix: PASS
- Desktop automated test suite post-merge (2026-08-12): **220 PASS / 21 files** (pre-merge checkpoints were 131 PASS on `main` at `bcc0527`, 131 PASS in the 2026-08-09 remediation verification, and 126 PASS at the earlier accepted Stage 4 checkpoint)
- PWA automated suite post-merge: **25 PASS / 7 files**
- Desktop and PWA typecheck post-merge: **PASS**
- Desktop renderer build post-merge: **PASS**
- AI doctor and adapter drift post-merge: **PASS (0 warnings) / zero drift**
- Post-merge packaged artifact: **NOT REBUILT** — no packaged or portable evidence exists for the merged tree
- Desktop portable packaging/source-to-artifact evidence: previously PASS at accepted Stage 4 checkpoint
- Packaged renderer source fix: **MERGED — MANUAL PORTABLE REBUILD/VISUAL RETEST REQUIRED**
- Desktop packaged camera lifecycle smoke test: **BLOCKED UNTIL NEW PORTABLE BUILD IS VISUALLY CONFIRMED**
- TSK-028 desktop renderer remediation: **SUPERSEDED BY THE 2026-08-12 MERGE.** The six conflicting renderer files resolved to `codex/ios2-shell`, which carries its own, more extensive accessibility markup. `407a4b3`'s renderer changes are no longer in the tree, so the earlier TSK-028 rendering, contrast, and assistive-technology findings describe code that no longer ships. They are retained in TASK-LOG as history only.
- TSK-028 surviving contributions: `frame: false` in `src/main/index.ts` (auto-merged), the `.gitignore` entries, and `src/renderer/ui-model.ts` with its test. **`ui-model.ts` is now orphaned** — no merged component imports it; only its own test references it.
- Merged desktop renderer accessibility: **UNVERIFIED AGAINST ASSISTIVE TECHNOLOGY.** The suite still has no desktop a11y assertions, so ARIA, focus order, and screen-reader behaviour remain unexercised. The `ios2-shell` renderer has more ARIA than the superseded one by static count, which is not evidence that it works.
- Merged window chrome: **UNVERIFIED.** `frame: false` now applies to the `ios2-shell` renderer, which has a custom title bar with drag regions but previously ran with Electron's native frame as well. Nobody has confirmed the merged combination renders exactly one header or that dragging and the window controls work.
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
- WEB-IOS-2 Offline/installability: **IMPLEMENTED; BROWSER/iPHONE OFFLINE RUNTIME NOT EXECUTED**
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
- The dashboard now lists **every** reachable address with a Tailscale / Local network switch, so the choice is explicit rather than a heuristic guess. Startup logs the choice: `DEQR_PWA_HOST_READY ... preferred=overlay`.
- HTTPS was never the blocker: the certificate SAN is `DNS:localhost, IP:127.0.0.1, IP:192.168.100.41, IP:100.95.40.3`, and the receiver was verified loading over `https://100.95.40.3:5174/`.

## Packaged iPhone Receiver Hosting (2026-08-11)

- The packaged desktop app now **serves the iPhone receiver itself** over LAN HTTPS on port 5174 and shows the URL on its dashboard as a scannable QR code plus text. The Vite development server is no longer required to use a phone, which removes the development-only distribution posture.
- The PWA builds to `dist/pwa` and ships inside `app.asar`; `npm run package` and `npm run dist` build it automatically.
- TLS material resolves as env override -> stored certificate that still covers the current LAN addresses -> freshly generated, persisted under `userData`. Verified reuse: first run reported `certificate=generated`, the next reported `certificate=stored`, so the iPhone only trusts it once.
- Server is read-only: `GET`/`HEAD` only, lexical containment inside the served directory, and rejection of percent-encoded traversal, encoded backslashes, drive-qualified paths, null bytes, and undecodable escapes.
- **`frame-ancestors 'none'` is now genuinely enforced** because the policy is delivered as a real response header, which a `<meta>` tag cannot do. This closes the response-header half of `WEB-IOS-SEC-003` for the shipping path.
- New residual: the packaged app accepts inbound LAN connections (static application assets only; no transferred payload passes through it) and Windows Firewall prompts on first run.
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

1. Perform trusted physical Safari/installed-PWA acceptance: CA/firewall reachability, camera permission/denial/recovery, standalone launch, offline shell, export/Files, VoiceOver and the appearance/accessibility matrix, and corrected desktop-to-iPhone byte/hash reconstruction. Fixtures with recorded SHA-256 digests are staged at `.local-run/acceptance-fixtures/`.
2. Run the 6/8/10/12/15 FPS sweep on the device and set the sender rate from measured useful unique payload throughput. The current 10 FPS default remains an unvalidated hypothesis and was deliberately left unchanged.
3. Repeat the 5 KiB / 100 KiB / 1 MiB subset using the packaged portable artifact (`release/deqr 0.1.0.exe`, SHA-256 `80D42022…B66A`) to close the last `DESKTOP-SEC-050` criterion.
4. Before any real PWA deployment, resolve `WEB-IOS-SEC-003`'s response-header boundary — `frame-ancestors` is ignored when CSP is delivered via `<meta>`.
5. Do not revive MAUI work.
6. Confirm the merged desktop window chrome on an unlocked desktop. `frame: false` from `407a4b3` auto-merged onto the `ios2-shell` renderer, which previously ran with Electron's native frame on top of its own custom title bar. Verify title-bar dragging, minimize/maximize/close, and that exactly one header renders.
