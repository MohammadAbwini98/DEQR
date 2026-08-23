# PHASE-04 — QR Optical Transport Profiles and Frame Scheduling

**Program**: DEQR Large-File / Maximum-Speed Program
**Phase**: 04 (transport profiles, render quality, frame scheduling — no receiver capture work, no transfer UX)
**Date**: 2026-08-21
**Verdict**: **PASS** — every gate criterion is met with executed evidence. Physical certification is explicitly **PENDING** and is tied to Phase 11, per the plan's own instruction not to invent device results. Seven deviations are stated in §8.

---

## 1. Headline

**The QR version that maximises throughput is decided almost entirely by one physical number nobody has measured: camera pixels per module.**

Capacity says version 40 carries twelve times what version 10 does. Decode says otherwise. Measured against a simulated camera at ECC L, 60 independent frames per cell:

| Camera px per module | v10 | v18 | v24 | v32 | v40 |
|---|---|---|---|---|---|
| 2.5 | **0.88** | 0.23 | 0.32 | 0.03 | 0.05 |
| 3 | 0.83 | 0.67 | 0.63 | 0.42 | 0.38 |
| 4 | 0.95 | **0.83** | 0.62 | 0.67 | *too large for frame* |
| 5 | 1.00 | 0.98 | **1.00** | *too large* | *too large* |

Compose that with Phase 03's measured repair curve — a failed decode is a lost frame, a lost frame costs repair overhead, and repair overhead costs time — and at 3 px per module **only version 10 is usable at all**: every other version loses more than the 30% Phase 03 measured, and above that the repair requirement is not something this program is willing to extrapolate.

So the profiles are separated by what they ask of the camera, not by how much they can carry:

| Profile | QR | Payload/frame | FPS | Needs px/module | Verified B/s at that density |
|---|---|---|---|---|---|
| Reliable | 10 | 239 B | 10 | 2.5 | 1,396 |
| **Balanced** *(default)* | 18 | 686 B | 12 | 4 | **4,795** |
| Turbo | 24 | 1,139 B | 15 | 5 | 17,085 |
| Experimental | 32 | 1,920 B | 20 | 5 | *symbol exceeds a 720-line capture* |

For comparison, v1 ships 512 B at 10 FPS — a **nominal** 5,120 B/s that assumes zero loss and carries no repair budget at all. Balanced's 4,795 B/s is a *verified* figure that survives the 17% frame loss measured at its design density.

---

## 2. What was built

| Artifact | Location | Purpose |
|---|---|---|
| Capacity and geometry | `src/core/qr-capacity.ts` | All 40 versions × 4 ECC levels, derived from the encoder; integer module-scale planning |
| Transport profiles | `src/core/transport-profiles.ts` | The four profiles, the measured surface they were read off, and a validator |
| Frame scheduler | `src/renderer/qr-frame-scheduler.ts` | Pull-based, bounded prefetch, hold floor, instrumented, clock-injectable |
| Render path | `src/renderer/qr-render.ts` | Version pinning, integer scaling, canvas geometry |
| Shipping renderer | `src/renderer/components/QRCanvas.tsx`, `styles/index.css` | Uses the above; the CSS no longer resamples the canvas |
| Profile → sender | `src/main/streaming-sender.ts` | `configFromProfile` is now the only place symbol, segment and repair are decided |
| Protocol | `src/core/protocol-v2.ts`, `PROTOCOL-V2.md` §4.4 | Manifest byte 43: `reserved` → `transportProfileId`, advisory |
| Benchmark | `scripts/bench/phase04-qr-profiles.ts` | Capacity, CPU, optical robustness, goodput |
| Physical matrix | `PHASE-04-PHYSICAL-TEST-MATRIX.md` | The runs Phase 11 executes, and the telemetry shape |
| Tests | 4 new files | 90 tests |

---

## 3. Acceptance gate

