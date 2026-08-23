# PHASE-04 — Physical Device Test Matrix and Telemetry Schema

**Status**: **PENDING — NOT EXECUTED.** No physical iPhone is available. Nothing in this document has been run, and no number in it is a result.

This exists because Phase 04 selected transport profiles from a *simulated* camera and one physical constant remains unmeasured. It is the instruction set for closing that gap, written now while the reasoning is fresh, to be executed by Phase 11.

---

## 1. The one number this matrix exists to measure

**Camera pixels per QR module, at a realistic scanning distance.**

Phase 04 measured decode success against that variable and found it dominates everything else — QR version, ECC level, and payload size are all downstream of it. What was never measured is which value a real iPhone achieves in a real room. Every profile in `src/core/transport-profiles.ts` declares the density it needs; this matrix finds out whether a phone supplies it.

The derived quantity is simple and needs no instrumentation to compute:

```
cameraPxPerModule = (symbol width in captured pixels) / (moduleCount + 2 × quietZone)
```

The receiver can report the first term directly — jsQR returns the symbol's corner locations in the captured frame — so this is an observation, not an estimate.

| Profile | Modules incl. quiet zone | Needs px/module | Symbol must span |
|---|---|---|---|
| Reliable | 65 | 2.5 | 163 px |
| Balanced | 97 | 4 | 388 px |
| Turbo | 121 | 5 | 605 px |
| Experimental | 153 | 5 | 765 px — **above a 720-line capture; needs 1080p or better** |

---

## 2. Matrix

Every cell is one transfer of the **same 8 MiB file**, so verified throughput is directly comparable. Run the full ladder before changing any other variable.

### 2.1 Primary — profile against distance

| Run | Profile | Sender window | Distance | Purpose |
|---|---|---|---|---|
| P1 | Reliable | Full screen | 60 cm | Lower bound: does the least demanding profile work at a comfortable distance |
| P2 | Balanced | Full screen | 60 cm | The default, at the distance a user would naturally pick |
| P3 | Balanced | Full screen | 30 cm | Does closing the distance move it from marginal to clean |
| P4 | Balanced | Windowed | 60 cm | Cost of not being full screen |
| P5 | Turbo | Full screen | 30 cm | Best case for the fastest selectable profile |
| P6 | Turbo | Full screen | 60 cm | Where Turbo is expected to fall over — 100% to 62% decode between 5 and 4 px/module in simulation |
| P7 | Experimental | Full screen | 30 cm | Expected to fail below 1080p capture; run to confirm the ceiling is where it was calculated |

### 2.2 Secondary — conditions, at Balanced only

Run these only after the primary ladder, and only at Balanced, so one variable moves at a time.

| Run | Variable | Setting |
|---|---|---|
| C1 | Display brightness | 25% |
| C2 | Display brightness | 100% |
| C3 | Ambient light | Dim room |
| C4 | Ambient light | Bright, sunlit |
| C5 | Angle | 30° off-axis |
| C6 | Motion | Handheld, unsupported |
| C7 | Screen | External monitor rather than laptop panel |

### 2.3 Cadence — the measurement most likely to overturn a Phase 04 choice

Target FPS was set conservatively (10/12/15/20) because measured jsQR scan time over a 1280×720 frame was 60–93 ms — an 11–17 FPS ceiling — and **the receiver's scan rate, not the display's refresh, is the binding constraint**. That measurement was taken in Node with node-canvas, and the real capture pipeline does not exist until Phase 05.

| Run | Profile | Target FPS | Purpose |
|---|---|---|---|
| F1 | Balanced | 8 | Below the profile default; confirms slower is not better |
| F2 | Balanced | 12 | Profile default |
| F3 | Balanced | 20 | Above the simulated scan ceiling |
| F4 | Balanced | 30 | Well above it; expected to lose frames rather than gain throughput |

**The rule from the plan applies literally: a higher animation FPS is not a success if verified payload throughput falls.** F3 and F4 pass only if `verifiedBytesPerSecond` rises.

---

## 3. Telemetry schema

Every counter below already exists in shipping code. Nothing new needs building to record a run — this is the shape to export, not a system to write.

