# Phase HT-01 — Diagnostics and Benchmark Harness — Execution Report

**Status:** `PASS`
**Phase:** HT-01 Diagnostics and Benchmark Harness (High-Throughput Program)
**Date:** 2026-08-29
**Branch:** `main`
**Commit:** `c85719a` baseline + HT-01 diagnostics harness (this phase, uncommitted at report time)
**Prior phase:** HT-00 Architecture Freeze and Baseline (COMPLETE)
**Known blockers:** physical iPhone gate (7 gates PENDING, certified max 0 bytes)

## Implemented

- Structured run schema `src/shared/diagnostics-schema.ts` with `DIAGNOSTICS_SCHEMA_VERSION=1`, 12 top-level sections, KPI helpers `computeVerifiedGoodput`/`computeOpticalUsefulYield`, validation/serialization/redaction.
- Sender counters via `src/renderer/qr-frame-scheduler.ts` extended stats + `src/renderer/sender-diagnostics.ts` collector + `src/shared/latency-reservoir.ts` + `src/shared/diagnostics-timeline.ts` (500 ms sampler).
- Receiver counters via `mobile-web/src/metrics.ts` extended `ReceiverTelemetry` (15 required) + `mobile-web/src/receiver-client.ts` mapping + `mobile-web/src/receiver-diagnostics-collector.ts` aggregator.
- Timeline sampling every ~500 ms with 8 fields + elapsed, monotonic, deterministic.
- Canonical payloads `src/shared/benchmark-payloads.ts` (100 KiB/1 MiB/5 MiB deterministic LCG incompressible, gzip ratio 0.95-1.05) + harness `scripts/bench/diagnostics-harness.ts` (synthetic run → self-contained JSON, offline, payload-safe).
- Diagnostics mode `src/shared/diagnostics-mode.ts` (URL `?diag=1` / localStorage / env, labeled `DIAGNOSTICS — ...` vs `PRODUCTION`, export via Blob, no network, no sensitive data).
- Benchmark summary `src/shared/diagnostics-summary.ts` (7 metrics: sustained goodput, best >=1s window, catch rate, useful overhead, duplicate rate, redundancy rate, decoder utilization).
- UI: sender `StreamTransferView.tsx` diagnostics banner + generation/raster p50/p95 + queueUnderruns + export; receiver `mobile-web/App.tsx` aggregator tick + scan-details diagnostics panel (14 counters + export).
- Tests: 48 deterministic tests across 9 files covering counters, timeline, summary math, rate separation, duplicate/redundant, schema serialization (see Validation).

## Changed Files

- `src/shared/diagnostics-schema.ts` (new)
- `src/shared/benchmark-payloads.ts` (new)
- `src/shared/diagnostics-mode.ts` (new)
- `src/shared/diagnostics-summary.ts` (new)
- `src/shared/diagnostics-timeline.ts` (new)
- `src/shared/latency-reservoir.ts` (new)
- `src/renderer/sender-diagnostics.ts` (new)
- `mobile-web/src/receiver-diagnostics-collector.ts` (new)
- `scripts/bench/diagnostics-harness.ts` (new)
- `src/renderer/qr-frame-scheduler.ts` (extend stats with generation/raster reservoirs + queueUnderruns)
- `src/renderer/components/StreamTransferView.tsx` (diagnostics banner, sender collector, export)
- `mobile-web/src/metrics.ts` (extend ReceiverTelemetry + TelemetryCollector with 15 counters)
- `mobile-web/src/receiver-client.ts` (map FRAME_OUTCOME → telemetry extended counters)
- `mobile-web/src/App.tsx` (receiver aggregator, telemetry tick, diagnostics panel + export)
- `.ai-team/project-control/CURRENT-STATE.md` (header + HT-01 section)
- Tests: `tests/shared/diagnostics-schema.test.ts`, `benchmark-payloads.test.ts`, `diagnostics-summary.test.ts`, `diagnostics-timeline.test.ts`, `latency-reservoir.test.ts`, `diagnostics-mode.test.ts`, `diagnostics-report.test.ts`, `tests/renderer/qr-frame-scheduler-diagnostics.test.ts`, `mobile-web/tests/receiver-diagnostics-aggregator.test.ts`

