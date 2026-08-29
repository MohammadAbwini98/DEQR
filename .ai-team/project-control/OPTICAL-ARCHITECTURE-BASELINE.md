# Optical Architecture Baseline — High-Throughput Program Phase 00

**Date:** 2026-08-29
**Commit:** `c85719a` (`feat(desktop): remediate four transfer UI regressions (DESKTOP-UI-012)`)
**Branch:** `main` — clean (`git status --porcelain` empty, `HEAD == origin/main`)
**Program:** DEQR High-Throughput Optical Transfer Program, Phase 00 — Architecture Freeze and Baseline
**Status:** FROZEN for measurement — no architecture-changing optimization in this phase

This document is the frozen reference for every later High-Throughput phase. Every file:line citation was verified against the tree at `c85719a`.

---

## 1. Sender pipeline — `File -> container -> compression -> segmentation -> FEC -> QR -> scheduler -> canvas`

### 1.1 File selection

- **Renderer entry:** `src/renderer/App.tsx:178` `openPicker(resumeToken?)` calls `window.deqr.streamTransfer.select({ resumeToken, transportProfileId })`.
- **IPC:** `src/main/ipc-handlers.ts:146` `handleTrusted('streamTransfer:select', ...)` validates `resumeToken`/`transportProfileId`, opens file via `src/main/streaming-sender.ts:527` `StreamingTransferSession.open()`.
- **Legacy v1 path (still shipped):** `src/main/session-manager.ts:41` `SessionManager.selectFile()` — `fs.readFileSync` + `serializeContainer` — frozen, used only for loopback and desktop camera receiver.
- **Validation:** filename via `src/core/filename-sanitizer.ts:15` `sanitizeFilename`, blocked extensions via `isBlockedExtension`, empty/size checks against `V2_LIMITS.maxFileBytes` (`src/core/protocol-v2.ts:151` `1n << 64n -1n`), `mtimeMs` freshness re-check at `src/main/streaming-sender.ts:1094` `assertUnchanged`.

### 1.2 DEQR container / manifest

- **v2 manifest is the container.** `src/core/protocol-v2.ts:202` `DeqrV2Manifest` carries `sessionId`, `fileId`, `originalSize` (u64 bigint), `transportSize` (u64), `segmentSizeBytes`, `symbolSizeBytes`, `segmentCount` (u32), `fecProfileId`, `compressionMode`/`compressionParam`, `transportProfileId` (advisory, `src/core/protocol-v2.ts:219`), `sha256` (32 bytes), `filename`, `mimeType`. Serialized by `src/core/protocol-v2.ts:691` `serializeManifestFrame` (magic `D2` at bytes 0-1, `src/core/protocol-v2.ts:41`).
- **v1 container (frozen):** `src/core/container.ts` `serializeContainer` wraps `{ metadata, payload }` with SHA-256; v1 frame header repeats `blockCount`/`blockSize`/`totalPayloadLength` per frame.

### 1.3 Compression (if present)

- **Decision:** `src/core/compression-policy.ts` `decideCompression(originalSize, sample, {threshold, windowBytes, enabled})` — arity has no filename/extension parameter (extension-neutral, proven by test).
- **Sampling:** `src/main/streaming-sender.ts:1309` `sampleCompressibility` reads three 256 KiB windows (0, middle, end) via `gzipSync` level 6, reusing segment buffer.
- **Sizing walk:** `src/main/streaming-sender.ts:594` fused hash+compress via `src/main/window-compressor.ts` `WindowContainerEncoder.measure()`, one pass. Confirmation via `confirmCompression`. Threshold default `0.10` (`src/core/compression-policy.ts:DEFAULT_COMPRESSION_THRESHOLD`).
- **Window:** `src/core/protocol-v2.ts:91` `V2_COMPRESSION_WINDOW { minLog2:16, maxLog2:26, defaultLog2:20 }` → 1 MiB default. Container is `[u32BE length][gzip member]` per window (`src/core/protocol-v2.ts:60`).
- **Level:** `src/main/window-compressor.ts:DEFAULT_COMPRESSION_LEVEL = 6`.

