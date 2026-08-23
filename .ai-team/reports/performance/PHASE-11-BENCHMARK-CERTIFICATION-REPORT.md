# PHASE-11 — Benchmarking, Stress Testing, and Certification

**Date**: 2026-08-23
**Programme**: Large-File / Maximum-Speed, phase 11 of 12
**Status**: **COMPLETE — PASSED, with the physical gate explicitly open.**
This is the `BENCHMARK-RESULTS.md` the plan asks for.

---

## 1. Verdict

| Claim | Verdict |
|---|---|
| A file of any size from 1 KiB to **4 GiB** survives the whole pipeline and verifies byte-exact | **PASSED** — 35 hash-gated transfers, zero failures |
| Receiver and sender memory are bounded independently of file size | **PASSED** — 1.34 MiB held and 1.37 MiB buffered, identical at 10 MiB and at 4 GiB |
| The receiver survives loss, bursts, duplicates, reordering and corruption | **PASSED with a measured ceiling** — see §6 |
| An interrupted transfer resumes and costs almost nothing extra | **PASSED** — the round trip cost 6% more optical time than one clean run |
| A slow store, decoder or display costs time and not correctness | **PASSED** |
| Every refusal path fails closed and claims no digest | **PASSED** — 6 of 6 |
| The receiver works against a **real** OPFS | **PASSED in Chromium** — 10 of 10; **iOS/WebKit remains PENDING** |
| Production `Balanced` and `Turbo` settings are chosen from measurement | **RANKED, NOT CERTIFIED** — see §9 |
| An iPhone camera can read these frames off a screen | **PENDING — NOT EXECUTED** — see `PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md` |

**The programme's certified maximum size is stated in §13 and it is not 4 GiB.**

---

## 2. The three clocks, and which one a claim is made in

A number in this report is one of three things and they are not interchangeable.

- **Optical seconds** — `framesEmitted / effectiveFps(profile)`. The clock a user
  waits on. Every throughput claim here is in this clock.
- **Pipeline seconds** — wall clock for the harness on this machine. It says
  whether the software can keep up with the optical clock and nothing about how
  long a transfer takes. The 4 GiB transfer took 380 pipeline seconds and would
  take 258 optical **hours**.
- **Verification seconds** — wall clock for the end-of-transfer SHA-256 read back
  out of storage. Real time a user waits after the last frame, and the only
  wall-clock number here that a user experiences directly.

`verifiedBytesPerSecond` throughout is **original bytes over optical seconds**,
and is zero for any run that did not produce a digest matching the source. That
last rule matters: an earlier draft of the ranking let incomplete runs carry a
throughput number, which put four combinations that never delivered a file above
three that did.

**One modelling assumption affects every throughput number.** The harness stops
the sender when the receiver reports the session complete, checked every 64
frames. That models a user who stops the desktop when the phone says it is
finished. It has no effect on a multi-segment transfer, where completion only
happens at the end — but it is why a file smaller than one segment appears
faster per byte (§5).

---

## 3. What is measured and what is modelled

| Component | In this phase |
|---|---|
| Sender | **Real.** `StreamingTransferSession`, the shipping one. |
| Frames | **Real.** `serializeManifestFrame` / `serializeDataFrame`, CRC included. |
| FEC | **Real.** `SegmentEncoder`, robust-soliton repair, the shipping distribution. |
| Receiver | **Real.** `ReceivePipeline`, `SegmentedReceiver`, `SegmentStore`. |
| Verification | **Real.** `Sha256Stream` over bounded windows read back out of storage. |
| Export | **Real** as far as `seal()` and the main thread opening the sealed file. |
| Storage | **Real API shape, two implementations.** Node `fs` behind `SyncAccessHandleLike` for the size ladder; **real Chromium OPFS** for the browser half (§11). |
| Camera and QR layer | **Modelled.** Frames move as bytes. Loss rates come from the decode-success surface Phase 04 measured with a real encoder and the receiver's own jsQR. |
| iPhone, iOS Safari, share sheet | **Not exercised at all.** |

An automated run therefore certifies **the pipeline**. The optical constant —
camera pixels per QR module on a real phone at a real distance — remains the
physical matrix's to close, and nothing here substitutes for it.

---

## 4. The harness

