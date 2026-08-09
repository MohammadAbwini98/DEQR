# DEQR Session Handoff

## Current Status
- **Date**: 2026-08-08
- **Milestone**: DEQR-M2 WEB-IOS (Safari PWA receiver)
- **Status**: IMPLEMENTED/AUTOMATED VALIDATION PASS — FIRST PHYSICAL iPHONE ATTEMPT FOUND A SENDER DEFECT; FIX IMPLEMENTED, RETEST REQUIRED

## Summary of Recent Work
- ADR-008 supersedes MAUI as the active receiver strategy. The existing `mobile/` MAUI sources are **SUPERSEDED, NOT ACTIVE, and preserved for history/reference**; do not delete or extend them.
- The active receiver is `mobile-web/`: a standalone Safari PWA with a locally bundled shell/service worker, user-initiated camera controller, jsQR worker returning raw `Uint8Array`, browser-safe desktop-v1 frame/container/fountain decoding, SHA-256 verification before export, and Web Share/download fallback.
- The first physical iPhone scan showed the camera active and collected 166/166 unique source blocks with zero duplicates, then failed container validation: `INVALID_METADATA: magic is not valid UTF-8`. Source inspection showed `SessionManager.selectFile` passed raw source bytes to the desktop fountain encoder instead of a DEQR v1 container. The active worktree now wraps every selected file with `serializeContainer`; a session-manager regression test deserializes the queued payload. Physical retest is mandatory before any interoperability pass claim.
- The terminal's `ws://localhost:5173` warning was Vite's local development HMR websocket. It is now explicitly allowed only for localhost:5173. `loopback:cancel` after cleanup is now idempotent rather than logging `SESSION_NOT_FOUND`.
- `RUN-LOCAL.md` contains the verified command sequence for the Electron sender and the PWA. `npm.cmd test` passed: 13 files / 127 tests. `npm.cmd run mobile-web:test` passed: 3 files / 13 tests. `npm.cmd run mobile-web:build`, `npm.cmd run typecheck`, and AI doctor (0 warnings) passed.
- Installed-PWA launch, offline behavior, Share/Save, hash verification, and corrected desktop-to-iPhone physical optical reconstruction remain **NOT EXECUTED**. A trusted HTTPS origin is required for the relevant iPhone tests.
- ADR-007 (`DEQR-ADR-MOBILE-001`) remains the approved architecture: C# + .NET MAUI 10, iOS first, raw DEQR binary QR transport, AVFoundation camera layer, strict offline operation.
- Deterministic TypeScript vector generator produces **15 binary vectors plus `expected.json`**.
- Golden coverage includes three containers, five systematic K=5 frames, two repair frames, checksum/truncation/trailing-container attacks, inconsistent-session input, and oversized-payload declaration.
- Manifest includes deterministic Mulberry32 outputs and Robust Soliton repair-degree/neighbor expectations.
- `DEQR.Core` targets `net10.0` and compiles successfully.
- C# parity suite requires byte-for-byte container reserialization, frame reserialization, C# encoder output parity, PRNG/Soliton parity, mandatory decoder completion/reconstruction, duplicate handling, bounds checks, and malformed-input rejection.
- GitHub Actions workflow `.github/workflows/ios1-core.yml` is the executable Stage IOS-1 gate.
- Final clean-history evidence: workflow run **31215064432**, with deterministic vector regeneration/reproducibility PASS, .NET 10 restore/build PASS, xUnit parity tests PASS, and AI doctor PASS.

## Merge History
- PR #1 `fix(renderer): prevent packaged blank screen during bootstrap` — **MERGED** as `52f03702c76deb24dfc1a5af7b1874fe6666775b`.
- PR #2 `feat(mobile): Stage IOS-1 protocol parity and .NET 10 core gate` — normalized to the current `main` baseline, final CI passed, then **MERGED** as `3aaf0bc0b3ced96863dcbdd7a4fbb42ea8b11b65`.

## Next Session Focus
- **Milestone**: DEQR-M2 WEB-IOS physical PWA acceptance
- **Status**: BLOCKED BY EXTERNAL HTTPS/iPHONE ACTION
- **Tasks**:
1. Start the corrected desktop sender and PWA using `RUN-LOCAL.md` from `D:\Projects\DEQR-ios2`.
2. Re-run the same transfer and verify completion, SHA-256, and saved-file bytes on the iPhone.
3. Serve `mobile-web/` from a trusted HTTPS origin, install it using Safari > Share > Add to Home Screen > Open as Web App, then run standalone/offline/export evidence.

## Still Open Outside M2
- The renderer blank-screen source fix is merged, but a new Windows portable executable must be rebuilt from current `main` and visually verified.
- Desktop packaged camera lifecycle smoke test remains pending after that rebuild.
- Desktop physical optical-transfer acceptance remains open.