### 1.4 Segmentation & source-block sizing

- **Planner:** `src/core/protocol-v2.ts:636` `planSegmentation({ transportSize, segmentSizeBytes, symbolSizeBytes })` → `SegmentPlan { segmentCount, symbolsPerFullSegment, symbolsInLastSegment }`.
- **Profiles choose sizes:** `src/core/transport-profiles.ts:340` `buildProfile` sets `segmentSizeBytes = symbolSizeBytes * 2048`, `symbolsPerSegment = 2048` (`src/core/transport-profiles.ts:326`). Values:
  - Reliable `src/core/transport-profiles.ts:380` v10 `symbolSizeBytes=239` → segment 489,472 B
  - Balanced `src/core/transport-profiles.ts:398` v18 `symbolSizeBytes=686` → segment 1,404,928 B (default)
  - Turbo `src/core/transport-profiles.ts:414` v24 `symbolSizeBytes=1139` → segment 2,332,672 B
  - Experimental `src/core/transport-profiles.ts:430` v32 `symbolSizeBytes=1920` → segment 3,932,160 B
- **Config:** `src/main/streaming-sender.ts:244` `configFromProfile(profile, runtime)` is the sole authority; `src/main/streaming-sender.ts:273` `DEFAULT_STREAMING_SENDER_CONFIG` is Balanced.

### 1.5 FEC / fountain generation

- **Systematic-first:** `src/core/segment-encoder.ts:126` `symbolInto(symbolId, out)` — `symbolId < sourceSymbolCount` copies source verbatim (`src/core/segment-encoder.ts:150`), else XOR over `repairNeighbors`.
- **Repair rule:** `src/core/segment-encoder.ts:51` `repairNeighbors(symbolId, sourceSymbolCount, soliton)` — PRNG seeded by `symbolId` (`src/core/prng.ts`), degree via `RobustSoliton.sampleDegree`. Sealed by `src/core/protocol-v2.ts:111` `V2_FEC_PROFILE.LT_SYSTEMATIC_ROBUST_SOLITON_V1 = 0x01`.
- **Decoder:** `src/core/segment-decoder.ts:1` zero-XOR on clean channel (writes source straight, `stats().xorBytes==0`), bounded caps: pending equations ≤ K, neighbour refs `12*K+1024` (`src/core/segment-decoder.ts:22`), tracked repair ids `4*K+64`. Shared module (no Buffer/Node) with receiver.

### 1.6 Frame header packing

- **v2 data frame:** `src/core/protocol-v2.ts:182` `V2_DATA_LAYOUT { headerBytes:28, crcBytes:4, overheadBytes:32 }` — offsets `magic0:0, version:2, frameType:3, sessionId:4, fileId:8, segmentIndex:12, symbolId:16, sourceSymbolCount:20, payloadLength:24, frameFlags:26, payload:28`. Serialized by `src/core/protocol-v2.ts:727` `serializeDataFrame` with `bytes: Uint8Array` + CRC-32 (`src/core/crc32.ts`).
- **v1 frame:** `src/core/protocol.ts:7` 20-byte header `{ version:u8, sessionId:u32BE, segmentNumber:u16BE(==0), sequenceNumber:u32BE, blockCount:u16BE, blockSize:u16BE(512), totalPayloadLength:u32BE, checksum:u8(XOR) }` (`src/core/protocol.ts:38`).

### 1.7 QR library, mode, version, ECC, mask