| Gate criterion | Status | Evidence |
|---|---|---|
| Balanced is selected from measurements, not intuition | **MET** | Chosen off the surface in §1; `transport-profiles.test.ts` asserts each profile's declared density decodes within its design loss, against the table in the source |
| Profile system exists | **MET** | Four named, versioned profiles declaring QR version, ECC, payload bytes, FPS, hold time, repair policy and camera expectations; validated as data |
| Benchmark harness exists | **MET** | Four modes; deterministic replayable frame sets built by the real v2 serializer |
| Visual QR correctness tests pass | **MET** | Every profile renders and decodes byte-exactly; every module block is uniform; the quiet zone is asserted white on all four sides |
| No unbounded frame pre-generation | **MET** | Scheduler prefetch is bounded and asserted; v2 sender queue was already capped at 32; v1 renderer holds one frame |
| Turbo fails back or instructs clearly | **MET, in the second form** | There is no back channel, so nothing can fail back automatically. `downgradeFrom` is the machine-readable instruction; §8.5 |
| Certification tied to Phase 11 | **MET** | `physicallyCertified` is `false` for every profile, asserted by a test; matrix prepared and marked PENDING |

---

## 4. The measurements

### 4.1 Capacity is derived, not typed

`QR_BYTE_CAPACITY` covers all 40 versions at all 4 ECC levels, produced by binary-searching what `QRCode.create` actually accepts. `tests/core/qr-capacity.test.ts` probes the exact boundary for all 160 cells — the tabulated capacity must be accepted and one more byte refused. A table that drifts from its encoder turns a profile definition into a runtime throw on one frame in a thousand.

### 4.2 ECC buys nothing the failure mode consumes

Holding the version fixed and walking L → M → Q → H:

| | v20 @ 3px | v20 @ 4px | v28 @ 3px | v28 @ 4px | Payload at v20 |
|---|---|---|---|---|---|
| L | 0.58 | 0.65 | 0.52 | 0.55 | 826 B |
| M | 0.62 | 0.67 | 0.52 | 0.60 | 634 B |
| Q | 0.60 | 0.65 | 0.52 | 0.55 | 450 B |
| H | 0.57 | 0.60 | 0.45 | 0.55 | 350 B |

At most five percentage points across the whole range, and **H is consistently worse than L** — while costing 58% of the payload. The reason is that at low sampling density the decoder cannot resolve the module grid at all, and error correction does not repair a grid that was never read. Every profile is ECC L, and that is a measurement rather than a shortcut.

### 4.3 The receiver's scan rate is the binding constraint, not the display

Decoding a 1280×720 frame with jsQR, which is what the receiver actually runs:

| Version | Encode ms | jsQR scan ms | Scan ceiling |
|---|---|---|---|
| 10 | 6.1 | 59.9 | 16.7 FPS |
| 20 | 7.6 | 59.4 | 16.8 FPS |
| 28 | 11.3 | 70.6 | 14.2 FPS |
| 36 | 18.3 | 92.9 | 10.8 FPS |
| 40 | — | — | *740 px symbol exceeds a 720-line frame* |

Two things fall out. **Decode costs four to eight times what encode costs**, so the sender is not the limiter. And **decode cost is dominated by the camera frame size, not the QR version** — a 1.55× spread from v10 to v36 once the frame is fixed.

That second point was nearly missed. Measured against a crop that grew with the version, the spread looked like 5.5× and the v40 ceiling looked like 11 FPS; both were artefacts of decoding an image no phone would ever be handed. A phone decodes a fixed-size video frame with the symbol somewhere in it.

### 4.4 Composition, which is the actual decision rule

The plan's rule is blunt: *never select a profile because it displays the most frames per second*. Implemented literally:

```
goodput = symbolBytes × min(targetFps, encodeCeiling, scanCeiling) / (1 + requiredRepairRatio(1 − successRate))
```

`requiredRepairRatio` is Phase 03's measured curve and **returns null above 30% loss rather than extrapolating**, so a combination that would need a guessed repair budget is reported as unusable rather than as slow. That is why, at 3 px per module, seven of the eight measured versions have no goodput number at all.

### 4.5 Zero wrong decodes

Across every optical run — thousands of degraded captures — jsQR never once returned bytes that differed from what was encoded. It either decoded exactly or returned nothing. The frame CRC would have caught a wrong decode anyway, and the harness counts them separately rather than averaging them into a success rate, precisely because a silent wrong decode is a far worse failure than a miss.

---

## 5. Render quality: three resamples removed

