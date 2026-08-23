# PHASE-05 — iOS PWA Camera, Decode Workers, and Backpressure

**Program**: DEQR Large-File / Maximum-Speed Program
**Phase**: 05 (receiver capture pipeline, worker split, backpressure, receiver state machine — no OPFS storage, no transfer UX)
**Date**: 2026-08-21
**Verdict**: **PASS** — every gate criterion is met with executed evidence. Six deviations are stated in §8. Physical iPhone certification remains **PENDING** and is Phase 11's, unchanged.

---

## 1. Headline

**The receiver's queue is now bounded by construction, and everything downstream of the camera runs off the main thread.**

Before this phase the PWA ran jsQR in a worker and *everything else on the main thread*: frame parsing, checksum validation, duplicate detection, fountain elimination, the ripple cascade, container parsing, and the SHA-256 of the whole file — all inside a React callback, between the camera and a `setState`.

Measured on the v1 path, that is what moved:

| File | Frames | Parse | FEC | Verify | **Total main-thread** | **Longest single block** |
|---|---|---|---|---|---|---|
| 1 MiB | 2,049 | 9.4 ms | 15.8 ms | 5.2 ms | **30 ms** | 5.2 ms |
| 4 MiB | 8,193 | 25.5 ms | 54.1 ms | 17.5 ms | **97 ms** | 17.5 ms |
| 16 MiB | 32,769 | 84.7 ms | 182.7 ms | 62.2 ms | **330 ms** | **62.2 ms** |
| 31 MiB | 63,489 | 172.1 ms | 339.7 ms | 117.5 ms | **629 ms** | **117.5 ms** |

The per-frame cost was never the crisis — it is 8–12 µs. **The verification block is**: one uninterrupted 117 ms stretch at 31 MiB, on a desktop CPU, at the exact moment the app is telling the user it succeeded. That is a `longtask` by the browser's own definition and it is now in the worker.

And the queue bound holds under conditions far worse than a real phone. Driving the real `ReceiverClient` on a virtual clock, capture faster than decode:

| Capture | Decode | Duration | Attempts | Submitted | Skipped | **Peak in flight** | **Peak worker queue** |
|---|---|---|---|---|---|---|---|
| 30 Hz | 80 ms | 120 s | 3,600 | 1,501 | 2,099 | **2** | **2** |
| 60 Hz | 90 ms | 120 s | 7,200 | 1,335 | 5,865 | **2** | **2** |
| 60 Hz | 300 ms | 300 s | 18,000 | 1,001 | 16,999 | **2** | **2** |

Eighteen thousand capture attempts against a decoder eighteen times too slow, for five minutes, and nothing anywhere grows. The gap becomes skipped captures, which cost a timer each.

---

## 2. What was built

| Artifact | Location | Purpose |
|---|---|---|
| Worker message schema | `mobile-web/src/worker-protocol.ts` | Versioned, guarded, bounded messages; `OpticalObservation` |
| Receiver state machine | `mobile-web/src/receiver-state.ts` | One authoritative state, transitions as data, derived predicates |
| Early dedupe | `mobile-web/src/frame-dedupe.ts` | 53-bit fingerprint, fixed-capacity insertion-ordered set |
| Segment sink | `mobile-web/src/segment-store.ts` | `SegmentStore` interface + bounded in-memory implementation (Phase 06 seam) |
| Off-main pipeline | `mobile-web/src/receive-pipeline.ts` | v1 + v2 routing, dedupe, FEC, storage, verification — no DOM, no worker |
| Worker behaviour | `mobile-web/src/receive-worker-core.ts` | jsQR, staleness, epochs, throttled progress, `observationOf` |
| Worker entry | `mobile-web/src/receive-worker.ts` | 45 lines of `self.onmessage` glue |
| Main-thread client | `mobile-web/src/receiver-client.ts` | The in-flight cap, worker lifecycle, crash recovery, telemetry routing |
| Instrumentation | `mobile-web/src/metrics.ts` | Rates, p50/p95 reservoirs, long-task observer, one telemetry snapshot |
| Camera | `mobile-web/src/camera.ts` | Backpressure gate, ImageBitmap path, single-stream guard, error mapping |
| UI | `mobile-web/src/App.tsx` | Driven by the state machine; five contradicting flags removed |
| Benchmark | `scripts/bench/phase05-capture-pipeline.ts` | offload / sustained / backpressure / split / dedupe |
| Removed | `mobile-web/src/decoder.ts`, `decoder.worker.ts` | Superseded by the client + worker above |