- **Library:** `qrcode@1.5.4` (`package.json:40`), invoked in `src/renderer/qr-render.ts:214` `QRCode.toCanvas(canvas, [{data:payload, mode:'byte'}], { errorCorrectionLevel, version, scale:geometry.moduleScale, margin:quietZoneModules })`.
- **Mode:** byte throughout — payload is `Uint8Array` bytes, never string (`src/renderer/qr-render.ts:27`).
- **Version:** pinned per transfer. `src/renderer/qr-render.ts:161` `resolveQrRenderPlan({frameBytes, eccLevel, budgetCssPx, devicePixelRatio})` calls `src/core/qr-capacity.ts:129` `smallestVersionFor` or `input.version` from profile. Version constant for whole transfer (paint plan held in `StreamTransferView.tsx:232` `planRef`).
- **ECC:** `L` for all profiles (`src/core/transport-profiles.ts:345` `eccLevel:'L'`), measured worse at H (`PHASE-04 report` §ECC).
- **Mask:** auto by `qrcode` library (QR spec mask selection, not exposed).
- **Quiet zone:** `src/core/qr-capacity.ts:113` `QR_QUIET_ZONE_MODULES=4` (spec minimum).

### 1.8 Canvas / render path

- **Integer scale, whole pixels:** `src/core/qr-capacity.ts:165` `planQrGeometry({version, budgetCssPx, devicePixelRatio})` computes `moduleScale = floor(budgetDevicePx / totalModules)`, `pixelSize = totalModules*moduleScale`, `cssSize = pixelSize / devicePixelRatio`. No division of budget by modules.
- **Budget:** `src/renderer/qr-render.ts:50` `QR_BUDGET_MAX_CSS_PX=480`, `src/renderer/qr-render.ts:61` `MIN=160`, `src/renderer/qr-render.ts:103` `QR_VIEWPORT_RESERVED_CSS_PX=340`, `src/renderer/qr-render.ts:122` `measureQrBudget(canvas)` reads `stage.clientWidth - padding` and `window.innerHeight - 340`, clamped via `chooseQrBudget`.
- **Apply:** `src/renderer/qr-render.ts:194` `applyCanvasGeometry(canvas, geometry)` sets `canvas.width/height = pixelSize` and `style.width/height = cssSize + 'px'` — no browser resample.

### 1.9 Scheduling primitive

- **Not `setInterval` / `rAF`:** `src/renderer/qr-frame-scheduler.ts:35` `SchedulerClock { now(), setTimer, clearTimer }` backed by `setTimeout` (`src/renderer/qr-frame-scheduler.ts:59`), injected for testability.
- **Class:** `src/renderer/qr-frame-scheduler.ts:122` `QrFrameScheduler(profile, source, paint, clock, options)` — `intervalMs = max(1000/targetFps, minFrameHoldMs)` (`src/renderer/qr-frame-scheduler.ts:162`), bounded prefetch `maxPrefetchedFrames=2` (`src/renderer/qr-frame-scheduler.ts:117`), queue via `FrameSource.next(): Promise<Uint8Array|null>`.
- **Backpressure:** pull-only — `fill()` called only from `take()`/`tick()`, `stop()` cancels timer and drops queue (`src/renderer/qr-frame-scheduler.ts:203`), `tick()` re-checks liveness, `pause()`/`resume()` fence.

### 1.10 Configured vs actual presentation FPS

- **Configured:** profile `targetFps` (10,12,15,20) and `minFrameHoldMs` (100,83,66,50) (`src/core/transport-profiles.ts:132/140`). Effective via `src/core/transport-profiles.ts:188` `effectiveFps(profile) = 1000 / max(1000/targetFps, minFrameHoldMs)` — identical to scheduler's `intervalMs`.
- **Actual:** `QrFrameScheduler.stats()` `effectiveFps` measured as `(spans*1000)/elapsedMs` (`src/renderer/qr-frame-scheduler.ts:217`), with `framesPainted`, `elapsedMs`, `totalPaintMs`, `maxPaintMs`, `health` (`idle|healthy|degraded|starved|finished`).

### 1.11 Pause / resume / cancel

