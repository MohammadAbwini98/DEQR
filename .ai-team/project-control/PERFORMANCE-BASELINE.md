# Performance Baseline — High-Throughput Program Phase 00

**Date:** 2026-08-29
**Commit:** `c85719a`
**Environment:** `win32-x64` Node `v24.18.1`, 8 cpus, 31.9 GiB RAM, `gcAvailable=true`
**Heads:** `c85719a` dirty `false`

This is the reproducible baseline for every High-Throughput optimization. The authoritative KPI is `verified useful payload bytes / wall-clock transfer seconds` — not FPS, not frames displayed.

---

## 1. Metrics schema (what is measured and where)

Every future phase must report the same fields so before/after is comparable.

| # | Metric | Unit | Meaning | Source |
|---|---|---|---|---|
| 1 | `payload bytes` | B | Original file bytes before compression | `StreamingTransferSession.preflight.originalSize` (`src/main/streaming-sender.ts:331`) |
| 2 | `transmitted container bytes` | B | Bytes segmented (`transportSize`) — equals payload when not compressed | `manifest.transportSize` (`src/core/protocol-v2.ts:210`) |
| 3 | `source block count` | — | `sourceSymbolCount` for the segment | `SegmentPlan` / `sourceSymbolCountForSegment` (`src/core/protocol-v2.ts`) |
| 4 | `source block length` | B | `symbolSizeBytes` | `TransportProfile.symbolSizeBytes` (`src/core/transport-profiles.ts:126`) |
| 5 | `QR bytes/frame` | B | `frameBytes = payload + 32` | `src/core/transport-profiles.ts:167` `frameBytesFor` / `src/core/protocol-v2.ts:198` `overheadBytes:32` |
| 6 | `QR version` | — | 10/18/24/32 | `TransportProfile.qrVersion` (`src/core/transport-profiles.ts:120`) |
| 7 | `ECC` | — | L for all profiles | `src/core/transport-profiles.ts:345` |
| 8 | `configured sender FPS` | fps | `effectiveFps(profile)` | `src/core/transport-profiles.ts:188` |
| 9 | `measured displayed symbols/sec` | sym/s | `SchedulerStats.effectiveFps` | `src/renderer/qr-frame-scheduler.ts:211` |
| 10 | `camera requested FPS` | fps | `ideal 1280x720` — no FPS constraint, interval 40 ms → 25 caps/s theoretical | `mobile-web/src/camera.ts:123/43` |
| 11 | `camera actual FPS` | fps | `videoWidth/videoHeight` derived + `SCAN_INTERVAL_MS` / backpressure | `mobile-web/src/camera.ts:291/250` |
| 12 | `decode attempts/sec` | 1/s | frames submitted to jsQR | `receive-worker-core.ts:248` `process()` count vs wall time |
| 13 | `successful decodes/sec` | 1/s | jsQR returned `binaryData` | `mobile-web/src/metrics.ts` `decodes` reservoir |
| 14 | `unique symbols/sec` | 1/s | dedupe miss + pipeline accepted | `mobile-web/src/metrics.ts` `uniques` vs `ReceivePipeline.lastUniqueFrameAtMs` |
| 15 | `duplicates/sec` | 1/s | `BoundedFingerprintSet` hit | `mobile-web/src/frame-dedupe.ts:101` |
| 16 | `redundant symbols/sec` | 1/s | FEC-redundant (well-formed but no new solved) | `src/core/segment-decoder.ts:58` `REDUNDANT` |
| 17 | `solved source blocks/sec` | 1/s | `SegmentDecoder.solved` ripple | `src/core/segment-decoder.ts:80` |
| 18 | `transfer completion seconds` | s | optical seconds = `framesEmitted / effectiveFps` (`scripts/bench/phase11-certification.ts:15`) |
| 19 | `verified useful goodput KB/s` | KB/s | `original bytes / optical seconds` — the KPI | `scripts/bench/phase11-certification.ts:17` `verifiedBytesPerSecond` |

Separation requirements (program rules):
- Sender presented rate (`effectiveFps` + `SchedulerStats`) vs generated rate (`StreamingProgressView.framesEmitted`) — separate counters (`src/main/streaming-sender.ts:477` `counters.framesEmitted`).
- Camera capture FPS vs QR decode FPS — `metrics.ts` records `captures` vs `decodes` separately.
- Unique vs duplicates vs redundant — `rejectionsByReason` map + `FH_DEDUPE` early set vs decoder `REDUNDANT`.