The shipping renderer asked `qrcode` for a 400-pixel-wide symbol. A version-18 frame is 97 modules including its quiet zone, and 400 ÷ 97 is **4.12 device pixels per module**: most modules get four, roughly one in eight gets five, and every edge in the symbol lands on a fractional boundary. The canvas was then presented at a CSS width the browser resampled again, and on a HiDPI display a third resample followed.

The fix multiplies instead of dividing — an integer module scale, a canvas sized `totalModules × scale`, and an explicit CSS size of `pixelSize ÷ devicePixelRatio` so the browser maps one module to a whole number of device pixels.

This is proven both ways. `every module block is uniform` checks that all `scale × scale` pixels of every module share one value — a single non-uniform block is a fractional boundary — and it **passes on the new path and fails on the old one**, in the same test. The new symbol is 388 px against the old 400: slightly smaller, and entirely on pixel boundaries.

The version is resolved once per transfer and pinned. Beyond saving an encode per frame, it stops the symbol changing size mid-stream, which would make a camera re-acquire its framing every time the payload crossed a capacity boundary.

**This lands on the v1 path that ships today**, and a test covers the real 532-byte v1 frame, not only the v2 profiles.

---

## 6. Scheduling

`QrFrameScheduler` replaces an interval with something that can be asserted:

- **Pull, never push.** Frames are requested when the scheduler is ready to paint one, so a slow painter slows the encoder because nothing else drives it — the same backpressure shape Phase 02 built into the sender.
- **A hold floor.** `minFrameHoldMs` is a floor on screen time, separate from the frame interval, because a camera integrates over an exposure and a frame swapped out sooner than the sensor can gather it is a frame nobody reads. When target and hold disagree, the hold wins and the effective cadence is derived rather than assumed.
- **Bounded prefetch**, asserted: requests never exceed paints plus the bound.
- **Measured cadence.** `effectiveFps` is computed from painted frames over wall time, spanning gaps rather than instants. Phase 00 established that nominal FPS is not throughput; this is where the display stops claiming otherwise.
- **No catch-up bursts.** After a stall the deadline resets rather than firing a burst, because frames arriving faster than the hold floor are frames no camera reads.
- **No timer outlives its owner.** Every wake-up re-checks liveness and `stop()` cancels the pending one, asserted directly — `DESKTOP-CRASH-013` was a main-process interval that kept encoding for a destroyed renderer.

The clock is injected, so all seventeen scheduler tests run on a clock the test controls. A scheduler whose behaviour can only be observed by waiting is one whose behaviour is never actually asserted.

---

## 7. Protocol

Manifest byte 43 was `reserved`, MUST-be-zero. It now carries `transportProfileId`, and the rule loosened in one direction: a receiver MUST accept any value and MUST NOT reject an unrecognised one.

That is safe because the field cannot affect interpretation. `symbolSizeBytes`, `segmentSizeBytes` and `fecProfileId` already carry every decode parameter; this only names which measured combination the sender chose, so a receiver can report it and a benchmark can be attributed to it. Rejecting an unknown value would have made every future profile a breaking change.

**Every golden vector generated before the field existed is byte-identical after it.** `manifest-basic.bin` still hashes to `858330198c…`, because they all declare zero and the byte was already inside the frame CRC. A new vector, `manifest-transport-profile.bin`, declares profile 3 so the new semantics are pinned too — 22 vectors, all regenerating reproducibly.

---

## 8. Stated deviations

**8.1 No physical device, so nothing is certified.** `physicallyCertified` is `false` for all four profiles and a test asserts it. `PHASE-04-PHYSICAL-TEST-MATRIX.md` specifies the runs, the telemetry shape, the pass criteria, and — written in advance — the four findings that would falsify a Phase 04 decision. Two rows of its telemetry schema depend on the capture pipeline Phase 05 has not built; running the matrix before then would produce a completion time and a hash check and nothing that explains them.

**8.2 The FPS targets are the weakest numbers here, and they contradict the plan.** The plan asked for 15/20/24/30/45/60 to be benchmarked. Measured jsQR scan time was 60–93 ms per frame, an 11–17 FPS ceiling, and the receiver is the binding constraint. Targets above that would have been arithmetic rather than transport. The measurement is Node with node-canvas, not a phone, so the real ceiling is genuinely unknown until Phase 05 builds the capture pipeline — which is why the matrix has a dedicated cadence ladder including 20 and 30 FPS.