- **Sender:** `StreamTransferView.tsx:320` `scheduler.pause()` / `resume()` derived from `sender-state.ts` `SENDER_STATE`; `App.tsx:248` cancel via `window.deqr.streamTransfer.cancel(sessionId)` → `src/main/ipc-handlers.ts:215` `handleTrusted('streamTransfer:cancel')` → `src/main/streaming-session-registry.ts` `dispose()`. IPC guarded by `src/main/ipc-sender-policy.ts`.
- **Hold resets estimators:** `src/renderer/sender-model.ts:183` `EtaEstimator.reset()` and `src/renderer/sender-model.ts:279` `OpticalRateMeter.reset()` on pause.

---

## 2. Receiver pipeline — `Camera -> capture -> worker -> pipeline -> store -> verify -> export`

### 2.1 Camera constraints requested

- `mobile-web/src/camera.ts:123` `getUserMedia({ audio:false, video:{ facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720} } })`. Must be from user gesture on iOS (enforced by caller).

### 2.2 Actual camera settings observed

- `mobile-web/src/camera.ts:291` `region()` reads `video.videoWidth/videoHeight` (live). Not `getSettings()` — ROI derived from delivered frame size.

### 2.3 rAF / rVFC usage

- `mobile-web/src/camera.ts:211` `schedule(generation)` — if `video.requestVideoFrameCallback` exists, arms it + a `PRESENT_WATCHDOG_MS=500` timer (`mobile-web/src/camera.ts:53`); first-to-fire cancels other. Fallback to `SCAN_INTERVAL_MS=40` timeout (`mobile-web/src/camera.ts:43`). `onVideoFrame` handles `document.hidden` with keep-alive (`mobile-web/src/camera.ts:236`). Preserves `generation` to fence stale callbacks.

### 2.4 ROI logic

- `mobile-web/src/camera.ts:291` `region()` → `sourceEdge = floor(min(W,H)*0.86)`, `roiEdge = min(720, sourceEdge)` (`mobile-web/src/camera.ts:44` `MAX_ROI_EDGE=720`), reject if `<96` (`MIN_ROI_EDGE=96`). Returns `{ sourceX, sourceY, sourceEdge, roiEdge }` = centered square.

### 2.5 QR decoder

- `mobile-web/src/receive-worker-core.ts:62` `import jsQR from 'jsqr'`, invoked at `mobile-web/src/receive-worker-core.ts:259` `jsQR(image.data, width, height, {inversionAttempts:'dontInvert'})`. Synchronous.
- **Observation:** `mobile-web/src/receive-worker-core.ts:463` `observationOf(code, captureEdgePx, captureScale)` derives `pxPerModule = symbolSpanPx / modulesPerSide` (quiet zone excluded), `spanSkew`, `captureScale`. Turns camera density from swept param into measured field.

### 2.6 Worker architecture

- **Client:** `mobile-web/src/receiver-client.ts:141` `ReceiverClient(callbacks, { createWorker, maxInFlight, limits })` — owns worker lifecycle, epochs file for stale suppression, `open()/close()/submit()/verify()/dispose()`.
- **Worker:** `mobile-web/src/receive-worker-core.ts:96` `ReceiveWorker(post, staleFrameMs, wallClock, pipelineOverrides)` — `STALE_FRAME_MS=250` (`mobile-web/src/receive-worker-core.ts:89`), `OffscreenCanvas` bitmap path (`mobile-web/src/receive-worker-core.ts:94`), progress throttled `PROGRESS_INTERVAL_MS=120` (`mobile-web/src/receive-worker-core.ts:79`).
- **Pipeline:** `mobile-web/src/receive-pipeline.ts:374` `ReceivePipeline(options)` — dedupe, protocol routing, segmented recovery, storage, verification.

### 2.7 In-flight decodes & queue/drop policy