---

## 2. Baseline transfer profiles (required tiers)

### 2.1 v2 ladder — Balanced profile, 0% loss (clean channel)

Bench: `scripts/bench/phase11-certification.ts --mode ladder --maxMib 5 --tag ht-phase00-baseline` (synthetic opener, `ReceiverPipeline` + `fs`-backed OPFS shim, `Balanced` default: `src/core/transport-profiles.ts:398` v18/686 B/12 fps).

| Payload | Data class | Verified goodput | Optical rate | Optical hours | Unique fps | Dup ratio | Redundant | Pipeline sec | Verify sec | Held MiB | Sender buf MiB | Heap MiB |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 KiB | random | 4,096 B/s | 8,152 B/s | 0.0003 | 6.4 | 0 | 0 | 0.0059 | — | 0.00 | 1.34 | 25.6 |
| 100 KiB | random | 6,400 B/s | 8,507 B/s | 0.0044 | 9.4 | 0.010 | 0.010 | 0.0155 | — | 0.10 | 1.37 | 30.3 |
| 1 MiB | random | 7,864 B/s | 8,507 B/s | 0.0370 | 11.5 | 0.015 | 0.015 | 0.058 | — | 1.00 | 1.37 | 40.7 |
| 5 MiB | random | 5,041 B/s | 8,507 B/s | 0.2889 | 7.3 | 0.385 | 0.385 | 0.416 | 0.052 | 1.34 | 1.37 | 43.5 |
| 100 KiB | compressible | 6,400 B/s | 8,509 B/s | 0.0044 | 9.4 | 0.010 | 0.010 | 0.011 | — | 0.10 | 1.37 | 29.6 |
| 1 MiB | compressible | 7,864 B/s | 8,508 B/s | 0.0370 | 11.5 | 0.015 | 0.015 | 0.048 | — | 1.00 | 1.37 | 31.9 |

Full evidence: `.local-run/bench/phase11/phase11-ladder-ht-phase00-baseline.json` + `...-ht-phase00-5mib.json` (12 + 3 runs, all `hashMatch:true`, `ok:true`).

**Reading:** at 0% loss Balanced should carry no repair (`REPAIR_USED 0.03-0.26` observed is manifest-interval + end-of-segment slack, not loss). Goodput climbs 4.1 → 7.9 KB/s as per-segment manifest overhead amortizes, then drops at 5 MiB where `repairUsed=0.61` reflects the profile's `0.75` budget carried unconditionally — 38% of frames redundant even clean. This 43% unconditional repair is the HSD-01 headroom (see §5).

### 2.2 v1 pipeline — desktop → PWA in-memory (no camera)

Bench: `scripts/bench/desktop-pwa-pipeline.ts --label ht-phase00-baseline --warmups 1 --samples 2` (5 sizes × 2 loss rates, deterministic LCG bytes, `ReceiverSession` from `mobile-web/src/protocol.ts`, 532-byte container frames).

| Payload | Loss | Container | Blocks | Frames gen | Accepted | pwaReceive mean ms | End-to-end ms | Payload MiB/s (in-mem) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 KiB | 0% | 5,217 | 11 | 11 | 11 | 0.026 | 0.95 | 5.1 |
| 25 KiB | 0% | 25,752 | 51 | 51 | 51 | — | — | — |
| 100 KiB | 0% | 102,537 | 201 | 201 | 201 | 0.48 | 2.1 | 48.6 |
| 500 KiB | 0% | 512,060 | 1001 | 1001 | 1001 | 1.9 | 6.8 | 73.8 |
| 1 MiB | 0% | 1,049,677 | 2050 | 2050 | 2050 | 3.8 | 12.4 | 84.6 |
| 5 KiB | 30% | 5,217 | 11 | 15* | 11 | 0.031 | 1.1 | 4.4 |
| 100 KiB | 30% | — | — | — | 201 | — | — | — |
| 1 MiB | 30% | — | — | — | 2050 | — | — | 61.2 |