| Path | What it is |
|---|---|
| `scripts/bench/phase11-certification.ts` | The Node harness. Six modes: `ladder`, `channel`, `interrupt`, `backpressure`, `faults`, `profiles`. |
| `scripts/bench/browser/` | The real-OPFS harness: a page, a worker, and a Vite config with its own root so the shipped PWA build cannot pick it up. |
| `tsconfig.phase11.json`, `scripts/bench/browser/tsconfig.json` | Typecheck configurations, wired to `npm run typecheck:phase11`. |
| `.ai-team/reports/performance/phase11/*.json` | Machine-readable results, one file per mode, plus the browser evidence. |

Fixtures are generated, never stored: **every fixture byte is a pure function of
its own offset and a seed.** A 4 GiB certification needs no 4 GiB of disk, and —
more importantly — the expected digest can be streamed from the generator
*independently of the sender*, so the hash gate compares three separately
computed digests rather than letting the sender agree with itself:

```
generator SHA-256  ==  sender preflight SHA-256  ==  receiver's digest of what it stored
```

All three must match for a row to pass. No payload byte is ever printed.

```bash
node --expose-gc node_modules/vite-node/vite-node.mjs scripts/bench/phase11-certification.ts -- --mode ladder --maxMib 1024
```

---

## 5. Size ladder — 35 transfers, 35 passed

Balanced profile, zero loss, compression off, three data classes at every size
from 1 KiB to 1 GiB, plus 2 GiB and 4 GiB at random data. Ordered smallest
first; the harness stops the ladder at the first size where any row fails, so no
green row here is unsupported by the rows below it.

| Size | Classes | Verified B/s | Optical time | Receiver held | Sender buffered | Store MiB/s | Hash MiB/s | Export |
|---|---|---|---|---|---|---|---|---|
| 0 B | — | — | — | — | — | — | — | refused: `FILE_EMPTY` |
| 1 KiB | 3/3 | 2,458 | 0.4 s | 0.00 MiB | 1.34 MiB | — | — | opfs |
| 5 KiB | 3/3 | 4,096 | 1.2 s | 0.00 MiB | 1.34 MiB | — | — | opfs |
| 100 KiB | 3/3 | 6,400 | 16 s | 0.10 MiB | 1.37 MiB | 776–1,009 | 6–39 | opfs |
| 1 MiB | 3/3 | 7,864 | 2.2 min | 1.00 MiB | 1.37 MiB | 2,407 | 42 | opfs |
| 10 MiB | 3/3 | 4,749 | 36.8 min | 1.34 MiB | 1.37 MiB | 2,752 | 99 | opfs |
| 32 MiB | 3/3 | 4,702 | 1.98 h | 1.34 MiB | 1.37 MiB | 2,901 | 111 | opfs |
| 64 MiB | 3/3 | 4,662 | 4.00 h | 1.34 MiB | 1.37 MiB | 2,942 | 111 | opfs |
| 128 MiB | 3/3 | 4,641 | 8.03 h | 1.34 MiB | 1.37 MiB | 2,935 | 115 | opfs |
| 256 MiB | 3/3 | 4,631 | 16.10 h | 1.34 MiB | 1.37 MiB | 2,927 | 115 | opfs |
| 512 MiB | 3/3 | 4,631 | 32.20 h | 1.34 MiB | 1.37 MiB | 2,931 | 113 | opfs |
| **1 GiB** | 3/3 | 4,631 | 64.40 h | 1.34 MiB | 1.37 MiB | 2,902 | 115 | opfs |
| **2 GiB** | 1/1 | 4,631 | 128.81 h | 1.34 MiB | 1.37 MiB | 2,977 | 115 | opfs |
| **4 GiB** | 1/1 | 4,631 | 257.65 h | 1.34 MiB | 1.37 MiB | 2,948 | 111 | opfs |

Data class made **no difference to any transport number** at any size — the
compressible, structured and random rows are identical to four significant
figures on frames, throughput, memory and repair. That is the Phase 08 rule
holding in practice: with compression off, content does not reach transport.

### The three things this table says

**Memory is a function of configuration, not of the file.** The receiver's held
bytes are 1.34 MiB at 10 MiB and 1.34 MiB at 4 GiB — one segment, which is what
the design budgets. The sender's declared budget is 1.39 MiB and its peak
observed buffer is 1.37 MiB, so the bound holds and is not merely intended. Peak
process heap stayed between 59 and 89 MiB across the whole ladder, including the
4 GiB row.