- **Bound location:** client, not worker. `mobile-web/src/receiver-client.ts:192` `canAccept()` = `opened && !disposed && worker!==undefined && inFlight < maxInFlight`. `DEFAULT_MAX_IN_FLIGHT = RECEIVER_POLICY.maxFramesInFlight = 2` (`mobile-web/src/receiver-client.ts:115`, `src/core/receiver-policy.ts:206`). Justification: one decoding + one queued saturates jsQR (60-90 ms) vs capture (single-digit ms).
- **Every frame gets terminal event** — including stale/closed (`mobile-web/src/receive-worker-core.ts:231` stale path still `emitFrame(..., STALE)`). Prevents slot leak / deadlock.
- **Capture asks first:** `mobile-web/src/camera.ts:250` `if (!target.canAccept()) { recordSkippedBusy(); setTimeout(BACKPRESSURE_RETRY_MS=12); return; }` — costs one timer, no `drawImage`/`getImageData`/`createImageBitmap`.
- **Stale drop:** worker drops if `age = wallClock - capturedAt > 250ms` without decoding (`mobile-web/src/receive-worker-core.ts:238`).

### 2.8 Frame parsing

- `mobile-web/src/receive-pipeline.ts:465` `submit(bytes)` — length check vs `RECEIVER_POLICY.maxFrameBytes` before fingerprint, `frameFingerprint` → dedupe `has()` → `detectProtocolVersion` → `submitV2` / `submitV1` / `NOT_DEQR`. V2 path validates `parseFrame` + `validateDataFrameAgainstManifest` + CRC, then `SegmentedReceiver.receive`.
- **V1 path:** delegates to `mobile-web/src/protocol.ts:131` `ReceiverSession.receive()` (fountain LT + hash gate).

### 2.9 Duplicate handling

- **Early dedupe:** `mobile-web/src/frame-dedupe.ts:67` `BoundedFingerprintSet(capacity=4096)` — FNV-1a x2 → 53-bit key (`mobile-web/src/frame-dedupe.ts:45`), ring buffer O(1) eviction. Hit returns `FRAME_OUTCOME.DUPLICATE` before parser/CRC/FEC.
- **Session dedupe:** `SegmentDecoder` bitmap + `SegmentedReceiver` committed-bit test (`src/core/segmented-receiver.ts`).

### 2.10 FEC / fountain solve

- **Per-segment decoders:** `src/core/segmented-receiver.ts:10` at most `maxActiveSegments=2` alive, `src/core/segment-decoder.ts:12` systematic placement + repair elimination, bounded work caps (see §1.5). Committed segment bytes transferred to sink, decoder dropped, later frames cost one bit test.
- **Recovery tail:** sender `src/main/streaming-sender.ts:966` `produceRecoverySymbol()` batched per segment, systematic-first, monotonic `symbolId` via `recoveryNextSymbolId`. See §5.

### 2.11 Completion & integrity verification

- **Completion:** `ReceivePipeline.progress()` `complete` when all segments committed. `complete` blocks further `submit`.
- **Verification trigger:** `mobile-web/src/receiver-client.ts:241` `verify()` posts `{type:'verify', epoch}`; worker `mobile-web/src/receive-worker-core.ts:317` `onVerify` awaits `pipeline.verify()` epoch-fenced.
- **v2 verify:** `mobile-web/src/receive-pipeline.ts:970` — for uncompressed, `Sha256Stream` over `original.part` via `opfs-segment-store`; for compressed, `inflate-verify.ts` expands `data.part → original.part` window-by-window then hashes. Yields `verified` event only if `sameDigest`; otherwise `failed(HASH_MISMATCH)`.
- **Display rule:** `src/shared/transfer-ui-state.ts` `claimsIntegrityVerified(phase)` true only for `VERIFIED`/`EXPORTING`; receiver `COMPLETE` is sole state reaching it.

### 2.12 Received-file save flow

- `mobile-web/src/export.ts` — `navigator.share({files:[File]})` first, fallback to `URL.createObjectURL` + anchor download. `File` references OPFS entry via `getFile()` on sync handle, no payload byte crosses back to main thread on v2. Allowlist `isReceiverSessionFile` = `data.part` + `original.part` only (`src/core/receiver-policy` / `mobile-web/src/opfs.ts`).