\* repair overhead ratio `1.0` at 30% loss (v1 fountain), framesGenerated = blocks * (1+ratio): reported `repairOverheadRatio:1` in JSON.

Evidence: `.local-run/bench/desktop-pwa-pipeline-ht-phase00-baseline.json` — 10 scenarios (5×2), all `completed:1`, `framesDropped:0`, `framesAccepted==sourceBlocks` (loss-0) — byte-exact SHA.

**Note:** payload MiB/s here is *in-memory pipeline* throughput, not optical goodput. Optical goodput is §2.1/§2.3 (optical seconds = frames/effectiveFps). Software overhead is ~4-5k× the link (Phase 00 audit), so these numbers only certify that software is not the bottleneck.

### 2.3 Optical ceiling (profile-limited)

| Profile | Symbol | Effective FPS | Optical payload (`symbol*fps`) | Verified (design loss) | Min camera px/module |
|---|---|---:|---:|---:|---:|
| Reliable | 239 | 10.0 | 2,390 B/s | 1,195 B/s @30% (÷(1+1.00)) | 2.5 |
| **Balanced (default)** | 686 | 12.0 | 8,232 B/s | 4,704 B/s @20% (÷1.75) → **4,096-7,864 measured clean** | 4.0 |
| Turbo | 1139 | 15.0 | 17,085 B/s | 9,763 B/s @20% | 5.0 |
| Experimental | 1920 | 20.0 | 38,400 B/s | 21,942 B/s @20% (not selectable) | 5.0 |

Source: `src/core/transport-profiles.ts:380-446` (`RELIABLE/BALANCED/TURBO/EXPERIMENTAL_PROFILE`), `expectedVerifiedBytesPerSecond` (`src/core/transport-profiles.ts:198`). Phase 11 measured Balanced `4,631 B/s` mean; this rerun's clean 7,864 B/s is *before* the quotient by repair — at 20% loss it becomes `~4.5 KB/s`, matching. All `physicallyCertified:false` (`src/core/transport-profiles.ts:350`).

### 2.4 Camera / QR decode ceilings (this host)

`PHASE04_CPU` (`scripts/bench/phase04-qr-profiles.ts --mode cpu`, 1280×720, 16 trials/version):

| Version | ECC | Frame B | Symbol px | Encode ms | Scan ms (jsQR) | Readback ms | Encode ceiling fps | Scan ceiling fps |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | L | 271 | 260 | 4.30 | 48.4 | 1.84 | 232 | 20.6 |
| 18 | L | 718 | 388 | 6.34 | 52.7 | 1.70 | 158 | **19.0** |
| 24 | L | 1171 | 484 | 10.81 | 67.3 | 1.84 | 92 | 14.9 |
| 32 | L | 1952 | 612 | 15.20 | 69.8 | 1.96 | 66 | 14.3 |
| 10 | M | 213 | 260 | 2.56 | 41.9 | 1.92 | 390 | 23.9 |

**Binding constraint is scan, not encode.** Balanced (v18 L) scan ceiling **19 fps** exceeds its 12 fps target; Turbo (v24 L) scan ceiling 14.9 fps *is* the ceiling — its 15 fps target is fragile. Version-40 L at 740 px is SKIPPED (`symbol-exceeds-camera-frame`). All 16/16 exact round-trips.

QR round-trip bench: `scripts/bench/qr-frame-roundtrip.ts --label ht-phase00-baseline` → `.local-run/bench/qr-frame-roundtrip-ht-phase00-baseline.json` (4 raster/size combos, systematic+repair, 16/16 match).

---

## 3. Receiver decode & FEC baselines (modelled channel)

From `phase11-ladder` (random, clean, Balanced):
- `decodeAttempts` = `framesDelivered` (every delivered frame is an attempt in model; real camera decodes ~19/s vs 12 produced).
- `successfulDecodes` ≈ `framesAccepted` minusmanifest/foreign (here identical).
- `duplicates`/`redundant`: 1.0% at 100 KiB → 38% at 5 MiB (unconditional repair, not loss).
- `solved source blocks/sec` (ripple) = `sourceSymbols / pipelineSeconds` ≈ 1,443 /0.058 ≈ 24k/s (software, not optical).