```jsonc
{
  "run": "P2",                        // matrix cell
  "startedAt": "2026-08-21T10:00:00Z",
  "device": {
    "model": "iPhone …",              // from the user, not sniffed
    "os": "iOS …",
    "captureWidth": 1280,             // MediaStreamTrack settings, as negotiated
    "captureHeight": 720,
    "captureFrameRate": 30
  },
  "sender": {
    "profileId": 2,                   // DeqrV2Manifest.transportProfileId
    "profileName": "Balanced",
    "windowMode": "fullscreen",
    "moduleScale": 4,                 // QrRenderGeometry.moduleScale
    "symbolPixelSize": 388,           // QrRenderGeometry.pixelSize
    "devicePixelRatio": 2,
    "scheduler": { /* SchedulerStats verbatim */ }
  },
  "environment": {
    "distanceCm": 60,
    "displayBrightnessPercent": 100,
    "ambient": "office",
    "angleDegrees": 0,
    "handheld": false
  },
  "observed": {
    "symbolSpanPx": 402,              // jsQR corner locations, captured frame
    "cameraPxPerModule": 4.14,        // symbolSpanPx / totalModules — the number
    "capturedFramesPerSecond": 29.4,
    "decodedFramesPerSecond": 11.8,
    "uniqueAcceptedFramesPerSecond": 11.1,
    "duplicateFrameRatio": 0.06,
    "malformedFrameRatio": 0.00,
    "decodeLatencyMsP50": 48,
    "decodeLatencyMsP95": 91
  },
  "receiver": {
    "stats": { /* SegmentedReceiverStats verbatim */ },
    "segmentsCommitted": 6,
    "symbolsRepaired": 812,
    "xorBytes": 415744
  },
  "result": {
    "completed": true,
    "wallClockSeconds": 1840,
    "originalBytes": 8388608,
    "sha256Matched": true,
    "verifiedBytesPerSecond": 4559    // originalBytes / wallClockSeconds
  }
}
```

### 3.1 Where each field comes from

| Field group | Source | Exists today |
|---|---|---|
| `sender.scheduler` | `QrFrameScheduler.stats()` | Yes — `src/renderer/qr-frame-scheduler.ts` |
| `sender.moduleScale`, `symbolPixelSize` | `QrRenderGeometry` | Yes — `src/core/qr-capacity.ts` |
| `sender.profileId` | v2 manifest byte 43 | Yes — `PROTOCOL-V2.md` 4.4 |
| `receiver.stats` | `SegmentedReceiver.stats()` | Yes — `src/core/segmented-receiver.ts` |
| `receiver.symbolsRepaired`, `xorBytes` | `SegmentDecoderStats` | Yes — `src/core/segment-decoder.ts` |
| `observed.symbolSpanPx` | jsQR `location` corners | Yes — `mobile-web/src/receive-worker-core.ts` (Phase 05) |
| `observed.*FramesPerSecond`, latency percentiles | Capture pipeline | Yes — `mobile-web/src/metrics.ts` (Phase 05) |
| `result.*` | Transfer completion | Partly; wall-clock accounting is Phase 09 |

**Both capture-side blockers are cleared as of Phase 05 (2026-08-21).** `OpticalObservation` carries `symbolSpanPx`, `pxPerModule`, `spanSkew` and `captureScale` on every decoded frame, and `TelemetryCollector` reports capture attempts/sec, decoded/sec, unique/sec, duplicate ratio, decode and pipeline p50/p95, in-flight depth, skipped-busy and dropped-stale counts. See `PHASE-05-PWA-CAPTURE-WORKERS-REPORT.md` §7.

**One unit rule this matrix must follow.** `symbolSpanPx` is measured over the QR symbol *excluding* its quiet zone, because that is where jsQR's corners sit, so `pxPerModule` divides by `qrModuleCount(version)` and **not** by the quiet-zone-inclusive `minCameraSymbolPx` in the profile table. Comparing the observed span against `minCameraSymbolPx` directly under-reports density by about 18% and would fail profiles that were in fact being met.

**One row still outstanding.** `result.*` wall-clock accounting is Phase 09's. It does not block a run: a certification pass can be timed externally.

---

## 4. Pass criteria

A profile is **physically certified** when, over three independent runs of its primary cell:

1. The transfer completes and SHA-256 matches. Non-negotiable.
2. `observed.cameraPxPerModule` meets or exceeds the profile's declared `minCameraPxPerModule`.
3. Frame loss — `1 − decodedFramesPerSecond / capturedFramesPerSecond` — stays at or below the profile's `designLossRate`.
4. `verifiedBytesPerSecond` is within 25% of `expectedVerifiedBytesPerSecond(profile, observedLoss)`. A larger gap means the model in `transport-profiles.ts` is wrong about something and should be corrected rather than explained away.
5. No wrong decodes. Simulation produced zero across every run; a single one on a device is a finding, not noise, even though the frame CRC would reject it.

Until then `physicallyCertified` stays `false` for every profile, which is what the code says today.

---

## 5. What would falsify a Phase 04 decision

Written down in advance, so the matrix can disprove something rather than confirm it.

- **If real phones deliver 6+ px/module at 60 cm**, then Balanced is too conservative and Turbo should be the default. Simulation could not see this because it never had a real lens.
- **If real capture is 1080p or 4K by default**, decode cost rises with frame area and the FPS targets are too high, not too low — and Experimental's 765 px symbol becomes viable at the same time. These pull in opposite directions and only a device settles it.
- **If ECC L proves fragile on glossy or low-brightness screens**, the Phase 04 finding that ECC buys nothing was an artefact of a noise model with no specular highlights. The finding was that *sampling* fails before *codewords* do; a real reflection damages codewords in a way uniform noise does not.
- **If decode succeeds well below the declared px/module**, the simulated capture model is too pessimistic — likely the uniform grey background, which is a harder finder-pattern search than a real bezel-framed screen. Every profile could then move up a version.