---

## 3. Acceptance gate

| Plan criterion | Verdict | Evidence |
|---|---|---|
| No unbounded capture/worker queue | **PASS** | §1 table; `receiver-client-backpressure.test.ts`; peak in-flight = 2 at 18,000 attempts |
| Sustained scanning does not create growing queues | **PASS** | 300 s at 60 Hz capture / 300 ms decode: peak queue 2, flat |
| Cancel stops camera promptly | **PASS** | `cameraShouldRun` is false in every non-live state; `receiver-state-machine.test.ts` |
| Background/foreground recovery is deterministic | **PASS** | Every live state → `INTERRUPTED` → `IDLE`, asserted for all six |
| Main-thread long tasks materially reduced | **PASS** (measured as CPU, see §8.1) | 629 ms moved at 31 MiB, including the only >50 ms block |
| Duplicate frames discarded early | **PASS** | 6.1× (v2) / 7.3× (v1) faster than the full path; §4.3 |
| UI remains cancellable/responsive under synthetic load | **PASS** | `canCancel` derived from state; backpressure runs above |
| Lifecycle cleanup tests pass | **PASS** | 159 mobile-web tests, §9 |
| One authoritative state machine | **PASS** | `receiver-state.ts`; five flags deleted from `App.tsx` |
| Typed, versioned, bounded worker messages | **PASS** | `worker-message-schema.test.ts`, 12 tests |
| Worker crash does not strand camera or UI | **PASS** | `onerror`/`fatal` → slots released, camera stopped, explicit fault |
| No final OPFS storage beyond next-phase interfaces | **PASS** | `SegmentStore` is an interface; the implementation is in-memory and bounded |
| Retain explicit physical iPhone gate | **PASS** | Phase 04's matrix stands; two of its blocked rows are now unblocked (§7) |

---

## 4. The measurements

### 4.1 One worker, not two — and the number that decided it

The plan allows either split. Timing jsQR against everything downstream of it, on the same rendered frames at the Balanced profile (686 B symbols, 720 px capture):

```
PHASE05_SPLIT trials=40 decodeMeanMs=41.23 decodeP95Ms=59.78
              pipelineMeanMs=0.1125 pipelineP95Ms=0.1568
              pipelineShareOfDecode=0.0027 decodeCeilingFps=24.25
```

**The protocol, CRC, dedupe and FEC stage is 0.27% of the decode it follows.** A second worker would add a message hop and a copy to save a quarter of one percent. So decode and recovery share one worker, and the stages are separate modules so Phase 06 can split them if OPFS writes turn out to block.

The 24 FPS decode ceiling is also worth recording against Phase 04's 11–17 FPS: that measurement scanned a full 1280×720 frame, this one scans the 720×720 centre ROI the capture path actually sends. Cropping to the scan region roughly halves the decode cost. **Both are Node with node-canvas, not a phone.**

### 4.2 Memory is a function of the segment, not the file

The real pipeline, a real v2 transfer, sampling what the decoders hold every 128 frames:

| File | Segments | Frames | **Peak decoder bytes** | Segments held |
|---|---|---|---|---|
| 1 MiB | 1 | 1,529 | 1,049,087 | 0.75 |
| 4 MiB | 3 | 6,115 | **1,405,185** | 1.00 |
| 16 MiB | 12 | 24,457 | **1,405,186** | 1.00 |
| 64 MiB | 48 | 97,827 | **1,405,190** | 1.00 |

**A 16× change in file size moves decoder memory by four bytes.** That is Phase 02's sender guarantee, now held on the receiver: the segment budget and `maxActiveSegments` decide the ceiling and the file does not enter into it.

The peak sits at one segment rather than two because this sender is strictly in-order — the second decoder exists only across a boundary. Two remains the configured ceiling.

### 4.3 Early dedupe pays, and the first measurement of it was wrong

A DEQR display loops, so most successfully decoded frames in a long transfer carry nothing new. Answering those from a hash instead of the full path:

| Protocol | Frame | Fingerprint hit | Full path | Speedup |
|---|---|---|---|---|
| v2 | 718 B | **0.94 µs** | 5.73 µs | **6.1×** |
| v1 | 532 B | **0.71 µs** | 5.24 µs | **7.3×** |