---

## 3. Performance-sensitive constants (frozen for this program)

| Constant | Value | Source |
|---|---|---|
| **Bytes per QR (payload)** | 239 / 686 / 1139 / 1920 | `src/core/transport-profiles.ts:380/398/414/430` `symbolSizeBytes` |
| **Frame bytes on wire** | payload + 32 | `src/core/transport-profiles.ts:168` `frameBytesFor`, `src/core/protocol-v2.ts:198` `overheadBytes:32` |
| **Source block size** | = `symbolSizeBytes` | `src/main/streaming-sender.ts:256` `symbolSizeBytes` param to `SegmentEncoder` |
| **QR version** | 10 / 18 / 24 / 32 | `src/core/transport-profiles.ts:386/405/418/433` |
| **ECC level** | L (all profiles) | `src/core/transport-profiles.ts:345` |
| **Quiet-zone width** | 4 modules | `src/core/qr-capacity.ts:113` |
| **FPS (target)** | 10 / 12 / 15 / 20 | `src/core/transport-profiles.ts:388/406/422/440` `targetFps` |
| **FPS (min hold)** | 100 / 83 / 66 / 50 ms | `src/core/transport-profiles.ts:389/407/423/441` `minFrameHoldMs` |
| **FPS (effective)** | `min(targetFps, 1000/minHold)` | `src/core/transport-profiles.ts:188` + `src/renderer/qr-frame-scheduler.ts:162` |
| **Worker count / in-flight** | 1 worker, 2 frames in-flight | `mobile-web/src/receiver-client.ts:115` / `src/core/receiver-policy.ts:206` |
| **ROI size** | ≤720 edge, 86% center square, ≥96 | `mobile-web/src/camera.ts:44/45/296` |
| **Repair budget** | 1.00 / 0.75 / 0.75 / 0.75 | `src/core/transport-profiles.ts:392/408/424/442` `repairOverheadRatio` |
| **Design loss** | 0.30 / 0.20 / 0.20 / 0.20 | `src/core/transport-profiles.ts:393/409/425/443` |
| **Segment limits** | 64 KiB .. 64 MiB | `src/core/protocol-v2.ts:144-145` `V2_LIMITS` |
| **Symbols/segment** | 2048 (all profiles) | `src/core/transport-profiles.ts:326` |
| **Segment size** | 489,472 / 1,404,928 / 2,332,672 / 3,932,160 | derived `symbolSizeBytes*2048` |
| **Sender queue depth** | 32 frames ready, 2 prefetched | `src/main/streaming-sender.ts:225` `frameQueueCapacity:32` / `src/renderer/qr-frame-scheduler.ts:117` `maxPrefetchedFrames:2` |
| **Camera requested res** | 1280×720 ideal, environment facing | `mobile-web/src/camera.ts:126` |
| **Camera FPS cap** | ~11-20 FPS scan ceiling (jsQR 48-67 ms @ 720²) | `scripts/bench/phase04-qr-profiles.ts` `PHASE04_CPU` (this baseline §4.3) |
| **Manifest interval** | 64 frames | `src/main/streaming-sender.ts:226` `manifestIntervalFrames:64` |
| **Checkpoint budget** | 3 sessions, 24h, 810 B @ 4 GiB | `src/core/receiver-policy.ts:189/191` / `mobile-web/ARCHITECTURE.md` |

---

## 4. Finite-repair-tail risk — reconfirmed

**Previous risk (pre-Phase-13):** `StreamingTransferSession.take()` returned `null` once the budgeted repair was emitted, leaving a receiver short by one symbol with no source for it. `RECEIVING` had no `STALLED` exit; receiver held two decoders, so second pass restarted rather than topped up. Proved by `PHASE-13 report` §2 and `IOS-PHYSICAL-TRANSFER-ROOT-CAUSE.md`.

**Current evidence (c85719a):**