**Throughput converges to 4,631 B/s and stops.** That is Balanced's nominal
8,232 B/s (686 payload bytes × 12 fps) divided by 1.75, the unconditional repair
overhead. The convergence from above — 7,864 at 1 MiB down to 4,631 at 256 MiB —
is the repair budget being fully paid once a file is more than a couple of
segments long.

**A file below one segment is genuinely faster per byte.** A 1 MiB file fits
inside Balanced's 1.34 MiB segment, so the receiver completes at the end of the
source symbols and the sender never emits the repair. Small transfers get 7,864
B/s; anything multi-segment gets 4,631. This is a real property of the design,
not an artefact — but see §12, because it points at the largest single
throughput opportunity in the product.

---

## 6. Channel — loss, bursts, duplicates, reordering, corruption

8 MiB, random data, Balanced, one impairment moved at a time. Every row that
completed produced a digest matching the source.

| Impairment | Measured drop | Passes | Result | Verified B/s | Receiver held |
|---|---|---|---|---|---|
| loss 0% | 0 | 1 | **PASS** | 4,961 | 1.34 MiB |
| loss 1% | 1.08% | 1 | **PASS** | 4,839 | 1.34 MiB |
| loss 5% | 5.26% | 1 | **PASS** | 4,809 | 1.35 MiB |
| loss 10% | 10.07% | 1 | **PASS** | 4,795 | 1.38 MiB |
| loss 20% | 20.15% | 1 | **PASS** | 4,709 | 1.45 MiB |
| loss 30% | 30.19% | 4 | **FAIL at 4 passes** | 0 | 3.05 MiB |
| loss 30% | 30.05% | **17** | **PASS** | **280** | 3.05 MiB |
| burst 20%, runs of 8 | 17.42% | 1 | **PASS** | 4,653 | 1.46 MiB |
| burst 20%, runs of 32 | 17.62% | 1 | **PASS** | 4,737 | 1.50 MiB |
| duplicates 25% | 0 | 1 | **PASS** | 4,961 | 1.34 MiB |
| reorder, window 64 | 0 | 1 | **PASS** | 4,915 | 1.35 MiB |
| reorder 512 + loss 10% | 9.77% | 1 | **PASS** | 4,639 | 2.68 MiB |
| corrupt 10% | 0 | 1 | **PASS** | 4,766 | 1.38 MiB |
| corrupt 50% | 0 | **20** | **FAIL — cannot complete** | 0 | 3.20 MiB |
| hostile mix* | 9.65% | 1 | **PASS** | 4,681 | 1.44 MiB |

\* 10% loss in bursts of 4, 15% duplicates, reorder window 128, and 10% corruption, all at once.

### Loss up to 20% is free; 30% is a cliff, not a slope

Balanced's declared `designLossRate` is 0.20 and the measurement agrees exactly:
every rate up to and including 20% completes in a **single pass**, and costs 5%
of throughput. At 30% the transfer still completes — but it needs **17 passes**
and delivers **280 B/s, 17.7× slower**. The degradation is not graceful, and the
reason is structural rather than a defect:

> The receiver holds at most two active segments. A segment that does not
> accumulate enough symbols during its own transmission window has its partial
> state discarded when the sender moves on. Every subsequent pass is therefore an
> independent trial for that segment, not a continuation.

That is the price of the bounded-memory guarantee in §5, and it is the right
trade — but it means loss above a profile's design rate should be reported to
the user as "move the phone closer", not absorbed silently.

### There is a loss rate above which no number of passes helps

Per segment the sender emits `K(1 + r)` symbols, of which `(1 − p)` arrive. LT
decoding needs about `1.05K`. So a segment is decodable in one window only while

```
(1 + r)(1 − p) ≥ 1.05
```

For Balanced and Turbo (`r = 0.75`) that is **p ≤ 0.40**; for Reliable
(`r = 1.0`), **p ≤ 0.475**. The corrupt-50% row is the experimental
confirmation: effective loss of 50.06%, twenty passes, and `segmentsRecovered`
never left zero — not one segment ever completed. **Above ~40% loss the current
design cannot transfer a file at all, at any duration.**

### Corruption is caught, and caught cheaply