The first version of this benchmark reported a *0.76× speedup* — dedupe apparently making things slower. The control was wrong: it disabled the set by setting its capacity to 1, but a single-entry set still answers an immediately repeated frame from cache, so both arms were measuring the same fast path. The corrected control alternates two frames, so at capacity 1 each evicts the other and every lookup misses. **The number changed by 8× when the control was fixed**, which is recorded here because a harness artefact that flatters a design decision is the most expensive kind.

### 4.4 The 32 MiB ceiling, met head-on

`--mode offload --sizes 32` fails, and the failure is the program's entire subject:

```
PHASE05_CAPTURE_FAILED Invalid block count K=65537. Must be 1-65535.
```

v1's 16-bit block count times its 512-byte block is 33,553,920 bytes, and a 32 MiB file plus its container header needs one block more than the format can name. The offload numbers in §1 are therefore taken at 31 MiB, which is the largest file v1 can express.

---

## 5. Where the queue bound actually lives, and why not in the worker

The first implementation put a single pending-frame slot inside the worker, with newer frames replacing older ones. **It was unreachable code.** jsQR is synchronous, so a worker is never decoding one frame and receiving another: messages are dispatched one at a time between decodes, and a frame posted early waits in the worker's own message queue — which is unbounded, and which the worker cannot inspect or trim. The slot could never fill.

The bound is therefore the client's, and it rests on one contract: **every frame posted receives exactly one terminal event**, including the ones the worker refuses for staleness or for belonging to an ended session. A frame that could be dropped silently would leak a slot, and enough leaked slots would wedge capture permanently — a queue bound that quietly becomes a deadlock is worse than no bound. `receive-worker-core.test.ts` holds that contract on the worker side; `receiver-client-backpressure.test.ts` holds it on the client side, including the case where `postMessage` itself throws.

`maxInFlight` is 2: one frame decoding, one posted so the worker never idles between them. A third buys nothing — decode is 40–90 ms and capture is single-digit milliseconds — and would put another 1.5 MB pixel buffer in flight for it.

What the worker *can* do, and does, is refuse to spend 40–90 ms decoding a photograph of a display that has moved on. A capture older than **250 ms** on arrival is reported `stale` without being decoded. That is 2.5–5 display frames at the Phase 04 cadences. It is not theoretical: iOS deprioritises work in an occluded tab, and a resumed worker finds several hundred milliseconds of captures waiting.

---

## 6. The state machine, and the flags it replaced

The receive screen was driven by five things at once: a `cameraState` string, a protocol snapshot with its own state, a `startRequested` flag, a `cameraActive` ref, and a `receivingAnnounced` ref. Any two could disagree, and the ones that did produced this receiver's two worst shipped bugs — a preview claiming an active camera after the scan loop had died, and a shell rendering a screen for a session that no longer existed.

There is now one state. Whether the camera runs, whether cancel means anything, whether the session's buffers may still be alive: all derived from it, in `receiver-state.ts`, because a derived value cannot contradict its source. The transition table is data, and a test walks every state against every event and asserts that anything unlisted changes nothing at all — including object identity, so React skips the render.

Two decisions inside it worth stating:

- **`INTERRUPTED` is a state, not a silent cancel.** Backgrounding still ends the session and clears its bytes, which is this receiver's standing privacy posture and is unchanged. Naming the state is what lets the return path be asserted rather than inferred: every live state → `INTERRUPTED` → `IDLE`, for all six, in a test.
- **`EXPORTING` deliberately absorbs backgrounding.** The iOS share sheet hides the page. Treating that as an interruption would cancel the save at the moment the user was confirming it.

There is no `PAUSED`. Resuming a partial transfer needs Phase 07's checkpoints, and a pause that silently discarded progress would be a worse lie than not offering one.

---

## 7. What Phase 04 asked for, delivered

Phase 04 closed with one field Phase 05 had to plumb: `observed.symbolSpanPx`, from jsQR's corner locations, *"which is what turns camera pixels per module from a swept parameter into an observation."*

It is now on every decoded frame, and the unit it is expressed in was the part worth getting right. jsQR's corners sit on the symbol's outer module boundary, so the span covers the symbol *excluding* its quiet zone — while a profile's `minCameraSymbolPx` is quiet-zone-inclusive. Dividing the observed span by the profile's total module count would have under-reported density by about 18% and failed profiles that were in fact being met. `pxPerModule` therefore divides by `qrModuleCount(version)`, and a test pins it against a synthetic quad: a version-18 symbol spanning 356 px reports exactly 4.00 px per module, which is Balanced's specified density.

