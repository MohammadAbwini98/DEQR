# DEQR Session Handoff

## Current Status
- **Date**: 2026-08-07
- **Milestone**: DEQR-M2 Stage IOS-1 (Protocol Conformance & Test Vector Parity)
- **Status**: PASSED / MERGED TO MAIN

## Summary of Recent Work
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
- **Milestone**: DEQR-M2 Stage IOS-2 / TSK-062 (.NET MAUI 10 iOS Shell)
- **Status**: READY
- **Tasks**:
  1. Scaffold `mobile/src/DEQR.Mobile/` as a .NET MAUI 10 application.
  2. Configure bundle ID `com.mohammadabwini.deqr.receiver`.
  3. Add `NSCameraUsageDescription`; do not request microphone, location, Bluetooth, local-network, or tracking permissions.
  4. Configure Files integration (`UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace`) and `/Documents/Received/` initialization.
  5. Establish the iOS build/signing path using Xcode/Personal Team on the paired Mac before AVFoundation work begins.

## Still Open Outside M2
- The renderer blank-screen source fix is merged, but a new Windows portable executable must be rebuilt from current `main` and visually verified.
- Desktop packaged camera lifecycle smoke test remains pending after that rebuild.
- Desktop physical optical-transfer acceptance remains open.