**8.3 The plan's benchmark version list was the wrong region.** It named 20/24/28/32/36/40. Decode robustness falls away long before capacity does, so 10/14/18 turned out to matter more, and the two selectable fast profiles landed at 18 and 24. The lower versions were added to the sweep; the upper ones were kept and are the reason Experimental exists as a measured ceiling rather than an assumption.

**8.4 The simulated capture model had two artefacts, both found and fixed mid-phase.** They are recorded because each one changed a conclusion. First, resampling with `drawImage` aliased at non-integer ratios and produced a curve where 3.5 px per module scored far worse than either 3 or 4 — not something optics does. It was replaced with an explicit area average, which has no preferred ratio and is also the physically right model. Second, each cell cycled only eight distinct frames across forty trials, so the effective sample size was eight rather than forty and the residual wobble looked like signal; one independent frame per trial fixed it. The model remains **conservative** — a uniform grey background is a harder finder-pattern search than a real bezel-framed screen — and §5 of the matrix names that as a specific thing a device could falsify.

**8.5 Turbo cannot fail back on its own.** The gate allows "fail back **or** instruct the user clearly", and only the second is achievable: the optical link is a screen and a camera, so the display cannot learn that decoding is struggling. `downgradeFrom` walks the profile ladder ordered by what each needs from the camera — the axis that actually fails — and returns the reason. The wording belongs to Phase 09.

**8.6 The scheduler is not wired into the shipping UI.** It is complete and tested against an injected clock, but the shipping renderer still drives v1's push-based interval. Wiring it requires the v2 pull path in the UI, which is Phase 05's receiver and Phase 09's transfer UX; doing it here would mean doing it twice. The render-quality fix *was* applied to the shipping path, because that is a defect users have today.

**8.7 Compression is not a profile field.** The plan lists "optional compression behavior" among what a profile should declare. It was left out deliberately: `compressionMode` is already a manifest field, and Phase 08's whole premise is that compression is decided from *sampled content entropy*, not from a transport setting. Putting a compression switch in the profile would pre-empt that decision with the extension-shaped thinking Phase 00 disproved.

---

## 9. Verification

| Command | Result |
|---|---|
| `npm test` | **600 PASS / 38 files** (Phase 03: 510 / 34) |
| `npm run mobile-web:test` | **77 PASS / 12 files** (unchanged — this phase touches no receiver code) |
| `npm run typecheck` | PASS |
| `npm run mobile-web:typecheck` | PASS |
| `npm run build` | PASS |
| `npm run mobile-web:build` | PASS |
| `npm run test:packaged` | PASS |
| `npm run vectors:v2:generate` | 22 vectors, reproducible |
| `npm run doctor` | PASS, 0 warnings |
| `npm run drift-check` | PASS, zero drift |

Reproduce the measurements:

```bash
node node_modules/vite-node/vite-node.mjs scripts/bench/phase04-qr-profiles.ts -- --mode optical --versions 10,14,18,20,22,24,28,32,40 --ecc L --px 2.5,3,3.5,4,5 --trials 60
```

```bash
node node_modules/vite-node/vite-node.mjs scripts/bench/phase04-qr-profiles.ts -- --mode goodput --versions 10,18,24 --ecc L --px 3,4,5 --fps 10,12,15,20,30
```

Evidence lands in `.local-run/bench/`, which is gitignored; this report is the durable copy.

---

## 10. What Phase 05 inherits

- **A profile to build the capture pipeline against**, with a declared frame size, symbol size and expected decode budget rather than a guess.
- **The measurement that matters most to it**: scan time over a full camera frame is the throughput ceiling, and it barely varies with QR version. Optimising the pipeline is worth more than shrinking the symbol.
- **One field it must plumb through**: `observed.symbolSpanPx` from jsQR's corner locations, which is what turns camera pixels per module from a swept parameter into an observation. Everything else in the telemetry schema already exists.
- **A profile id on the wire** to attribute every measurement to, and `downgradeFrom` for when a profile is not working.