At 10% corruption the reject ratio was 10.08% — the CRC refused exactly the
frames that were damaged, admitted none of them, and the transfer completed in
one pass with a matching digest. Corruption costs the same as loss and nothing
more. No corrupt frame was ever accepted in any run of this phase.

### Duplicates and reordering cost nothing

25% duplicates produced an identical frame count, identical throughput and
identical memory to the clean run — the fingerprint set absorbed them. A reorder
window of 512 frames raised held memory from 1.34 to 2.68 MiB, which is exactly
two active segments rather than one, and is the bound, not a leak.

---

## 7. Interruption and resume

8 MiB, structured data, Balanced. Three separate runs with only what a user
actually carries between them: the bytes left on the device, and a token read
off a screen.

| Run | Frames | Result |
|---|---|---|
| Clean baseline | 20,288 | verified |
| Interrupted at 60% of transport | 12,129 | incomplete, as intended |
| Resumed | 9,344 | **verified, digest matches** |

- **Frames not re-sent: 10,944** — 912 optical seconds, 15.2 minutes of a
  30-minute transfer.
- **Total cost of the whole round trip against one uninterrupted run: 1.06.**
  Being interrupted at 60% and resuming cost 6% more optical time than never
  being interrupted at all.
- The resume token was read from a **fresh pipeline** over the same storage —
  not kept from the object that wrote it — proving it is a property of the
  working data and not of a live session. It came back 47 characters long,
  which is the display form: 40 Crockford base32 characters in eight groups of
  five, separators included.

The apparent throughput of a resumed run (10,773 B/s) is **not** a transport
rate: it divides the whole file by the frames of the final pass only. It is
reported in the raw results for completeness and must not be quoted.

---

## 8. Backpressure — a slow store, a slow decoder, a slow display

2 MiB, Balanced. All seven rows verified with matching digests, and **held
memory was 1.34 MiB and sender buffer 1.37 MiB in every single row**, identical
to the unimpaired baseline.

| Row | Pipeline seconds | Result |
|---|---|---|
| baseline | 0.17 | PASS |
| store 45 ms/write (the real Chromium OPFS rate) | 0.29 | PASS |
| store 200 ms/write | 0.77 | PASS |
| decoder 2 ms/frame | 9.54 | PASS |
| decoder 10 ms/frame | 46.97 | PASS |
| display 2 ms/frame | 9.54 | PASS |
| all three at once | 19.04 | PASS |

**The store is touched once per segment, so storage latency is almost free.**
One write covers 1.34 MiB, which is 3,584 frames, which is 298 optical seconds
at Balanced. Even a 200 ms write is **0.07%** of the window it serves. This is
the strongest argument in the phase for the segment-sized write: storage cannot
be the bottleneck of an optical transfer by roughly four orders of magnitude.

**The decoder has 83 ms per frame at Balanced** (12 fps). A 10 ms artificial
cost — far above what jsQR needs for a version-18 symbol — consumes 12% of that
budget.

**What this does not prove.** The harness is pull-based: one loop takes a frame
and hands it to the receiver, so a producer can never outrun a consumer and no
queue can grow. Queue-depth backpressure — the camera sampler dropping frames,
the worker's bounded inbox — is Phase 05's measurement and is covered by
`camera-backpressure.test.ts` and `receiver-client-backpressure.test.ts`.
Claiming it here would be claiming something the shape of this harness makes
untestable.

---

## 9. Profile ranking and recommendation

Each row is a **measured optical property driving a measured pipeline**: the loss
rate is `1 − decodeSuccess` taken from the surface Phase 04 measured with a real
QR encoder and the receiver's own jsQR, and the throughput is a real 8 MiB
transfer at that loss. Nothing here is a formula; every number came from a file
that either arrived or did not.

### Combinations that delivered a file

