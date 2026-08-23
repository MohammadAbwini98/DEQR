# PHASE-11 — Physical Device Certification Matrix

**Status: PENDING — NOT EXECUTED.** No physical iPhone is available to this
engineering session. Every row below is an instruction, not a result. No number
in this document has been measured and nothing in it may be cited as evidence
that DEQR works on a phone.

This supersedes `PHASE-04-PHYSICAL-TEST-MATRIX.md` as the operative template and
does not replace it: Phase 04's document explains *why* camera pixels per module
is the variable that matters and should be read first. This one adds the sizes,
the data classes, the telemetry schema, and the pass rule the program's gate is
written against.

---

## 0. What this document is for

Phase 11's automated harness certified the **pipeline**: 21 size-and-data-class
transfers from 1 KiB to 1 GiB, hash-gated, with bounded memory and a modelled
optical channel. It could not certify the **optical link**, because a camera
looking at a screen is the one component that cannot be simulated into evidence.

So the program's central claim is split in two, and only one half is closed:

| Half | Status | Where |
|---|---|---|
| A file of size N survives segmentation, loss, storage, verification and export | **Certified to 1 GiB** | `PHASE-11-BENCHMARK-CERTIFICATION-REPORT.md` |
| An iPhone camera can read DEQR's frames off a desktop screen fast enough and reliably enough for that to happen in the real world | **PENDING — this document** | — |

Until the second half has rows in it, **the certified maximum size is zero** and
no maximum-size or maximum-speed claim may appear in the product, the README,
the release notes, or a store listing.

---

## 1. The one number this exists to measure

**Camera pixels per QR module, at a realistic scanning distance.**

```
cameraPxPerModule = (symbol width in captured pixels) / (moduleCount + 2 × quietZone)
```

jsQR returns the symbol's corner locations in the captured frame, so the first
term is an observation and not an estimate. Everything else in the profile table
is downstream of this number.

| Profile | QR version | ECC | Modules incl. quiet zone | Payload/frame | Target FPS | Needs px/module | Symbol must span |
|---|---|---|---|---|---|---|---|
| Reliable | 10 | M | 65 | 239 B | 10 | 2.5 | 163 px |
| Balanced | 18 | M | 97 | 686 B | 12 | 4 | 388 px |
| Turbo | 24 | M | 121 | 1,139 B | 15 | 5 | 605 px |
| Experimental | 32 | M | 153 | 1,920 B | 20 | 5 | 765 px — **above a 720-line capture** |

Read the ECC level and quiet zone off `src/core/transport-profiles.ts` at run
time rather than from this table; the table is a convenience and the source is
the authority.

---

## 2. What a run costs in wall-clock time

This is the constraint that shapes the whole matrix, and it is measured rather
than assumed. Verified throughput per profile, at zero loss, from the automated
harness:

| Profile | Verified bytes/sec | 8 MiB | 64 MiB | 256 MiB | 512 MiB | 1 GiB |
|---|---|---|---|---|---|---|
| Reliable | 1,195 | 1.95 h | 15.6 h | 62.4 h | 125 h | 250 h |
| Balanced | 4,631 | 30 min | 4.0 h | 16.1 h | 32.2 h | 64.4 h |
| Turbo | 9,763 | 14 min | 1.9 h | 7.6 h | 15.3 h | 30.5 h |

**A Tier D certification is a two-and-a-half day continuous scan at Balanced.**
That is not a reason to skip it and it is not a reason to fake it. It is a reason
to plan it: a phone on a stand, a desktop that does not sleep, mains power at
both ends, and a written start and end time.

Consequences for whoever runs this:

- **Do the whole primary ladder at 8 MiB first.** Seven runs of half an hour is
  one working day and settles every variable except size.
- **Only then climb the size tiers**, at the one profile the ladder selected.
- Disable every sleep, screen-dim, auto-lock and screensaver on both devices
  before starting a tier above A. A display that dims mid-transfer is a loss
  burst of several thousand frames and there is no way to tell that apart from a
  defect afterwards.

---

## 3. Environment record — fill this in once per session

Copy this block into the results file at the top of every testing session. A
result whose environment is not recorded is not a result.

