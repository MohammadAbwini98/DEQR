# DEQR Current Project State

**Current Phase**: Phase 1 — Milestone M1 (Stage 4: Optical Integration) + Milestone M2 Mobile Receiver
**Last Updated**: 2026-08-07
**Status**: IN_PROGRESS

## Active Milestones
- M1 desktop optical integration remains pending manual packaged camera/physical acceptance.
- M2 mobile receiver architecture is authorized by ADR-007. Stage IOS-1 protocol conformance is implemented, independently CI-validated, and merged to `main`.

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
- [x] Milestone M2 (Mobile Receiver - iOS via .NET MAUI 10): **AUTHORIZED**.
- [x] M2 Stage IOS-1 / TSK-060: Deterministic TypeScript vector generator produces 15 binary vectors plus `expected.json`, including all five systematic K=5 frames, repair frames, deterministic PRNG/Soliton expectations, and malformed-input vectors.
- [x] M2 Stage IOS-1 / TSK-061: `DEQR.Core` C# engine targets `net10.0`; Stage IOS-1 Core Gate passed vector regeneration/reproducibility, .NET 10 restore/build, byte-parity tests, and AI doctor.
- [x] M2 Stage IOS-1 merged via PR #2 (`3aaf0bc0b3ced96863dcbdd7a4fbb42ea8b11b65`).

## Defensible Status
- Stage 4 Phase 1: PASS
- Stage 4 Phase 2.3 software implementation: PASS
- Desktop trailing-byte/container canonicality boundary: PASS
- Desktop permission-policy automated matrix: PASS
- Desktop automated test suite: 126 PASS at accepted Stage 4 evidence checkpoint
- Desktop portable packaging/source-to-artifact evidence: previously PASS at accepted Stage 4 checkpoint
- Packaged renderer source fix: **MERGED — MANUAL PORTABLE REBUILD/VISUAL RETEST REQUIRED**
- Desktop packaged camera lifecycle smoke test: **BLOCKED UNTIL NEW PORTABLE BUILD IS VISUALLY CONFIRMED**
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
- Final clean-history passing run: **31215064432** (`core-parity`)
- Earlier diagnostic passing run after compile remediation: `31214720792`
- Final validation included deterministic vector regeneration with `git diff --exit-code`, .NET 10 restore/build, xUnit parity tests, and AI doctor.
- PR #2 was normalized to a single commit directly on the renderer-fixed `main` baseline before final CI and merge.

## Next Recommended Task
1. Begin **Milestone M2 Stage IOS-2 (TSK-062)**: scaffold the .NET MAUI 10 iOS application shell and Apple privacy/files configuration.
2. Rebuild the Windows portable executable from current `main`, confirm the renderer visually, then resume the packaged camera lifecycle and desktop physical optical-transfer gates.
