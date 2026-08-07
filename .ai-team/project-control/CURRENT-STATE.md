# DEQR Current Project State

**Current Phase**: Phase 1 — Milestone M1 (Stage 4: Optical Integration) + Milestone M2 Mobile Receiver
**Last Updated**: 2026-08-07
**Status**: IN_PROGRESS

## Active Milestones
- M1 desktop optical integration remains pending manual packaged camera/physical acceptance.
- M2 mobile receiver architecture is authorized by ADR-007. Stage IOS-1 protocol conformance has passed executable CI validation.

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
- [x] Milestone M2 (Mobile Receiver - iOS via .NET MAUI 10): **AUTHORIZED**.
- [x] M2 Stage IOS-1 / TSK-060: Deterministic TypeScript vector generator produces 15 binary vectors plus `expected.json`, including all five systematic K=5 frames, repair frames, deterministic PRNG/Soliton expectations, and malformed-input vectors.
- [x] M2 Stage IOS-1 / TSK-061: `DEQR.Core` C# engine targets `net10.0`; Stage IOS-1 Core Gate passed vector regeneration/reproducibility, .NET 10 restore/build, byte-parity tests, and AI doctor.

## Defensible Status
- Stage 4 Phase 1: PASS
- Stage 4 Phase 2.3 software implementation: PASS
- Desktop packaged camera lifecycle smoke test: **READY — MANUAL EXECUTION REQUIRED**
- Desktop physical optical-transfer acceptance: **PENDING / OPEN**
- ADR-007 mobile architecture: **APPROVED**
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
- TSK-062 / IOS-2: **AUTHORIZED / READY TO START**

## Stage IOS-1 Evidence
- GitHub Actions workflow: `.github/workflows/ios1-core.yml`
- Passing run: `31214720792` (`core-parity`)
- Validation included deterministic vector regeneration with `git diff --exit-code`, .NET SDK 10.0.302, solution restore/build, xUnit parity tests, and AI doctor.

## Next Recommended Task
1. Begin **Milestone M2 Stage IOS-2 (TSK-062)**: scaffold the .NET MAUI 10 iOS application shell and Apple privacy/files configuration.
2. Separately execute the pending manual packaged desktop camera smoke test.