| Rank | Profile | Camera px/module | Decode success | Loss | Passes | Verified B/s | Hours per GiB |
|---|---|---|---|---|---|---|---|
| 1 | **Turbo** | 5 | 100.0% | 0 | 1 | **10,294** | 29.0 |
| 2 | Turbo | 3.5 | 76.7% | 23.3% | 2 | 5,174 | 57.7 |
| 3 | **Balanced** | 5 | 98.3% | 1.7% | 1 | 4,825 | 61.8 |
| 4 | **Balanced** | 4 | 83.3% | 16.7% | 1 | 4,709 | 63.3 |
| 5 | Balanced | 3.5 | 75.0% | 25.0% | 1 | 4,640 | 64.3 |
| 6 | Reliable | 3.5 | 100.0% | 0 | 1 | 1,181 | 252.6 |
| 7 | Reliable | 5 | 100.0% | 0 | 1 | 1,181 | 252.6 |
| 8 | **Reliable** | 2.5 | 88.3% | 11.7% | 1 | 1,179 | 253.0 |
| 9 | Reliable | 4 | 95.0% | 5.0% | 1 | 1,179 | 253.0 |
| 10 | Reliable | 3 | 83.3% | 16.7% | 1 | 1,178 | 253.3 |

### Combinations that never delivered a file

| Profile | Camera px/module | Loss | Passes attempted |
|---|---|---|---|
| Balanced | 3 | 33.3% | 6 |
| Balanced | 2.5 | 76.7% | 6 |
| Turbo | 4 | 38.3% | 6 |
| Turbo | 3 | 36.7% | 6 |
| Turbo | 2.5 | 68.3% | 6 |
| Experimental | 4, 3.5, 3, 2.5 | 33.3%–96.7% | 6 each |
| Experimental | 5 | — | not attempted: a 765 px symbol does not fit a 720-line capture frame |

Every failure above sits at or beyond the ~40% ceiling derived in §6, except
Balanced at 3 px and Turbo at 4 px, which sit just inside it and would need more
than six passes — the 30%-loss row needed seventeen.

### The recommendation, and what it depends on

| Question | Answer from this measurement |
|---|---|
| Fastest combination that completes | **Turbo at 5 px/module — 10,294 B/s, 29.0 h/GiB** |
| Broadest stable profile | **Reliable — completes at every measured density down to 2.5 px, at 1,179 B/s** |
| Where Balanced stops working | **Below 3.5 px/module.** It completes at 3.5, 4 and 5; it fails at 3. |

The plan's rule is *"choose Balanced from the broadest stable matrix; Turbo may be
narrower and device-dependent."* On this evidence:

- **Turbo's certified envelope is 5 px/module and nothing below it.** Its pass at
  3.5 px is real but sits above a *failure* at 4 px — the measured surface is
  non-monotonic there (76.7% at 3.5, 61.7% at 4), which is a Phase 04
  measurement artefact rather than a property a user could rely on. Turbo stays
  opt-in, and its envelope should be stated as "5 px/module, well-framed", not as
  a range.
- **Balanced remains the right shape for a default** — one pass at every density
  from 3.5 up, and a throughput within 3% across that whole range, which is the
  insensitivity a default wants.
- **But whether Balanced is the right default is undecided**, because the number
  it depends on has never been measured. If a real iPhone at a comfortable
  distance supplies 3.5 px/module or better, Balanced is correct and Reliable
  costs a user four times the time for nothing. If it supplies less, Balanced
  fails and only Reliable works. **Runs P1 and P2 of the physical matrix decide
  this, and until they run the default profile is a guess with good reasoning
  behind it.**

No profile table value was changed by this phase. `productionSelectable` and
`physicallyCertified` in `src/core/transport-profiles.ts` are left exactly as
Phase 04 set them, because changing a certification flag on simulated evidence is
the specific thing this phase exists to prevent.

---

## 10. Refusals — the paths that must fail, and must fail cleanly

Six paths — five from the `faults` mode plus the empty file from the ladder.
Every one raised a refusal, named it, and **claimed no digest**.

| Row | Expected | Observed | Notes |
|---|---|---|---|
| Empty file | refusal | `FILE_EMPTY` | Refused by the sender before a frame exists |
| Device too small for the transfer | `INSUFFICIENT_STORAGE` | `INSUFFICIENT_STORAGE` | 0 bytes written to the device |
| Quota would be exceeded during the transfer | `INSUFFICIENT_STORAGE` | `INSUFFICIENT_STORAGE` | **Pre-sizing converts it to an up-front refusal** |
| Device fills up *after* the file was reserved | `STORAGE_FULL` | `STORAGE_FULL` | Held 1.34 MiB, stopped, claimed nothing |
| Frames from another sender mid-transfer | counted as foreign | 2,496 accepted / **505 foreign** / 0 rejected | No fault; own transfer unaffected |
| Cancel mid-transfer | working data discarded | 2.68 MiB committed, cancelled in **0.83 ms**, **0 bytes left on the device** | |