```yaml
session:
  date:                     # ISO 8601
  operator:
  build:
    commit:                 # git rev-parse HEAD
    packaged:               # packaged NSIS/portable | dev (vite + electron)
    appVersion:
desktop:
  model:
  cpu:
  gpu:
  os:
  display:
    panel:                  # laptop internal | external model
    resolutionPx:           # e.g. 2560x1440
    scalingPercent:         # Windows display scaling
    refreshHz:
    brightnessPercent:
    hdr:                    # on | off
    windowMode:             # full screen | windowed
iphone:
  model:
  iosVersion:
  surface:                  # Safari tab | Home-Screen PWA
  lowPowerMode:             # on | off
  batteryPercentAtStart:
  cameraApiPath:            # rear wide | other, as reported by the receiver
environment:
  ambientLight:             # dim | office | bright indoor | direct sun
  luxIfMeasured:
  mountDistanceCm:
  angleDegrees:             # 0 = perpendicular
  mount:                    # tripod | stand | handheld
```

---

## 4. Primary ladder — profile against distance

Every cell is one transfer of the **same 8 MiB random/incompressible fixture**,
so verified throughput is directly comparable. Run the whole ladder before
changing any variable in section 5.

| Run | Profile | Window | Distance | Purpose | Result |
|---|---|---|---|---|---|
| P1 | Reliable | Full screen | 60 cm | Lower bound: does the least demanding profile work at a comfortable distance | **PENDING** |
| P2 | Balanced | Full screen | 60 cm | The default, at the distance a user would naturally pick | **PENDING** |
| P3 | Balanced | Full screen | 30 cm | Does closing the distance move it from marginal to clean | **PENDING** |
| P4 | Balanced | Windowed | 60 cm | Cost of not being full screen | **PENDING** |
| P5 | Turbo | Full screen | 30 cm | Best case for the fastest selectable profile | **PENDING** |
| P6 | Turbo | Full screen | 60 cm | Where Turbo is expected to fall over — 100% to 62% decode between 5 and 4 px/module in simulation | **PENDING** |
| P7 | Experimental | Full screen | 30 cm | Expected to fail below 1080p capture; run to confirm the ceiling is where it was calculated | **PENDING** |

## 5. Secondary — conditions, at the ladder's winning profile only

Run these only after the primary ladder, and only at one profile, so one
variable moves at a time. Same 8 MiB fixture throughout.

| Run | Variable | Setting | Result |
|---|---|---|---|
| C1 | Display brightness | 25% | **PENDING** |
| C2 | Display brightness | 100% | **PENDING** |
| C3 | Ambient light | Dim room | **PENDING** |
| C4 | Ambient light | Bright, sunlit | **PENDING** |
| C5 | Angle | 30° off-axis | **PENDING** |
| C6 | Motion | Handheld, unsupported | **PENDING** |
| C7 | Screen | External monitor rather than laptop panel | **PENDING** |
| C8 | Refresh rate | 60 Hz against 120 Hz panel, if available | **PENDING** |
| C9 | Surface | Safari tab against installed Home-Screen PWA | **PENDING** |
| C10 | Low Power Mode | On — iOS throttles timers and camera | **PENDING** |

## 6. Size tiers

Run at the profile the primary ladder selected. **Do not skip a tier after a
failure.** A tier that fails ends the certification at the tier below it.

| Tier | Size | Data class | Est. duration at Balanced | Est. at Turbo | Result |
|---|---|---|---|---|---|
| A | 64 MiB | random | 4.0 h | 1.9 h | **PENDING** |
| B | 256 MiB | random | 16.1 h | 7.6 h | **PENDING** |
| C | 512 MiB | structured | 32.2 h | 15.3 h | **PENDING** |
| D | 1 GiB | random | 64.4 h | 30.5 h | **PENDING** |
| E | 2 GiB | random | 129 h | 61 h | **PENDING — experimental** |
| E | 4 GiB | random | 257 h | 122 h | **PENDING — experimental** |

Each tier additionally needs one **compressible** run at the same size, because
the compressed path writes two files and reserves both — `data.part` for the
container and `original.part` for the file it expands into — which is a storage
behaviour no uncompressed tier exercises.

## 7. Pass rule

A tier passes **only** when every one of these holds. Any single failure is a
tier failure; there is no partial pass.

1. The transfer reaches `verified` in the receiver's own UI.
2. The final SHA-256 shown by the receiver equals the digest the desktop showed
   at preflight **and** the digest of the source file computed independently
   (`certutil -hashfile <path> SHA256` on the desktop).