Loss behavior from prior Phase 11 (imported, not rerun this phase — `PHASE-11-BENCHMARK-CERTIFICATION-REPORT.md:46-48`):
- 0-20% loss: 1 pass, ~5% throughput cost.
- 30%: 17 passes, 280 B/s — cliff at `(1+r)(1-p) < 1.05`.
- Burst vs independent loss identical (`PHASE-03 report` p99 0.94 vs 0.99 at 30%).

---

## 4. Baseline summary (copy for before/after)

| Metric | Baseline (this commit) |
|---|---|
| Verified goodput (5 KiB) | 4.1 KB/s |
| Verified goodput (100 KiB) | 6.4 KB/s |
| Verified goodput (1 MiB) | 7.9 KB/s |
| Verified goodput (5 MiB) | 5.0 KB/s *(repair redundancy 38% — see HSD-01)* |
| Presented symbols/sec (Balanced) | 12.0 configured, ~11.5-12.0 measured (scheduler `effectiveFps`) |
| Camera FPS (capture cap) | 25 caps/s theoretical (40 ms + backpressure 12 ms), ~11-15 decodes/s jsQR-bound |
| Decode FPS | 14.9-19.0 ceiling (v18-v24 L @720², this host) |
| Unique symbols/sec | 6.4 (5 KiB) → 11.5 (1 MiB) → 7.3 (5 MiB, diluted by redundancy) |
| Duplicate rate | 0% (small) → 38% (5 MiB clean — unconditional repair) |
| Redundant rate | same as duplicate (no loss) |
| Useful overhead (1+r) | 1.75 (design) / 1.03-1.61 observed (clean, amortized) |
| Solve rate | ~24k blocks/s (software, not optical) |
| Completion optical seconds | 0.0003 (5 KiB) → 0.037 (1 MiB) → 0.29 (5 MiB) |
| Completion wall seconds (pipeline) | 0.006 (5 KiB) → 0.058 (1 MiB) → 0.42 (5 MiB) |

HSD-02 (diagnostic gap): before this program `measured displayed symbols/sec` and `camera actual FPS` were scheduler stats not surfaced in UI; after Phase 01 they will be `diagnosticReport` fields. HSD-01 (unconditional repair) is 43% link waste.

---

## 5. Open headroom found (not acted on — baseline only)

- **HSD-01 — Unconditional repair is 43% of the link.** Every profile emits `repairOverheadRatio` frames even when loss=0. At 5 MiB clean, 4,642 of 12,480 frames (37%) are repaired nobody needed. Removing it on clean channel is worth 1.6× (`PHASE-11 report` 1.78× at 1 GiB). Phase 11 recorded, not implemented.
- **HSD-02 — Presentation vs optical gap not diagnosed in UI until Phase 01.** `SchedulerStats` exists (`src/renderer/qr-frame-scheduler.ts:67`) but `StreamTransferView` only polls `StreamingProgressView` every 500 ms (`src/renderer/components/StreamTransferView.tsx:348`).

No payload byte of any bench was read from user disk; every fixture is `LCG(offset, seed)` and no payload is printed (see `scripts/bench/desktop-pwa-pipeline.ts:75` `deterministicBytes`, `phase11-certification.ts:55` `Payload safety`).

---

## 6. Evidence files

- `.local-run/bench/desktop-pwa-pipeline-ht-phase00-baseline.json` (10 scenarios)
- `.local-run/bench/phase11/phase11-ladder-ht-phase00-baseline.json` (12 runs)
- `.local-run/bench/phase11/phase11-ladder-ht-phase00-5mib.json` (3 runs)
- `.local-run/bench/qr-frame-roundtrip-ht-phase00-baseline.json` (4 scenarios)
- `PHASE04_CPU` log (captured above, `scripts/bench/phase04-qr-profiles.ts --mode cpu`)
- Prior reports: `.ai-team/reports/performance/PHASE-11-BENCHMARK-CERTIFICATION-REPORT.md` (certified ladder to 4 GiB, 12 runs), `PHASE-04-QR-TRANSPORT-PROFILES-REPORT.md` (19.0 fps ceiling for Balanced)

Physical device rows: **BLOCKED — PHYSICAL DEVICE REQUIRED** — no camera→screen capture measured; camera pixels per module still unpinned.
