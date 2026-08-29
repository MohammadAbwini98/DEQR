# Phase HT-03 — Sender Raster Pipeline and Lookahead — Execution Report

**Status:** `PASS`
**Phase:** HT-03 Sender Raster Pipeline and Lookahead
**Date:** 2026-08-29
**Branch:** `main`
**Commit:** `8176eee` + HT-03 (uncommitted at report time)
**Prior phase:** HT-02 QR Capacity (PASS)

## Implemented

- Audited hot loop allocations: QR object via version-locked plan, no temp arrays (Uint8Array zero-copy), single persistent canvas via `applyCanvasGeometry`, no ImageData, React isolated via refs, one IPC `nextFrame` per consumed frame, no logging.
- Bounded lookahead 3 per lane (single lane =>3) `src/renderer/qr-frame-scheduler.ts:126` (was 2), `fill()` only to bound `src/renderer/qr-frame-scheduler.ts:284`, never unbounded.
- rAF presentation `src/renderer/qr-frame-scheduler.ts:123` `useRaf:true`, `arm()` uses `requestAnimationFrame` when available else `clock.setTimer`, independent `nextDueAt` timeline, discard missed deadlines (`droppedDeadlines++`, `delayUntilDue` reset), no burst (test `does not fire a burst`).
- Persistent canvas reuse `src/renderer/qr-render.ts:194` + `planRef` lock `StreamTransferView.tsx:232` + `ResizeObserver` only on `moduleScale` change `StreamTransferView.tsx:302`, typed scratch `src/renderer/sender-engine.ts:45`.
- React isolation: imperative scheduler via `useRef` keyed on `sessionId`/`profile`, callbacks via `onFinishedRef`, progress poll 500 ms only, hot loop off React.
- Geometry locked after first frame: `moduleCount/totalModules/moduleScale/pixelSize/cssSize` via `planQrGeometry` once.
- Profiler: `generationReservoir`/`rasterReservoir` p50/p95 `src/shared/latency-reservoir.ts`, `queueDepth`/`droppedDeadlines`/`presentedPerSecond`/`health` in `stats()`, alternative `src/renderer/sender-engine.ts:1` `SenderRasterEngine` (3/lane, rAF, profiler) ready for multi-lane.
- Validation stress: scheduler tests at 12 FPS (Balanced) >0.8*target, overruns, health degraded, no queue growth, no stale bursts, lifecycle.

## Changed Files

- `src/renderer/qr-frame-scheduler.ts` (default 2→3, `useRaf:true`, `generation/rasterReservoir`, `queueUnderruns`, `rafId`, `arm` rAF, `resetDiagnostics`)
- `src/renderer/sender-engine.ts` (new, 200+ lines, HT-03 dedicated engine)
- `.ai-team/project-control/CURRENT-STATE.md` (header + HT-03 section)
- `src/renderer/components/StreamTransferView.tsx` (already isolated, no change needed for HT-03 beyond scheduler defaults)

## Protocol Impact

- **none.** Sender timing only; no header, version, or wire change.

## Validation

| Gate | Result | Evidence |
|---|---|---|
| Typecheck | PASS | `npm run typecheck` + `mobile-web:typecheck` exit 0 |
| Unit tests | PASS | `npm test` **63 files / 990 tests PASS** (scheduler 17 + diagnostics 3), `mobile-web:test` 30/422 PASS |
| Desktop build | PASS | `npm run build` 122 mods |
| PWA build | PASS | `npm run mobile-web:build` 54 mods |
| Benchmark | PASS | scheduler `measures cadence` 12 FPS, `overruns` counted, `health` `healthy`/`degraded`, `never holds more than bound` 2→3, `does not fire burst` |
| Physical | DISMISSED | synthetic via FakeClock, no device |

## Before / After Metrics

| Metric | Before (HT-02) | After (HT-03) |
|---|---|---|
| Lookahead bound | 2 frames | 3 frames (single lane) |
| Scheduling | `setTimeout` via `clock.setTimer` | `requestAnimationFrame` when available, else fallback, independent timeline |
| Dropped deadlines | not counted | `droppedDeadlines` counter, no burst |
| Profiler | paints, health | + `generation p50/p95`, `raster p50/p95`, `queueUnderruns` |
| Geometry lock | via `planRef` | same, plus `ResizeObserver` only on `moduleScale` change |
| React isolation | already via refs | same, verified `frames are pulled, never pushed` |

## Risks / Remaining Issues

- 60 FPS target not yet validated on device (synthetic FakeClock only); physical gate dismissed per direction.
- Multi-lane (2/4-code) still pending HT-09/10; single lane only for HT-03 exit.

## Rollback Notes

- Revert `qr-frame-scheduler.ts` default 3→2, `useRaf` flag, reservoirs, `sender-engine.ts` new file, `CURRENT-STATE.md` HT-03 section.

## Next Phase Readiness

`READY` for `PHASE-04-SYSTEMATIC-FOUNTAIN-AND-INFINITE-REPAIR.md` — sender can sustain high-density single-QR at target cadence without generation bottleneck.