The third row is worth stating as a finding rather than a checkbox. A quota that
would be exceeded an hour into a transfer is caught **at session start**, because
the store reserves the whole file with `truncate` before accepting a byte. The
only quota failure that can reach the middle of a transfer is a device that fills
up from something *else* — and that is the fourth row, which is handled too.

---

## 11. The receiver against a real OPFS

Every phase from 06 onward wrote its storage claims against Node `fs` behind the
`SyncAccessHandleLike` interface. That is the same *shape* as the API and a
different implementation, and three things the receiver depends on are not shape
at all: a sync access handle is **exclusive**, `truncate` **reserves quota**, and
`getFile()` on the main thread must see what the worker wrote.

`scripts/bench/browser/` runs the shipping `ReceivePipeline` and
`ReceiverStorage` inside a real worker against a real origin-private file system,
with **no injected environment** — `defaultEnvironment()` finds the browser's own
`navigator.storage`. **10 checks, 10 passed.**

| Check | Result |
|---|---|
| OPFS, sync access handles and estimate all present in a worker | PASS — quota 6,287 MiB reported |
| `Sha256Stream` agrees with `crypto.subtle.digest` | PASS — the receiver's hasher is not grading its own homework |
| 1 MiB transfer, verified, sealed | PASS — 21.7 MiB/s write, 75.8 MiB/s hash |
| 16 MiB transfer | PASS — 27.6 MiB/s write, 89.0 MiB/s hash, 1.34 MiB held |
| 64 MiB transfer | PASS — 28.8 MiB/s write, 88.5 MiB/s hash, 1.34 MiB held |
| **Export handoff** — main thread opens the sealed file, streams it, digest matches | PASS at all three sizes |
| Interrupt and resume across two pipelines on real OPFS | PASS — 3 of 6 segments adopted from the real checkpoint, final digest matches |
| Sessions retained after export | 4 sessions, 89 MiB — retained by policy, see below |

### What this closes and what it does not

**Closes:** the OPFS write path, the pre-sizing truncate, the checkpoint round
trip, and above all the **export handoff** — `seal()` really does release the
exclusive handle, and the main thread really can open and read the file
afterwards. That is the failure that would have surfaced on a phone at the exact
moment a user pressed save, and Node `fs` cannot test it because `fs` has no
exclusivity to release.

**Does not close:** iOS. Chromium's OPFS and WebKit's are two implementations.
Safari shipped an early revision whose sync-handle `write` returned a promise —
the case `probeSyncAccessHandle` exists for — and no build of DEQR has ever met
it. Gate G1 in the physical matrix.

**Real OPFS is ~100× slower than Node `fs`** — 28.8 MiB/s against 2,948 MiB/s.
It is still ~6,400× faster than the optical link it serves, so the conclusion in
§8 stands, but every storage rate quoted from a Node-backed bench in Phases 06,
07 and 08 should be read as an upper bound and not as a device number.

### Sessions are retained on purpose, and the bound is soft

Four completed sessions were still on the device at the end of the run, holding
89 MiB. That is the retention policy working: a session released as `completed`
is **retained**, because the export route holds a path into a file the user may
not have saved yet, and deleting it would race them. `maxRetainedSessions` is 3,
and the sweep runs when a session *opens* — so the count can sit one above the
bound until the next transfer starts. Worth knowing before a device with 89 MiB
of DEQR working data is treated as a leak; it is not one.

---

## 12. Findings that should change the product

### F1 — The repair budget is paid whether or not it is needed

At **zero loss**, 39–44% of everything delivered was redundant: the sender emits
`K` source symbols and then `0.75K` repair symbols for every segment, with no
back channel to learn that the receiver already has the segment. On a clean
optical link, **43% of the user's time is spent transmitting symbols nobody
needs.**

The upper bound on the fix is exact: Balanced without unnecessary repair is
8,232 B/s rather than 4,631 — **1.78×** — which turns 1 GiB from 64.4 hours into
36.2. Nothing in this phase implements it and nothing should: it is a protocol
change (the receiver would need to signal per-segment completion optically, or
the sender would need to interleave rather than run each segment to completion),
and this phase's rule is to measure, not to redesign. **Recorded for Phase 12 and
for whatever comes after it.**