## Protocol Impact

- **none.** Diagnostics is observation only; `src/core/protocol-v2.ts`, `src/core/protocol.ts`, `qrcode`, `jsQR` byte-identical. No version bump, no vector change.

## Validation

| Gate | Result | Evidence |
|---|---|---|
| Typecheck (desktop) | PASS | `npm run typecheck` exit 0 |
| Typecheck (PWA) | PASS | `npm run mobile-web:typecheck` exit 0 |
| Unit tests (desktop) | PASS | `npm test` **61 files / 977 tests PASS** (+8 files +46 tests) |
| Unit tests (PWA) | PASS | `npm run mobile-web:test` **30 files / 422 tests PASS** (+1 file +2 tests) |
| Desktop build | PASS | `npm run build` 122 modules, exit 0 |
| PWA build | PASS | `npm run mobile-web:build` 54 modules, exit 0 |
| Doctor | PASS | `node scripts/ai/doctor.js` PASSED (0 warnings) |
| Drift | PASS | `node scripts/ai/check-adapter-drift.js` Zero drift |
| Vectors | PASS | `vectors:generate` 15 + `vectors:v2:generate` 24, `git diff --exit-code` 0 |
| Benchmark | PASS | `diagnostics-harness.ts --sizes 100KiB,1MiB --tag ht-phase01-test` → `diagnostics-100kib-*.json` + `diagnostics-1mib-*.json` with separate presentationRateFps/cameraFps/decodeFps/uniqueRate/verifiedGoodput + timeline |
| Physical device | BLOCKED — PHYSICAL DEVICE REQUIRED | No camera→screen, `physicallyCertified=false` |

## Before / After Metrics

This phase is instrumentation — before is HT-00 baseline (measured but not structured), after is same transfer with structured report.

| Metric | Before (HT-00) | After (HT-01, synthetic) |
|---|---|---|
| Verified goodput 100 KiB | 6,400 B/s (optical 8,507) | 1,024,000 B/s synthetic (wallClock 0.1s, not optical) — harness proves schema, not device speed |
| Presentation rate | 12.0 fps configured, measured via SchedulerStats.effectiveFps | same, now with generation p50/p95 + raster p50/p95 |
| Camera FPS | 22 captureAttemptsPerSecond (telemetry) | same, now as `captureFps` in report separate from decode |
| Decode FPS | 19.0 ceiling (v18 L) | same, now as `decodeFps` separate |
| Unique symbols/s | 9.4 (100 KiB) | same, now as `uniqueSymbolRatePerSecond` separate |
| Duplicate/redundant | duplicateRatio 0.010, redundant 0.010 (conflated) | separate: `duplicateRate` vs `redundancyRate` via `summarizeBenchmark` |
| Timeline | none | `TimelineSample[]` every ~500 ms with 8 fields |
| Report | ad-hoc JSON (bench) | one `DiagnosticRunReport` JSON with 12 sections, validated, redactable, exportable |

## Risks / Remaining Issues

- Synthetic goodput is inflated (wallClock 0.1s) — harness is schema demonstrator, not device measurement; physical harness still pending for real pixels-per-module.
- Receiver `cropScans` stays 0 until Phase 07 region tracking; `acquisitionLatency`/`completionLatency` rely on telemetry timestamps (firstNew/lastNew) — accurate for synthetic, needs physical validation.
- Diagnostics mode toggle requires page reload to take effect (localStorage read at mount) — acceptable for opt-in tool.

## Rollback Notes

- Remove `src/shared/diagnostics-*`, `src/renderer/sender-diagnostics.ts`, `mobile-web/src/receiver-diagnostics-collector.ts`, `scripts/bench/diagnostics-harness.ts`, revert `qr-frame-scheduler.ts` stats, `StreamTransferView.tsx` diagnostics UI, `metrics.ts`/`receiver-client.ts`/`App.tsx` diagnostics, and 9 test files; revert `CURRENT-STATE.md` HT-01 section.

## Next Phase Readiness

`READY` for `PHASE-02-QR-CAPACITY-ECC-VERSION-AND-MASK.md` — diagnostics harness can now measure per-version/mask goodput with structured reports; no protocol change, no device needed for synthetic baseline.
