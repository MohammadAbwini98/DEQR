# iOS Transfer Telemetry — what is instrumented, and how to read it

The point of this document is diagnosis. The physical failure produced one
sentence — *"the transfer did not finish"* — which is what four unrelated faults
all look like. Everything below exists so the next failure names itself.

**Nothing here carries file content.** Counts, error codes and timings only. The
worker holds the file; the main thread holds a description of it, and telemetry
is not allowed to become the exception. A test asserts that every refusal key
matches `^[A-Z0-9_]+$`.

---

## Reading a failure in four numbers

Look at these first, in this order. They separate the four faults that look
identical from the outside.

| What you see | What it means |
|---|---|
| Decode successes **0**, camera frames climbing | Frames are not decoding at all. Optical: symbol clipped, too small, too dim, out of focus, or the guide is not on the code. Check `pxPerModule` and photograph the desktop from the phone's position. |
| Decode successes climbing, **refusals mostly `CRC_MISMATCH`** | Frames are being read and damaged. Optical again, but marginal rather than absent — usually too few camera pixels per module. |
| Refusals mostly **`SESSION_MISMATCH`** | A second sender is visible, or the desktop restarted its session mid-transfer. Own transfer is unaffected; aim at one screen. |
| Refusals mostly **`V1_FRAME`** | The desktop is on a build older than Phase 09. Update it. |
| **No refusals, no progress, unique frames static** | Nothing new is arriving. The sender has stopped, or is repeating frames the receiver already has. This is the reported failure, and the receiver now reports it as `INCOMPLETE` rather than waiting. |

---

## Receiver counters

Surfaced on `ReceiveProgress` (worker protocol **6**) and in scan details.

| Counter | Meaning |
|---|---|
| `framesAccepted` | Unique valid frames — duplicates are rejected by fingerprint before this |
| `lastUniqueFrameAtMs` | When one last arrived. The stall detector's only input |
| `framesSystematic` / `framesRepair` | Which kind of symbol advanced a segment. **The ratio is how real loss becomes visible** — a transfer completing almost entirely on repair is barely working, and looks identical on a progress bar to one sailing through |
| `rejectionsByReason` | Refusals by error code, bounded at 32 distinct reasons |
| `framesDuplicate` / `framesForeign` | Already-seen frames; frames from another session |
| `unitsRecovered` / `unitsTotal` | Segments committed of segments expected |
| `bytesCommitted` | Bytes actually written to storage — survived CRC, algebra and the write |
| `heldBytes` | Bytes resident in JavaScript now. Stays flat as `bytesCommitted` climbs |
| `storageKind` / `storagePressure` | Where bytes are going; whether a write has been refused |
| `resumeToken` | The code to carry to the desktop. v2 when the gaps are scattered |

From `TelemetryCollector`: `capturedFrames`, `decodedFrames`, `decodeP50Ms`,
`decodeP95Ms`, `inFlight`, `droppedStale`, `skippedBusy`, `duplicateRatio`,
`pxPerModule`, `symbolSpanPx`, `qrVersion`, `stalledRecoveries`.

---

## Sender counters

| Counter | Meaning |
|---|---|
| `framesEmitted` | Frames generated |
| `framesPainted` (scheduler) | Frames actually put on screen |
| `effectiveFps` (scheduler) | **Measured**, not the configured target restated |
| `sourceSymbolsEmitted` / `repairSymbolsEmitted` | Systematic vs repair |
| `recoverySymbolsEmitted` | Emitted by the recovery tail, counted apart from the pass |
| `recovering` | True while the tail is producing |
| `transportBytesCovered` | Original bytes covered by symbols displayed |
| `currentSegmentIndex` / `segmentsCompleted` | Where the pass is |
| `totalPaintMs` / `maxPaintMs` (scheduler) | QR encode and paint cost |
| `starvedWakeups` / `overruns` / `queueDepth` | Whether the display is keeping up |

---

## The one metric to optimise

**Verified original bytes per wall-clock second.** Not configured FPS, not
frames per second, not decode rate.

`usefulThroughput()` derives it from `bytesCommitted` — bytes that survived the
CRC, the fountain algebra and the write — rather than from frames multiplied by
a payload size. It reports transport and original rates separately, because
compression makes them differ by ~3.7× on real source and optimising the wrong
one lets a compressible fixture flatter a profile.

These come apart in the direction that flatters: **raising the frame rate raises
frames per second while a camera that can no longer resolve the symbol delivers
fewer useful bytes.** A 20 FPS profile that beats 60 is only visible as such in
this unit.

---

## Stall detection

A stall is *time since the last unique frame*, not camera liveness — the
distinction the physical failure turned on. Threshold:
`RECEIVER_POLICY.stallAfterSilentMs` = 12 s, checked once a second.

Three rules keep it from crying stall where there is no transfer: no session, no
stall; a session that has never received a unique frame cannot stall (the
manifest arriving *is* the first one); and a complete session cannot stall
however long verification runs.

**Known limit, stated rather than hidden.** A sender emitting *distinct* repair
symbols for segments the receiver already holds would keep the stamp fresh while
making no progress. That is designed out on the sending side — the recovery tail
targets incomplete segments — rather than papered over with a longer threshold,
which would have to exceed a whole segment's transmission time and so would not
detect the failure this exists for.