- **Pass terminates, recovery does not:** `src/main/streaming-sender.ts:1039` `advanceToPendingSymbol()` sets `done=true` when `segmentIndex >= plan.segmentCount`. `src/main/streaming-sender.ts:799` `take()` returns `null` only after `fill()` finds no `produce()` frame. **But** `src/main/streaming-sender.ts:898` `beginRecovery(targetSegments?)` clears `done=false`, sets `phase='recovery'`, populates `recoveryTargets` (all segments or targeted gaps). `src/main/streaming-sender.ts:966` `produceRecoverySymbol()` then generates unbounded frames with monotonic `recoveryNextSymbolId` (`src/main/streaming-sender.ts:1015`) — so novel repair opportunities are infinite.
- **Systematic-first recovery:** batch replays source symbols before fresh repair (`src/main/streaming-sender.ts:984`) — repair-only would saturate decoder caps (`pending equations ≤ K`) and is proven irrecoverable at 1.5×/2.5×/4× overhead.
- **Auto-rollover on display:** `src/renderer/components/StreamTransferView.tsx:193` pass exhaustion auto-calls `window.deqr.streamTransfer.beginRecovery(sessionId)` and continues emitting — user not required to press button. Manual recovery also available via `src/main/ipc-handlers.ts:196` `streamTransfer:beginRecovery`.
- **Receiver stall detection:** `mobile-web/src/receiver-client.ts` epoch fencing + `src/core/receiver-policy.ts:227` `stallAfterSilentMs=12_000` + `mobile-web/src/receive-pipeline.ts:405` `lastUniqueFrameAtMs` — `RECEIVING` now has `STALLED` transition to `INCOMPLETE`.

**Verdict:** finite tail removed. Any `nextFrame()`/`take()` termination is the *pass* ending, not the transfer. Verification of infinite repair is unbounded generation + systematic-first batches; proof is `phase11-certification --maxPasses` and `PHASE-13 recovery tests` (40/40 repairs still irrecoverable without systematic, systematic batches complete).

---

## 5. Shipping UI and behavior (preserved)

- **Desktop:** `src/renderer/App.tsx:303` drives `streamTransfer` (v2) end-to-end; `StreamTransferView.tsx` renders QR via `QRScheduler` + `paintQrFrame`. States via `src/renderer/sender-state.ts` (10 states, derived `SENDER_PHASES` without `VERIFIED`). Preflight shows both `originalSize` and `transportSize`, profile card, resume token entry. No v1 transfer remains reachable from live send.
- **Receiver:** `mobile-web/src/App.tsx` camera/receiving/verify/complete flows, `receiver-state.ts` single authoritative state machine, `receiver-view-model.ts` derived copy.

Commit `c85719a` introduced no protocol/FEC change — `streaming-sender.ts` recovery tail byte-identical to `bcccc66`.

---

## 6. Physical certification status

`BLOCKED — PHYSICAL DEVICE REQUIRED`. No camera-to-screen optical transfer has been executed from `c85719a`. Certified max size remains **0 bytes**. Matrix at `.ai-team/reports/performance/PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md` — all 7 gates PENDING. `physicallyCertified=false` for all profiles (`src/core/transport-profiles.ts:158`).

---

## 7. Evidence locations

- Bench JSON: `.local-run/bench/desktop-pwa-pipeline-ht-phase00-baseline.json`, `.local-run/bench/phase11/phase11-ladder-ht-phase00-baseline.json`, `...-ht-phase00-5mib.json`, `.local-run/bench/qr-frame-roundtrip-ht-phase00-baseline.json`, `PHASE04_CPU` log
- Reports: `.ai-team/reports/performance/PHASE-11-BENCHMARK-CERTIFICATION-REPORT.md`, `PHASE-04-QR-TRANSPORT-PROFILES-REPORT.md`
- Protocol spec: `.ai-team/engineering/PROTOCOL-V2.md`, `mobile-web/ARCHITECTURE.md`