Two further fields are carried that the matrix did not ask for:

- **`spanSkew`** (shortest edge / longest). Without it, a low `pxPerModule` has two different causes with two different instructions — too far away, or too oblique — and a log cannot tell them apart.
- **`captureScale`**, so a reading taken from a downscaled ROI can be rescaled to camera pixels later.

The matrix's other blocked row — capture-side frames-per-second and latency percentiles — is now produced by `metrics.ts`: capture attempts/sec, decoded/sec, unique/sec, duplicate ratio, decode and pipeline p50/p95, in-flight depth, skipped-busy and dropped-stale counts. `PHASE-04-PHYSICAL-TEST-MATRIX.md` has been updated to mark both rows available.

---

## 8. Stated deviations

**8.1 The long-task measurement is CPU time, not `longtask` entries, on the device that matters.** `LongTaskMonitor` uses `PerformanceObserver` with the `longtask` entry type and it works — on Chromium. **Safari does not implement that entry type**, so on iOS the monitor reports `supported: false` rather than reporting zero, because "no long tasks" and "no long-task reporting" are very different claims. The gate is therefore evidenced by measuring the work that moved, in the same JavaScript, as CPU time (§1). The numbers are from Node on a desktop CPU; a phone is several times slower and runs React reconciliation on top, so they are a floor, not a ceiling.

**8.2 The canvas readback saving is architectural, not measured.** The old capture path did `drawImage` + `getImageData` on the main thread — about 1.5 MB copied per frame at the 619 px ROI. The new path prefers `createImageBitmap` transferred to an `OffscreenCanvas` in the worker, which removes that entirely. It is **not benchmarked here**, because node-canvas is not a browser canvas and a number from it would be misleading. Both APIs are feature-detected, the worker advertises which it can take in its handshake rather than the client guessing from a user-agent string, and a single `createImageBitmap` rejection retires the path for the session. Quantifying the saving is a physical-device measurement and belongs to Phase 11.

**8.3 v1's fail-on-first-malformed-frame was changed, deliberately.** v1's `ReceiverSession` parses a frame and fails its *entire session* if the frame will not parse. That is correct for a byte stream and wrong for a camera, where a marginal decode is a normal event whose likelihood rises with the frame rate. The pipeline now parses first and hands the session only well-formed frames, so a mangled decode is one counted rejection. Every v1 rule that matters — session isolation, conflicting duplicates, resource limits — still runs, because the session still sees every valid frame. `receive-pipeline.test.ts` covers both halves: a damaged frame does not kill the transfer, and a genuinely conflicting duplicate still does and is now *reported* rather than leaving the receiver scanning against a session that can never advance.

**8.4 v2 finalization exists but is bounded by an in-memory store.** A completed v2 transfer is assembled, hashed against the manifest, and handed back exactly as v1 is — but only while it fits `segmentBudgetBytes` (about 9 MB by default). Beyond that the store refuses a write, the session stops, and the receiver reports storage pressure. This is scaffolding for Phase 06, stated rather than hidden: `SegmentStore` is the interface OPFS will implement, and the ceiling is the absence of that implementation, not a v2 limit. Assembly checks what the store *actually holds* before allocating, never the manifest's claim, so an untrusted manifest cannot make the receiver allocate a gigabyte after four kilobytes of real frames.

**8.5 The shipping desktop sender still emits v1, so the v2 receive path has no user-facing flow yet.** The receiver routes both protocols and is tested end to end on both. Wiring the desktop UI to v2 is Phase 09's; removing v1 from the receiver before then would break the product.

**8.6 Two QA-owned tests were rewritten and one contract assertion updated.** `camera-controller.test.ts` and `camera-scan-loop.test.ts` mocked `../src/decoder`, which no longer exists; they now drive a `CaptureTarget` stub, and every property they held before — watchdog, generation fencing, hidden-document resume, stop clearing every wake-up — is asserted unchanged, plus one new one. `accessibility-and-design-contract.test.ts` asserted the source string `snapshot.state === 'CANCELLED'`; it now asserts `RECEIVER_STATE.CANCELLED`. The contract is identical — cancellation is a distinct, announced screen — and only the expression naming it changed.

---

## 9. Verification

Every command below was executed and its output captured.

