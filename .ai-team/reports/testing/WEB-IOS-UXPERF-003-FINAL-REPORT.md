# WEB-IOS-UXPERF-003 Final Validation Report

**Date:** 2026-08-10  
**Worktree:** `D:\Projects\DEQR-ios2`  
**Branch / HEAD:** `codex/ios2-shell` / `be2816d99220218214dcb0d9731f2452a6cc3f43`  
**Verdict:** **NOT ACCEPTED**

The implementation is a conditional automated/compositional pass. Final acceptance is withheld because the corrected desktop-to-iPhone optical transfer, installed/offline PWA behavior, real-camera sustained performance, VoiceOver/device appearance checks, and packaged Electron fuse/ASAR gate were not executed.

## 1. Executive summary

- Repaired the production sender contract so source bytes are serialized as a DEQR v1 container before fountain encoding.
- Added a standalone Safari PWA receiver with bounded in-memory reconstruction, exact size/SHA-256 verification, safe export, lifecycle cleanup, and local-only assets.
- Reduced the PWA scan hot path to a bounded central ROI, one in-flight worker decode, transferable buffers, terminal latching, and coalesced UI metrics.
- Reduced sender presentation to a conservative 10 FPS, serialized QR rendering, a persistent canvas, latest-frame coalescing, and 5 Hz statistics.
- Reworked both PWA and Electron flows around explicit actions, nonblank async/result states, accessible focus, concise live announcements, recoverable errors, restrained motion, safe-area handling, and high-contrast static QR surfaces.
- Preserved the existing DEQR SVG and added deterministic PNG exports at 16, 32, 64, 180, 192, and 512 pixels.
- All current source tests, type checks, builds, doctor, drift check, whitespace check, and the combined local launcher passed.

## 2. Team structure and task ownership

| Assignment | Role | Scope | Outcome |
| --- | --- | --- | --- |
| WEB-IOS-UXPERF-003-A | System architect / performance | Read-only architecture, physical evidence, and benchmark audit | Completed; physical and immutable-before gates remain open |
| WEB-IOS-UXPERF-003-B | UI/UX and motion | Apple reference audit across PWA and Electron | Completed; source findings remediated, device sign-off open |
| WEB-IOS-UXPERF-003-C | QA / security | Independent tests and source controls | Conditional automated pass |
| WEB-IOS-UXPERF-003-D | Front-end | Bounded PWA UI/accessibility remediation | Completed; 7 files / 25 tests pass |
| WEB-IOS-UXPERF-003-E | Front-end | Bounded Electron renderer remediation | Completed; full desktop suite 17 files / 141 tests pass |
| WEB-IOS-UXPERF-003-F | Branding | Existing-logo raster exports only | Completed; six deterministic PNGs verified |

## 3. Before-state baseline

- First physical iPhone attempt recovered **166/166 unique blocks** after **1,994 displayed sender frames** over about **66.1 seconds**, then failed with `INVALID_METADATA: magic is not valid UTF-8` because the desktop streamed raw source bytes rather than the required DEQR container. That is at most about **1.26 KiB/s** useful block recovery and is not an end-to-end success.
- The prior PWA loop decoded a full 1280x720 RGBA frame and added a fixed 90 ms delay after each decode. It copied the full image buffer and published React state at scan cadence.
- The original desktop/PWA flows had blank or ambiguous terminal states, broad live-region churn, automatic camera access, weak recovery, contrast failures, incomplete safe-area handling, and no rendered Apple/PWA icon sizes.
- Existing benchmark files are labelled baseline but identify the same dirty HEAD. They are useful local proxies, not an immutable pre-remediation baseline.

## 4. Root-cause findings

1. **Interoperability:** the sender fountain-encoded raw file bytes while the receiver parsed a serialized DEQR v1 container.
2. **Camera cost:** full-frame 1280x720 capture/decode, repeated canvas resize/readback, worker-buffer copying, and fixed post-decode delay inflated latency and allocation pressure.
3. **Render/UI churn:** camera and QR statistics were coupled to React updates; the sender could replace pending work faster than the canvas rendered it.
4. **Accessibility/state:** high-frequency numeric content was live, focus did not follow major state changes, camera permission was not consistently explicit, and cancellation/result states were underspecified.
5. **Security:** the old development network guard used a string prefix; Electron CSP/fuse/package evidence remained incomplete.