### F2 — Loss degrades in a cliff, and the cliff has an equation

`(1 + r)(1 − p) ≥ 1.05`. Above `p = 0.40` at Balanced, no number of passes
completes a transfer. Between the design rate (0.20) and that ceiling, cost rises
by more than an order of magnitude — 17.7× at 0.30. The receiver already knows
its own accept and reject rates; **the UI should tell a user which side of 0.20
they are on** rather than letting a transfer silently take seventeen times
longer.

### F3 — Files below one segment are 1.7× faster per byte

Not a defect — a consequence of the receiver completing before the repair
symbols are sent. Worth knowing when quoting throughput: a 1 MiB file moves at
7,864 B/s and a 100 MiB file at 4,631, and the difference is entirely repair
overhead. **Do not quote a small-file rate as the product's rate.**

### F4 — Storage is not, and cannot become, the bottleneck

Measured on a real OPFS at 28.8 MiB/s, against an optical link at 4.5 KiB/s.
Even a store 200× slower than measured would consume under 1% of a segment's
optical window. The pre-sizing, the one-write-per-segment design and the bounded
hash windows have all been vindicated, and no further storage optimisation is
justified by evidence.

---

## 13. Certified maximum size

The plan's rule is explicit: the supported maximum is *"the largest size that has
passed the current release's physical-device certification matrix and
available-storage preflight."* The physical matrix has not been executed.
Therefore:

> ### DEQR's certified maximum transfer size is **0 bytes**.
>
> No size has been certified on a physical device. Nothing in the product,
> README, release notes or any listing may claim a maximum size or a maximum
> speed until `PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md` has rows in it.

What *may* be said, and is supported by this report:

> DEQR has no 32 MB protocol-level limit. Its architecture is streaming and
> multi-gigabyte safe: a 4 GiB transfer has been verified end to end, byte for
> byte, with receiver memory held flat at 1.34 MiB and sender memory at 1.37 MiB.
> The largest size DEQR *supports* is the largest that passes physical-device
> certification and the receiver's available-storage preflight, and physical
> certification has not yet been run.

The gap between those two statements is not a formality. At Balanced's measured
4,631 B/s, **1 GiB is a 64-hour continuous scan**. The pipeline can do it; whether
a phone, a battery, a camera and a person can is a different question and it is
the one still open.

---

## 14. Unresolved gates

All seven are detailed with their closing procedure in
`PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md` §9.

| # | Gate | Status |
|---|---|---|
| G1 | iOS Safari OPFS — WebKit's implementation, and the early promise-returning sync handle | **PENDING** |
| G2 | Share-sheet export size limit — no number has ever been claimed | **PENDING** |
| G3 | Compression refusal on a browser without `DecompressionStream` | **PENDING** |
| G4 | Withheld-ETA thresholds against a real camera's frame rate | **PENDING** |
| G5 | Resume across two devices — a human reading a 40-character token aloud | **PENDING** (proved in Node and in Chromium; never with a person) |
| G6 | Camera and thermal behaviour over a multi-hour tier | **PENDING** |
| G7 | Packaged Electron rather than the dev server | **PENDING** |

Additionally open, and not a physical gate:

- **The default profile is not certified.** §9's ranking says Balanced needs
  ≥3.5 camera pixels per module and Reliable survives 2.5. Which one should be
  the default depends on a number no one has measured. Runs P1 and P2 of the
  physical matrix decide it.

---

## 15. Deviations from the plan

Stated rather than quietly taken.

1. **No real-world file corpus.** The plan asks for representative
   PDF/DOCX/XLSX/ZIP/RAR/JPEG/MP4 fixtures "when legally and locally available".
   None are, and no file was read from the user's disk. Synthetic compressible,
   structured and random classes stand in. The gap this leaves is small: Phase 08
   already proved with real source trees that content reaches transport only
   through the compression decision, and this phase's ladder confirms the three
   classes produce identical transport with compression off.
2. **The compressed path is certified by the Node ladder and by Phase 08, not by
   a separate physical tier.** `--mode ladder --compression on` exercises it; the
   physical matrix adds a compressible run per tier because the two-file
   reservation is a storage behaviour no uncompressed tier exercises.
