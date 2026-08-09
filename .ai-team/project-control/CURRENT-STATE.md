# DEQR Current Project State

**Current Phase**: Phase 1 — Milestone M1 (Stage 4: Optical Integration) + Milestone M2 Mobile Receiver
**Last Updated**: 2026-08-08
**Status**: IN_PROGRESS

> **PRIMARY ACTIVE WORKSTREAM: WEB-IOS (Mobile Web/PWA Receiver)**
> **DESKTOP MANUAL ACCEPTANCE: SUSPENDED — RELEASE GATE REMAINS OPEN**
> Desktop acceptance evidence remains bound to provisional artifact `C399CCC62C9DED16C81C44BDD5BC91E30BF9B48C87492EE8C7B7007105C1CAC3`; no desktop baseline promotion or release declaration is authorized.

## Active Milestones
- M1 desktop optical integration remains pending manual packaged camera/physical acceptance; its manual gate is temporarily suspended.
- M2 mobile receiver architecture is authorized by ADR-007. Stage IOS-1 protocol conformance is implemented, independently CI-validated, and merged to `main`.
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
- TSK-062 / IOS-2: **IN PROGRESS — SHELL SCAFFOLDED; BUILD/DEVICE VALIDATION BLOCKED BY TOOLCHAIN**

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
- WEB-IOS-9 Desktop/browser interoperability: **AUTOMATED NODE/QR PASS; PHYSICAL iPHONE BLOCKED BY DESKTOP SENDER CONTAINER DEFECT (FIX IMPLEMENTED, RETEST REQUIRED)**
- WEB-IOS-10 Physical iPhone acceptance: **IN PROGRESS — FIRST PHYSICAL ATTEMPT COLLECTED ALL 166 BLOCKS, THEN REJECTED INVALID RAW-FILE METADATA**

## Stage IOS-1 Evidence
- GitHub Actions workflow: `.github/workflows/ios1-core.yml`
- Final clean-history passing run: **31215064432** (`core-parity`)
- Earlier diagnostic passing run after compile remediation: `31214720792`
- Final validation included deterministic vector regeneration with `git diff --exit-code`, .NET 10 restore/build, xUnit parity tests, and AI doctor.
- PR #2 was normalized to a single commit directly on the renderer-fixed `main` baseline before final CI and merge.

## Next Recommended Task
1. Complete WEB-IOS automated protocol/PWA gates and record evidence.
2. Perform physical Safari and installed-PWA acceptance from a trusted HTTPS origin.
3. Resume the preserved desktop manual acceptance gates only when desktop work is re-authorized.