## 5. Implemented optimizations

- PWA camera captures a central 86% square ROI capped at 720 pixels, uses `requestVideoFrameCallback` when available, permits only one in-flight decode, reuses the capture canvas, and transfers the existing RGBA buffer to the worker.
- PWA receiver state snapshots are coalesced to 150 ms while terminal states publish immediately. Verification is single-flight and stops the camera first.
- Sender now uses 10 FPS pending device measurement. QR rendering is serialized, keeps only the latest pending frame, reuses canvas resources, renders at a stable 400-pixel surface, and emits UI statistics at 5 Hz.
- Electron camera work uses ref-based backpressure and 200 ms metric publication.
- Protocol resources are bounded; terminal paths clear/release receiver/session data; extension, size, decompression, and integrity checks run before export/save.

## 6. iOS/PWA redesign

- Single-purpose home screen with one primary receive action and plain-language integrity/privacy explanation.
- Explicit camera preparation, active, unavailable, receiving, verifying, verified, failed, cancelled, retry, and export states.
- Dedicated concise live status; progress, duplicate, and timing values remain non-live.
- Focus moves to meaningful state headings, not frame/progress updates.
- Additive top/right/bottom/left safe-area padding, responsive portrait/landscape layouts, in-flow sticky actions, 48-pixel buttons, and dynamic-text-safe wrapping.
- Light/dark appearance, increased contrast, reduced transparency, and reduced motion are represented in source. Physical iPhone validation is still required.

## 7. Electron redesign

- Preparing, verifying, completed, failed, and cancelled views no longer render blank content.
- Camera permission follows a user action; unavailable/denied states are inline and retryable with no alert dialog.
- Active cancellation requires confirmation with initial focus, Tab trapping, focus restoration, and Escape handling.
- Loopback diagnostics moved under an Advanced disclosure.
- Static black/white QR stage, restrained press feedback, pointer-gated hover, accessible focus, and coalesced sender/receiver statistics.
- Native/custom title-bar integration remains unresolved outside renderer ownership.

## 8. Accessibility and motion review

- Mandatory Apple Design, Emil Design Engineer, Animation Vocabulary, Improve Animations/Audit, Review Animations/Standards, and Logo Designer references were read from the extracted reference tree before final validation.
- Press feedback uses 120-140 ms strong ease-out timing; high-frequency transfer/scanning surfaces have no decorative loop or layout animation.
- Known light-theme contrast failures were corrected in source. Source-contract tests assert contrast, focus, live-region, safe-area, icon, motion, and pointer-gating requirements.
- Remaining manual checks: VoiceOver announcements and modal behavior, Dynamic Type extremes, Reduce Motion/Transparency, Increase Contrast, light/dark appearance, landscape notch/Dynamic Island safe areas, and installed-PWA status/splash presentation.

## 9. Branding rationale

The established DEQR geometric mark already communicates optical/QR transfer, so it was preserved rather than replaced with an Apple imitation. Deterministic PNG exports were added for favicon and Home Screen/platform use. The original SVG is unchanged. The 16-pixel mark remains recognizable but is near the 1-2-pixel detail limit; final iOS mask/treatment must be inspected on-device.

## 10. Benchmark results

### Desktop-container-to-PWA receiver proxy

Every final scenario completed reconstruction and SHA-256 verification. Times exclude QR rasterization, display, camera, Safari, and optical transport.