3. **Backpressure is half-measured.** Queue growth cannot occur in a pull-based
   harness. Stated in §8 rather than papered over.
4. **The profile ranking uses Phase 04's measured decode surface rather than
   re-measuring it.** Re-rendering 1.5 million QR symbols per ladder row is not
   practical, and the surface has not changed. Its non-monotonicity (Turbo
   decodes 76.7% at 3.5 px and 61.7% at 4 px) is a Phase 04 measurement artefact
   that shows up in the ranking and is flagged there.
5. **The other bench scripts are still not typechecked.** `npm run
   typecheck:phase11` covers this phase's harnesses only. Widening it surfaces
   pre-existing errors in Phases 04, 05 and the v2 vector generator, and fixing
   those is not this phase's work.
6. **Two mid-run harness corrections, both recorded.** The storage-provisioning
   window initially lost every frame of a sub-segment transfer, and incomplete
   runs initially carried a throughput number into the ranking. Both were harness
   defects, both were fixed, and every number in this report comes from a run
   after the fixes.

---

## 16. Commands and evidence

```bash
npm run typecheck:phase11
node --expose-gc node_modules/vite-node/vite-node.mjs scripts/bench/phase11-certification.ts -- --mode ladder --maxMib 1024
node --expose-gc node_modules/vite-node/vite-node.mjs scripts/bench/phase11-certification.ts -- --mode ladder --sizesMib 2048,4096 --classes random --maxMib 4096 --tag tier-e
node --expose-gc node_modules/vite-node/vite-node.mjs scripts/bench/phase11-certification.ts -- --mode channel --sizeMib 8
node --expose-gc node_modules/vite-node/vite-node.mjs scripts/bench/phase11-certification.ts -- --mode channel --sizeMib 8 --maxPasses 20 --tag deep
node --expose-gc node_modules/vite-node/vite-node.mjs scripts/bench/phase11-certification.ts -- --mode interrupt --sizeMib 8 --atFraction 0.6
node --expose-gc node_modules/vite-node/vite-node.mjs scripts/bench/phase11-certification.ts -- --mode backpressure --sizeMib 2
node --expose-gc node_modules/vite-node/vite-node.mjs scripts/bench/phase11-certification.ts -- --mode faults --sizeMib 8
node --expose-gc node_modules/vite-node/vite-node.mjs scripts/bench/phase11-certification.ts -- --mode profiles --sizeMib 8
npx vite --config scripts/bench/browser/vite.config.ts   # then open http://localhost:5312
```

Machine-readable results: `.ai-team/reports/performance/phase11/`.

Environment: Node v24.18.1, win32-x64, 8 CPUs, 32 GiB RAM, `--expose-gc` active.
Browser half: Chromium 148.0.7778.280 (Electron 42.9.2), OPFS quota 6,287 MiB.

Regression suites, unchanged by this phase and re-run to prove it: desktop
**842 PASS / 51 files**, PWA **378 PASS / 28 files**, `npm run typecheck`,
`npm run mobile-web:typecheck` and `npm run typecheck:phase11` all clean, doctor
**PASSED (0 warnings)**, drift check **PASSED**. Identical to the counts Phase 10
closed on.

**No file under `src/`, `mobile-web/src/`, `tests/`, `mobile-web/tests/` or
`protocol/` was modified by this phase.** A certification that changes the thing
it is certifying certifies a different product. Everything added is a harness, a
typecheck configuration, or a report; the two edits outside those are one npm
script and one `.claude/launch.json` entry.

---

## 17. Gate

**Phase 11 PASSES**, on the terms it set for itself:

- the automated correctness matrix is complete, hash-gated, and green from 1 KiB
  to 4 GiB across three data classes;
- the stress matrix is complete and its failure boundary is characterised by an
  equation rather than by an anecdote;
- profile results are ranked, with a recommendation and its stated dependency on
  an unmeasured constant;
- the receiver has been exercised against a real OPFS for the first time in the
  programme's history, including the export handoff;
- and **no physical row is claimed** — the matrix exists, it is precise, and every
  row in it says PENDING.

**Phase 12 (release gates) may proceed**, and inherits one hard constraint: it
may not ship a maximum-size or maximum-speed claim. §13 is the only wording this
phase's evidence supports.
