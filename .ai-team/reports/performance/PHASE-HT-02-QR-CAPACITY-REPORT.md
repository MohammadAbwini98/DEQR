# Phase HT-02 — QR Capacity, ECC, Version and Mask — Execution Report

**Status:** `PASS`
**Phase:** HT-02 QR Capacity, ECC, Version Locking, and Mask Optimization
**Date:** 2026-08-29
**Branch:** `main`
**Commit:** `e743604` + HT-02 (uncommitted at report time)
**Prior phase:** HT-01 Diagnostics Harness (PASS)
**Known blockers:** physical gate dismissed per 2026-08-29 direction — synthetic benchmarks gate this phase

## Implemented

- Verified exact byte-mode capacity 1..40 L/M/Q/H (`src/core/qr-capacity.ts:46` vs `qrcode` probing, `tests/core/qr-capacity.test.ts`).
- New `src/core/qr-frame-model.ts` with `CANDIDATE_FRAME_SIZES [500,1000,1465,1850,2330,2953]`, `evaluateFrameSize` (overhead 32 `V2_DATA_LAYOUT`), `evaluateCandidateSizes`, `checkVersionStability`, `maxFrameBytesForVersion`, `quietZoneModulesForEvaluation`.
- Extended `src/renderer/qr-render.ts` with `QrMaskPattern 0..7`, `QrRenderPlan.maskPattern?`, `resolveQrRenderPlan({maskPattern, quietZoneModules})` guards (`maskPattern 0..7`, `quietZoneModules <4 requires validation`), `paintQrFrame` passthrough `maskPattern`, `benchmarkMaskCost`.
- Preserved quiet-zone 4 (`QR_QUIET_ZONE_MODULES:4`), error `QrPayloadTooLargeError` for >V40/L 2953.
- Version locking already via `planRef` in `StreamTransferView.tsx:232`; now explicit `checkVersionStability`.
- Benchmark matrix `scripts/bench/ht02-qr-matrix.ts` (18 rows, ECC L/M × 500/1000/1465 × 15/24/30 FPS, jsQR, offline) → `.local-run/bench/ht02-qr-matrix.json` (100% synthetic decode, encode 11-31 ms, decode 47-50 ms, goodput payload*FPS).
- Golden tests: `tests/shared/qr-frame-model.test.ts` (7), `tests/renderer/qr-render-mask.test.ts` (6) — 13 tests.

## Changed Files

- `src/core/qr-frame-model.ts` (new, 60 lines)
- `src/renderer/qr-render.ts` (extend `QrRenderPlan`, `resolveQrRenderPlan`, `paintQrFrame`, add `benchmarkMaskCost`)
- `scripts/bench/ht02-qr-matrix.ts` (new)
- `.ai-team/project-control/CURRENT-STATE.md` (header + HT-02 section)
- Tests: `tests/shared/qr-frame-model.test.ts`, `tests/renderer/qr-render-mask.test.ts`

## Protocol Impact

- **none.** Capacity model is read-only; no header, version, or wire change.

## Validation

| Gate | Result | Evidence |
|---|---|---|
| Typecheck | PASS | `npm run typecheck` + `mobile-web:typecheck` exit 0 |
| Unit tests | PASS | `npm test` **63 files / 990 tests PASS** (incl. 13 new HT-02), `mobile-web:test` 30/422 PASS |
| Desktop build | PASS | `npm run build` 122 mods |
| PWA build | PASS | `npm run mobile-web:build` 54 mods |
| Protocol/golden vectors | PASS | capacities re-derived vs `qrcode`, `git diff --exit-code` 0 |
| Benchmark | PASS | `ht02-qr-matrix.ts` 18 rows, `ht02-qr-matrix.json` written, L vs M ordered, V40/L 2953 feasible |
| Physical device | DISMISSED — synthetic gates this phase per direction | No camera device; `physicallyCertified` still false |

## Before / After Metrics

This phase is capacity/model — before HT-01 baseline used fixed Balanced 718 B, after HT-02 can evaluate any frameBytes safely.

| Metric | Before | After (HT-02) |
|---|---|---|
| Frame-size model | ad-hoc `frameBytesFor(profile)` only | explicit `evaluateFrameSize` for 500/1000/1465/1850/2330/2953, all feasible at L with margin, header+payload fit verified |
| Max fountain block | implicit `symbolSizeBytes` | `payloadBytes = frameBytes-32` (e.g. 468@500, 968@1000, 1433@1465) |
| Version stability | implicit via `planRef` | explicit `checkVersionStability` + test, 718→v18 stable |
| Mask cost | auto only, unmeasured | `benchmarkMaskCost` auto vs pinned 0, DEQR-owned path |
| Quiet-zone | 4 | 4 preserved, <4 throws requires validation |

## Risks / Remaining Issues

- Single-QR only; multi-QR (2/4-code) not started per exit criteria.
- Physical module size vs decode reliability still needs device validation (dismissed for now, but `physicallyCertified:false` remains).
- Mask benchmarking synthetic (canvas/jsQR) not yet on iOS Safari.

## Rollback Notes

- Remove `src/core/qr-frame-model.ts`, `scripts/bench/ht02-qr-matrix.ts`, revert `src/renderer/qr-render.ts` mask/quiet-zone guards, remove 2 test files, revert `CURRENT-STATE.md` HT-02 section.

## Next Phase Readiness

`READY` for `PHASE-03-SENDER-RASTER-PIPELINE-AND-LOOKAHEAD.md` — single-QR high-density model is safe, version-locked, and measured.