| Payload | Loss | Frames generated | Prior mean ms | Final mean ms | Final MiB/s |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 KiB | 0% | 11 | 0.864 | 0.821 | 6.455 |
| 5 KiB | 30% | 15 | 1.557 | 0.720 | 7.192 |
| 25 KiB | 0% | 51 | 2.423 | 1.189 | 20.660 |
| 25 KiB | 30% | 104 | 9.967 | 1.811 | 13.583 |
| 100 KiB | 0% | 201 | 5.509 | 4.488 | 22.887 |
| 100 KiB | 30% | 374 | 18.521 | 6.015 | 16.277 |
| 500 KiB | 0% | 1,001 | 22.041 | 16.644 | 29.368 |
| 500 KiB | 30% | 1,952 | 58.605 | 34.631 | 14.269 |
| 1 MiB | 0% | 2,049 | 40.715 | 33.936 | 29.827 |
| 1 MiB | 30% | 4,078 | 112.725 | 75.457 | 13.257 |

### Serialized 532-byte QR proxy

| Raster / frame | Prior round trip ms | Final round trip ms |
| --- | ---: | ---: |
| 400 systematic | 30.573 | 27.802 |
| 400 repair | 25.556 | 26.140 |
| 1000 systematic | 92.648 | 79.917 |
| 1000 repair | 77.573 | 76.131 |

These five-sample dirty-worktree Node proxies show no broad regression but are noisy and are not physical-iPhone throughput evidence. The 10 FPS sender rate is a conservative hypothesis until measured against useful unique decodes on-device.

## 11. Security and protocol validation

- Actual `SessionManager` payload is now a complete v1 container with exact serialized-capacity preflight and source SHA-256.
- Production URL policy parses URLs, rejects credentials/deceptive origins, exact-matches loopback development origins, and fails packaged requests closed.
- PWA receiver enforces frame/reassembly/container/decompression bounds, extension blocking, exact length, and SHA-256 before export.
- PWA CSP is local-only in source; a deployed response header is still required for authoritative anti-framing.
- Electron receive extension checks are present, but direct handler-level oversize/hash/write-cleanup tests and transient-buffer zeroization remain residual.
- Electron packaged CSP and fuse/ASAR behavior remain release blockers.
- Optical payload confidentiality is not claimed; the accepted protocol is integrity-focused and unencrypted.

## 12. Test results

| Gate | Result |
| --- | --- |
| `npm.cmd test` | PASS - 17 files / 141 tests |
| `npm.cmd run mobile-web:test` | PASS - 7 files / 25 tests |
| Desktop typecheck | PASS |
| PWA typecheck | PASS |
| Desktop production build | PASS - 100 modules transformed |
| PWA production build | PASS - 33 modules transformed |
| AI doctor | PASS - 0 warnings |
| Adapter drift | PASS - zero drift |
| `git diff --check` | PASS - line-ending notices only |
| Combined local launcher | PASS - desktop and PWA ready, exact Electron renderer/preload marker emitted, process tree and ports cleaned |
| In-app 390x844 PWA review | PASS for source-rendered home and camera-recovery layouts; no horizontal overflow; camera unavailable in test browser |
| Physical iPhone corrected end-to-end | NOT EXECUTED |
| Packaged Electron / fuses / ASAR | NOT EXECUTED |

## 13. Remaining limitations

1. Corrected physical desktop-to-iPhone transfers for representative 5 KiB, 25 KiB, 100 KiB, 500 KiB, and 1 MiB binary files with byte/hash comparison and repeated runs.
2. Installed standalone PWA, trusted HTTPS/CA, offline relaunch, lifecycle background/foreground, export/Share/Files, orientation, sustained memory/thermal behavior, and appearance/accessibility settings.
3. Sender-FPS versus useful unique decode sweet-spot measurement; current 10 FPS is not a device-derived optimum.
4. Packaged Windows artifact, Electron fuses, ASAR integrity, packaged CSP, renderer/camera behavior, and direct receive-handler security tests.
5. Native/custom title-bar ownership and PWA deployed CSP response headers.
6. Benchmark evidence is bound to an uncommitted dirty snapshot; no immutable before/remediated/final commit sequence exists.

## 14. Final verdict

**NOT ACCEPTED.**

The current dirty source is materially improved and passes the automated, build, compositional-interoperability, launcher, and local PWA visual gates executed here. It must not be presented as final or release-ready until the corrected physical iPhone optical matrix and the packaged Electron security/runtime gate pass. No commit or push was created; product-owner approval remains required before freezing or promoting this worktree.