| Command | Result |
|---|---|
| `npm run mobile-web:typecheck` | clean |
| `npm run mobile-web:test` | **159 passed** (18 files), up from 77 |
| `npm run mobile-web:build` | clean; worker emitted as its own hashed chunk (182 KB) |
| `npm run typecheck` | clean |
| `npm test` | **600 passed** (38 files) — no desktop regression |
| `phase05 --mode offload --sizes 1,4,16` / `31` | `.local-run/bench/phase05-offload.log` |
| `phase05 --mode sustained --sizes 1,4,16` / `64` | `.local-run/bench/phase05-sustained.log` |
| `phase05 --mode backpressure` × 3 | `.local-run/bench/phase05-backpressure.log` |
| `phase05 --mode split --trials 40` | `.local-run/bench/phase05-split.log` |
| `phase05 --mode dedupe --trials 20000` | `.local-run/bench/phase05-dedupe.log` |

New test files and what each holds:

| File | Tests | Holds |
|---|---|---|
| `receive-pipeline.test.ts` | 16 | v1 and v2 end to end with the real encoders; repair recovery; foreign sessions; blocked extensions; storage pressure; decoder memory bounded; dedupe correctness independent of capacity |
| `receiver-state-machine.test.ts` | 14 | Every state × every event; camera states; epoch fencing; deterministic backgrounding |
| `receive-worker-core.test.ts` | 14 | Real QR images through jsQR into the pipeline; one terminal event per frame; staleness; `observationOf` against a known quad |
| `receiver-client-backpressure.test.ts` | 13 | The in-flight cap across 500 out-of-order answers; slot release on stale/cancel/crash/refused post; epoch discard |
| `camera-backpressure.test.ts` | 11 | No pixels read while saturated; ImageBitmap fallback retires once; every `getUserMedia` error mapped; track-ended interruption; single live stream |
| `worker-message-schema.test.ts` | 12 | Version refusal, shape refusal, bounded reasons |

### 9.1 A real browser, and the defect it found

The rewritten shell was loaded in a Chromium browser against the mobile-web dev
server and driven through the failure path, because a 159-test suite can prove
every transition it was told to check and still miss what a person reads.

- The home screen mounts with **no React error and no console error**; the only
  network failures are the host-reachability probe against a bare Vite server,
  which is exactly the "Offline app mode" the chip reports.
- `GET /src/receive-worker.ts?worker_file&type=module` is fetched **at mount**,
  before any Receive tap — confirming the eager worker construction that gets
  the chunk into the service worker's cache before it is needed offline.
- Pressing Receive walked `IDLE → PREFLIGHT → CAMERA_WARMING → FAILED` with no
  camera present, and the screen offered "Try camera again" and "Return to
  home" with `Frames in flight 0 / 2` reported.

**It also found a real defect that no unit test would have.** The failure
heading was derived by comparing a formatted string — `errorHeading === 'Camera
unavailable' ? 'Transfer not verified' : errorHeading` — and the condition was
inverted, so a camera-permission failure was headlined **"Transfer not
verified"**. A user whose camera never opened was being told their file was
corrupt. The heading and the live-region status are now both switched on
`fault.kind`, which the state machine already carries, so the four faults get
four headings: camera, scanner, storage, and the one that is actually about the
file. String-derived state was the class of bug this phase set out to remove
from the receive screen, and one instance of it survived into the rewrite.

Security posture is unchanged and re-checked: no network call is introduced, no payload byte crosses the worker boundary except the verified file itself (transferred once, at the end), decoder exceptions are never echoed, filenames are sanitized before they enter a progress message, and every buffer is zeroed on release. Receiver limits — decode pixels, dedupe capacity, active segments, segment budget — are receiver policy passed to the worker at `open`, never taken from a manifest.

---

## 10. What Phase 06 inherits

- **A sink to implement.** `SegmentStore` is three methods, `write` may refuse, and the pipeline already treats a refusal as terminal and reports it. Swapping `BoundedMemorySegmentStore` for an OPFS writer is the whole of the wiring.
- **A worker to write into.** Storage is the one stage with a real reason to move to its own worker or its own queue, because unlike FEC it can block. §4.1's measurement is the baseline that would justify the split.
- **The size ceiling to remove.** §8.4 is the only reason a large v2 transfer cannot finish today, and it is one class.
- **A bounded-memory receipt.** §4.2 is the number Phase 06 must not regress: decoder memory flat at one segment across a 16× change in file size.
- **Two unblocked matrix rows.** The capture-side telemetry Phase 04's physical matrix needs now exists and is reported per session.