3. No crash, no tab reload, no "A problem repeatedly occurred" in Safari.
4. Receiver memory stays bounded: the reported held bytes do not grow with the
   file. Cross-check with Safari Web Inspector's memory timeline over the run.
5. The camera is released and the torch is off when the session ends.
6. **Export succeeds for the tested size, or the platform's export limit is
   recorded as a number.** "It failed" is not a result; "the share sheet failed
   at N MiB with error E" is.
7. The session's working data is either retained deliberately or removed. Check
   Settings → Safari → Website Data (or the PWA's storage) before and after.

---

## 8. Per-run record

One block per run. Everything here is either read off a screen or measured with
an instrument; nothing is inferred.

```yaml
run:
  id:                       # P1..P7, C1..C10, A..E
  startedAt:
  endedAt:
  profile:                  # Reliable | Balanced | Turbo | Experimental
  qrVersion:
  eccLevel:
  payloadBytesPerFrame:
  targetFps:
  distanceCm:
  angleDegrees:
  brightnessPercent:
  ambientLight:
  file:
    sizeBytes:
    dataClass:              # compressible | structured | random | real-world
    sourceSha256:           # computed on the desktop before the run
  observed:
    cameraPxPerModule:      # THE number — from the receiver's telemetry
    capturedFps:
    decodedFps:
    uniqueAcceptedFps:
    duplicateRatio:
    rejectedRatio:
    segmentsRecovered:
    segmentsTotal:
    repairSymbolsUsed:
    elapsedSeconds:
    verifiedBytesPerSecond: # sizeBytes / elapsedSeconds — the primary metric
    receiverHeldBytesPeak:
    opfsWriteBytesPerSecond:
    verificationSeconds:
    resultSha256:
    hashMatches:            # true | false
  export:
    attempted:
    succeeded:
    destination:            # Files | AirDrop | third-party app
    elapsedSeconds:
    failureMessage:
  incidents:                # anything that happened: dimming, a call, a reload
  verdict:                  # PASS | FAIL
```

---

## 9. Gates this matrix is the only way to close

Each of these is a claim nothing in the repository currently supports. They are
listed separately from the ladder because each needs a deliberate observation
rather than falling out of a size run.

| # | Gate | Why it is open | How to close it |
|---|---|---|---|
| G1 | **iOS Safari OPFS.** | Phase 11 exercised a real OPFS in Chromium. WebKit's is a different implementation, and Safari shipped an early revision whose sync-handle `write` returned a promise — the exact case `probeSyncAccessHandle` exists for. | Run Tier A on the target iOS version and record `storageKind` from the receiver. `memory` rather than `opfs` means the probe refused the handle; capture the iOS version. |
| G2 | **Share-sheet export size limit.** | No number has ever been claimed. The export hands the main thread an OPFS path and the share sheet reads the file; where that stops working is unknown. | Export at every tier. Record the largest size that reaches Files, and the exact failure at the first size that does not. |
| G3 | **Compression refusal without `DecompressionStream`.** | The receiver refuses a compressed manifest at the manifest, with `UNSUPPORTED_COMPRESSION`, on a browser that cannot decompress. Never seen on a device. | Run a compressible fixture against the oldest iOS the release supports. Confirm the refusal is a screen with words on it, not a phone scanning in silence. |
| G4 | **Withheld-ETA thresholds.** | `MIN_ETA_WINDOW_MS` and `ETA_STABILITY_TOLERANCE` were exported so a real camera could settle them. A real camera's frame rate is not the simulator's. | During P2, record when the ETA first appears and whether it then jumps. An ETA that appears and immediately doubles is worse than one that appears later. |
| G5 | **Resume across two devices.** | The round trip is proved in Node and in Chromium. The part that has never happened is a human reading a 40-character token off a phone and typing it into a desktop. | Interrupt Tier A at roughly half. Read the token off the phone, type it into the desktop, and record transcription errors and time taken. |
| G6 | **Camera and thermal behaviour over hours.** | Every automated run is minutes of CPU. A tier is hours of continuous camera, decode and OPFS write. | During Tier B or above, record device temperature, whether iOS throttled, and whether the frame rate declined over the run. |
| G7 | **Packaged Electron, not the dev server.** | The renderer behaves differently under `file://` with the production CSP than under Vite. Phase 09's two worst defects were only visible in a running app. | Run at least P2 and Tier A against the packaged build. Record the artifact hash. |

---

## 10. Results

*(No rows. Nothing in this document has been executed.)*
