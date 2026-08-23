# PHASE-07 — Incremental Integrity, Checkpoints, and Resume

**Program**: DEQR Large-File / Maximum-Speed Program
**Phase**: 07 (authoritative integrity, durable checkpoints, resumable sessions — no compression, no UX redesign, no physical certification)
**Date**: 2026-08-21
**Verdict**: **PASS** — every gate criterion is met with executed evidence. Seven deviations are stated in §8. Physical iPhone certification remains **PENDING** and is Phase 11's, unchanged.

---

## 1. Headline

**A transfer that is interrupted at 90% now finishes in 10% of the time, and the thing that decides whether it is real did not move.**

A 4 GiB transfer, interrupted after 1,658 of 1,842 segments, restarted from nothing but what was left on the device:

| | Value |
|---|---|
| Segments adopted from the checkpoint | **1,658 of 1,842** |
| Bytes adopted | 3,867,570,176 |
| Cost of adopting them | **5.55 ms** |
| Checkpoint read to do it | **810 bytes** |
| JS heap growth across the resumed run | 5.45 MiB |
| Store resident bytes | **0** |
| Verified against the original digest | **yes** |

Adoption is 5.55 ms because a checkpoint is one bit per segment. The 4 GiB case reads 231 bytes of bitmap; the 32 MiB case reads 2. **128× the file costs 2.2× the adoption time**, and the whole of that difference is JSON.

What that saves is not measured in milliseconds. At Phase 04's Balanced profile a 4 GiB transfer takes **249 hours**; interrupted at 90%, a resume finishes the remaining **24.9 hours** instead of starting the 249 again. The saving is 224 hours, and it is entirely optical: storage and hashing are four orders of magnitude away from mattering.

And the rule that has held since Phase 01 has not moved by an inch. **A resumed transfer is hashed end to end, over the whole reconstruction, and accepted only if it matches the manifest.** A checkpoint says which bytes were written. It has never been, and is not now, evidence about what those bytes are.

---

## 2. What was built

- **`src/core/resume-token.ts`** — the one thing that travels against the direction of the link. Forty Crockford base32 characters carrying session, file, segment count, a five-byte digest prefix, and the lowest segment the receiver still needs, behind a truncated CRC-32.
- **`src/core/segmented-receiver.ts`** — `adoptedSegments`, `segmentsAdopted`, `firstMissingSegment()`, `committedBitmap()`. A resumed session is a seeded one, not a second code path.
- **`mobile-web/src/opfs.ts`** — `matchCheckpoint`, `readCheckpointEntry`, and a validator that now checks every field the resume path reads.
- **`mobile-web/src/opfs-segment-store.ts`** — resume-aware `open`, which adopts, refuses, or clears; `state: 'complete'` recorded when the last segment lands.
- **`mobile-web/src/receive-pipeline.ts`** — checkpoint adoption, `SessionEndReason` and the retention it implies, verification progress, resume-token minting, and destruction of data the hash rejected.
- **`mobile-web/src/worker-protocol.ts`** — protocol 3: a resume flag on `open`, a session-ending reason on `reset`/`close`, a `verify-progress` event, and four new progress fields.
- **`src/main/streaming-sender.ts`** — `resumeToken` config, `applyResume`, `senderResumeToken`, and a pass that starts at a segment other than zero.
- **`scripts/bench/phase07-resume.ts`** — the harness behind every number here.

---

## 3. Acceptance gate

| Gate criterion | Evidence | Verdict |
|---|---|---|
| Interrupted transfer resumes without rewriting verified segments unnecessarily | 4 GiB resumed at 90%: 1,658 segments adopted, 184 sent. Five interruption points (1%, mid-segment, boundary, 50%, 99%) each resume and verify — `receiver-resume.test.ts` | **PASS** |
| Stale/mismatched session is rejected | Six refusals, each with its own code: different file, different segmentation, different session, corrupt, inconsistent bitmap, inconsistent byte count | **PASS** |
| Hash mismatch prevents export | `HASH_MISMATCH` returns a result with **no `value` field at all**, so no export route exists to ignore the code with. Asserted structurally | **PASS** |
| Checkpoint corruption has a safe recovery path | A truncated checkpoint is `CHECKPOINT_UNREADABLE`, its directory is cleared, and a full pass then verifies. Same for a missing and for a truncated data file | **PASS** |
| A resumable fixture is interrupted, reconstructed after reload, verified hash-identically, exported only after verification | `receiver-resume-worker.test.ts` — a *second worker* built from nothing, sharing only the device; export source is an OPFS path handed over after the digest matched | **PASS** |
| Final state never `verified` before SHA-256 matches | Checkpoint `state` goes `receiving` → `complete` (last segment lands) → `verified` (digest matched, in `seal`). Three tests, one per transition | **PASS** |
| Verification progress reported separately from transfer progress | `verify-progress` event, ~60 per GiB, monotonic, first at 0 and last at the full size | **PASS** |
| No unbounded FEC graph persisted | The checkpoint is one bit per segment and a few hundred bytes of JSON. A segment interrupted mid-recovery is restarted — see §8.3 | **PASS** |

---

## 4. The measurements

### 4.1 Adoption is bounded by the segment count, not the file

```
node --expose-gc node_modules/vite-node/vite-node.mjs \
  scripts/bench/phase07-resume.ts -- --mode adopt --sizes 32,128,1024,4096
```

| File | Segments | Adopted | Adopt | Checkpoint | Bitmap | Heap growth |
|---|---|---|---|---|---|---|
| 32 MiB | 15 | 11 | 5.05 ms | 496 B | 2 B | −22.4 MiB |
| 128 MiB | 58 | 43 | 3.81 ms | 507 B | 8 B | −28.8 MiB |
| 1 GiB | 461 | 345 | 6.56 ms | 579 B | 58 B | 0.19 MiB |
| 4 GiB | 1,842 | 1,381 | **11.24 ms** | **810 B** | 231 B | 0.43 MiB |

The negative heap figures at the small sizes are the collector reclaiming the seeding run; they are noise, and the point is that the two largest sizes show growth under half a megabyte for a transfer of four gigabytes.

**This is the number the resume policy turns on.** Adoption at 11 ms for the largest transfer the program contemplates is cheap enough to attempt on *every* session, which is why the receiver does — it does not ask a user whether to look, it looks, and refuses anything that does not match.

### 4.2 A resumed transfer, end to end, at four interruption points

```
node --expose-gc node_modules/vite-node/vite-node.mjs \
  scripts/bench/phase07-resume.ts -- --mode resume --sizeMib 256 --atPercent 1|50|90|99
```

| Interrupted at | Segments adopted | Adopt | Second run | Verify | Verified |
|---|---|---|---|---|---|
| 1% | 1 of 116 | 3.74 ms | 1.27 s | 2.23 s | yes |
| 50% | 58 of 116 | 3.82 ms | 1.33 s | 2.22 s | yes |
| 90% | 104 of 116 | 3.50 ms | 0.12 s | 2.27 s | yes |
| 99% | 115 of 116 | 3.76 ms | 0.003 s | 2.27 s | yes |

Adoption is flat at ~3.8 ms across a hundredfold range of *how much* was adopted, because the bitmap is the same size either way.

At larger sizes:

| File | Segments | Adopted at 90% | Adopt | Verify | Verify rate | Store resident |
|---|---|---|---|---|---|---|
| 256 MiB | 116 | 104 | 3.50 ms | 2.27 s | 113 MiB/s | 0 B |
| 1 GiB | 461 | 415 | 5.25 ms | 8.82 s | 116 MiB/s | 0 B |
| 4 GiB | 1,842 | 1,658 | 5.55 ms | 35.79 s | 114 MiB/s | 0 B |

### 4.3 What a resume is actually worth

Storage and hashing are irrelevant next to the channel, so the saving is entirely the segments not put back on a screen. Computed from the profile table's own throughput model rather than a second copy of the arithmetic:

```
node --expose-gc node_modules/vite-node/vite-node.mjs \
  scripts/bench/phase07-resume.ts -- --mode saving
```

| Profile | Verified B/s | 1 GiB whole | …resumed at 90% | Saved |
|---|---|---|---|---|
| Reliable | 1,232 | 242.1 h | 24.2 h | **217.9 h** |
| Balanced | 4,786 | 62.3 h | 6.2 h | **56.1 h** |
| Turbo | 9,933 | 30.0 h | 3.0 h | **27.0 h** |
| Experimental | 22,326 | 13.4 h | 1.3 h | **12.0 h** |

At 4 GiB and Balanced the whole transfer is 249 hours and the resume is 24.9. **The 35.8-second verification pass this phase adds to that resume is 0.04% of it.**

### 4.4 The plan's own warning, checked

The Phase 06 handover recorded that verification costs ~9 s/GiB and warned that *"a resume that re-verifies from scratch on every reconnection would spend more time hashing than a fresh transfer spends scanning."*

Measured here: 8.82 s/GiB, confirming the figure. The design answers the warning by structure rather than by optimisation — **verification runs exactly once, at the end, resumed or not.** A checkpoint is adopted in 5 ms without hashing anything, and the single end-of-transfer pass is the same pass a fresh transfer runs.

The arithmetic that makes this the right shape: at Balanced, re-verifying on each of ten reconnections of a 1 GiB transfer would cost 88 seconds of hashing against 62 hours of scanning — still negligible, which is exactly why it was worth checking rather than assuming. The reason to verify once is not cost. It is that a partial file has no digest to be checked against; only the whole reconstruction does.

---

## 5. The design, and why it is shaped like this

### 5.1 The channel runs one way, so the user is the return path

DEQR is a display and a camera pointed at it. There is no acknowledgement channel, and every resume design that assumes one is unimplementable here. What is available is the person holding the phone, standing at the desktop.

So resume is split, asymmetrically, along the line of what each side can know:

- **The receiver knows everything and resumes automatically.** When a manifest arrives it already holds the session id, the file id, the digest and the plan. It looks for a checkpoint under that session's directory and adopts it if — and only if — all four match, the bitmap agrees with its own counters, and the data file is still exactly the transport size. No user decision is involved because none is needed.
- **The sender knows nothing and must be told.** It cannot discover which segments arrived. So the receiver renders a token, the user carries it, and the desktop restarts there.

### 5.2 Forty characters, and what is in them

| Field | Bytes | Why it is there |
|---|---|---|
| version | 1 | A build that writes a different shape is refused, not misread |
| sessionId, fileId | 8 | The receiver's directory name. Without these the sender resumes into nothing |
| segmentCount | 4 | Segment 400 of a 1 MiB plan is not segment 400 of a 4 MiB plan |
| resumeFromSegment | 4 | The lowest segment nothing has committed |
| sha256 prefix | 5 | Catches the wrong file in the second after selection, not as a hash failure hours later |
| CRC-32, truncated | 3 | A typo guard |

Twenty-five bytes is exactly two hundred bits, which is exactly forty Crockford base32 characters with no padding. Crockford rather than standard base32 because this string is read off one screen and typed into another: its alphabet omits `I`, `L`, `O` and `U`, and the reader folds `I`/`L` onto `1` and `O` onto `0` — so the three confusions a person actually makes are handled rather than rejected. Case and separators are ignored.

**Every single-character substitution is caught.** All 1,240 of them are enumerated in the test suite, because the failure that matters is not a token that fails to decode — it is a token that decodes to a *different valid token* and sends a sender to the wrong segment of the right file with no warning at all.

### 5.3 Why the lowest missing segment, and not the set of missing ones

The sender emits segments in order, so a receiver's progress is a prefix with at most a few gaps at its leading edge. Restarting at the lowest missing index replays very little in the common case, and in every case it is **conservative**: the sender re-sends some segments the receiver already has, each costing one bit test, and skips nothing the receiver still needs.

A compressed set of exactly the missing segments would save channel time in a case that is rare, and cost a token nobody can read aloud — a 4 GiB transfer's bitmap is 231 bytes, which is 370 base32 characters.

### 5.4 Retention became a function of *how* a session ended

Phase 06 shipped one policy for the whole pipeline, and the default was `discard`, because nothing could use a retained file. Now something can, and the four endings want three different answers:

| Ending | Policy | Reason |
|---|---|---|
| `cancelled` | discard | The user chose to stop. A half-received file surviving that would be a surprise, not a feature |
| `failed` | discard | Nothing to resume |
| `interrupted` | **retain** | The user did not choose this and will likely come back |
| `completed` | retain | Already handed to an export; deleting races the user's save |

This is a deliberate change to the receiver's standing privacy posture, and it is stated rather than slipped in. Previously *every* backgrounding deleted the partial file. Now backgrounding keeps it, bounded by the sweep that Phase 06 already built — 24 hours, or three sessions, whichever comes first — in a directory no other origin can read and that the Files app does not show. **A cancel still deletes immediately**, which is the case where a user has expressed an intention.

The reason travels on the wire, on `reset` and `close`, because only the main thread can tell these apart: the worker sees a session ending and cannot distinguish a Cancel tap from a backgrounded tab. An unrecognised reason is a **refused message**, not a defaulted one — guessing here would mean guessing whether to delete somebody's partial transfer.

### 5.5 Data the hash rejected is destroyed

`HASH_MISMATCH` now deletes the working file immediately, whatever the retention policy says. Two reasons, and the second is the one that matters: no export can be offered from bytes that failed the only check that decides identity, and **leaving them on the device would let a later resume adopt them and fail in exactly the same way after scanning the whole transfer again.**

---

## 6. Six refusals, and why each is its own code

A checkpoint tells the receiver that bytes already on the device are *already received*. Believing a wrong one does not produce an error — it produces a file with someone else's data in the first half, which passes every check except the last one, hours later.

| Rejection | Cause | What happens to the directory |
|---|---|---|
| `CHECKPOINT_ABSENT` | Nothing there. The ordinary first run | Left; nothing to clear |
| `CHECKPOINT_UNREADABLE` | Truncated, malformed, or a schema this build does not know | **Cleared** |
| `CHECKPOINT_SESSION_MISMATCH` | The identity inside disagrees with the path it is at | **Cleared** |
| `CHECKPOINT_FILE_MISMATCH` | Same session, different digest | **Cleared** |
| `CHECKPOINT_PLAN_MISMATCH` | Same file, different segmentation | **Cleared** |
| `CHECKPOINT_INCONSISTENT` | The bitmap disagrees with its own counters, or with the plan's byte total | **Cleared** |

Clearing matters as much as refusing. A directory holding another transfer's bytes, left in place, would be pre-sized for the new transfer — and its gaps would then read back as *that data* rather than as zeros.

Two further cases are caught after the checkpoint validates, because a checkpoint cannot speak for the payload: a **missing data file** and a **truncated one**. Both fall through to a clean start rather than a failure, because the user asked to receive a file and the honest answer to unusable partial data is a fresh transfer.

### 6.1 One defect this found in the code it was written against

The first version of the corrupt-checkpoint test failed, reporting `CHECKPOINT_ABSENT` where `CHECKPOINT_UNREADABLE` was expected — because `readCheckpoint` collapsed "there is no file" and "there is a file and it is broken" into the same `null`.

That is not a cosmetic difference. The rejection code is what decides whether the directory is cleared, so a corrupt checkpoint was leaving its payload in place. `readCheckpointEntry` now returns both facts, and the collapse is impossible to reintroduce silently.

---

## 7. Verification progress

Hashing a gigabyte takes about nine seconds, during which transfer progress is complete and unchanging. A receiver that reported only the first number would look frozen at exactly the moment somebody is watching hardest.

So `verify-progress` is a separate event, emitted at the hash's existing yield boundaries — about sixty per gigabyte. Not per 256 KiB window, which would be four thousand messages per gigabyte for a bar nobody can see move that fast.

It is bound to the epoch at `open`, so a verification still running for an abandoned session cannot post progress against the one that replaced it.

---

## 8. Stated deviations

1. **The resume token is not an integrity mechanism.** Its digest prefix is five bytes: enough to stop a user resuming last week's transfer onto this week's, not enough to be called a check. SHA-256 over the reconstruction remains the only authority, and a test asserts explicitly that a digest differing past the fifth byte is *not* caught by the token — because the limit of a check has to be recorded, not implied.
2. **No per-segment digest was added.** The plan lists it as optional. It would require the *sender* to compute and transmit one — a manifest or frame-type change, which is Phase 01's territory — and it would only detect storage corruption after a write that the final SHA-256 already covers. Recorded as decided-against in `PROTOCOL-V2.md` §12 rather than left open.
3. **A segment interrupted mid-recovery is still restarted.** Whole committed segments now survive a restart; the partial equations of the segment in flight do not. Persisting them would mean persisting a FEC graph, which the program's own rules forbid and the phase brief explicitly permits restarting instead. This is what remains of Phase 03's `0.75` repair overhead note, and it is now the *only* remaining half.
4. **The retention change is a privacy posture change.** Backgrounding used to delete a partial transfer and now keeps it. Bounded by the existing sweep and confined to OPFS, but it is a change, and §5.4 is where it is argued rather than a footnote.
5. **No real OPFS implementation has been exercised.** Unchanged from Phase 06 and still Phase 11's. Tests run against a fake that models a quota, an exclusive lock, a dying writer, a short write and the promise-returning Safari revision; the bench runs against Node `fs`, which is a one-to-one mapping of the API and *not* a measurement of a phone.
6. **The worker protocol moved 2 → 3.** A cached Phase 06 shell against a Phase 07 worker fails at the handshake, which is what the version field is for. Asserted directly.
7. **The sender's resume is reachable through IPC but has no UI.** `streamTransfer.select(resumeToken?)` carries it through preload and the main process, validated and length-bounded on receipt. A screen to type a token into is Phase 09's, per the phase brief's "expose typed states/events only".

---

## 9. Verification

Everything below was executed and its output captured.

```text
npm run typecheck                clean
npm run mobile-web:typecheck     clean
npm run mobile-web:build         built in 1.47s, receive-worker chunk 206.55 kB
npm test                         41 files, 643 tests, all passed
npm run mobile-web:test          23 files, 262 tests, all passed
```

Phase 07 adds **90 tests**: 19 in `tests/core/resume-token.test.ts`, 15 in `tests/main/streaming-sender-resume.test.ts`, 26 in `mobile-web/tests/receiver-resume.test.ts`, 17 in `mobile-web/tests/receiver-integrity.test.ts`, 6 in `mobile-web/tests/receiver-resume-worker.test.ts`, and 7 added to the existing `worker-message-schema` contract. The pre-existing 609 root tests and 206 mobile-web tests all still pass, unmodified.

The token test enumerates **all 1,240 single-character substitutions** of a real token and asserts every one is rejected.

Benchmarks (`.local-run/bench/` is gitignored; the tables in §1 and §4 are the durable copy):

```text
node --expose-gc node_modules/vite-node/vite-node.mjs \
  scripts/bench/phase07-resume.ts -- --mode resume --sizeMib 256|1024|4096 --atPercent 1|50|90|99
node --expose-gc node_modules/vite-node/vite-node.mjs \
  scripts/bench/phase07-resume.ts -- --mode adopt --sizes 32,128,1024,4096
node --expose-gc node_modules/vite-node/vite-node.mjs \
  scripts/bench/phase07-resume.ts -- --mode saving
```

### 9.1 The interruption matrix, as the brief lists it

| Case | Where it is asserted |
|---|---|
| Interrupt at 1% | `receiver-resume.test.ts` — nothing committed yet; adopts 0 and still verifies |
| Interrupt mid-segment | 128 symbols in; the incomplete segment is restarted, the complete one adopted |
| Interrupt at a segment boundary | Exactly 2 segments; no partial state to lose |
| Interrupt at 50% | 3 of 6 |
| Interrupt at 99% | 5 of 6; only the short final segment remains |
| Restart the PWA | `receiver-resume-worker.test.ts` — a second `ReceiveWorker` sharing only the device |
| Mismatched sender session | `CHECKPOINT_SESSION_MISMATCH`, directory cleared |
| Corrupt checkpoint | `CHECKPOINT_UNREADABLE`, cleared, clean transfer then verifies |
| Missing temp file | Falls through to a clean start; full pass verifies |
| Duplicate replay of completed segments | Every frame for an adopted segment returns `duplicate`; counters unchanged |
| Final hash mismatch | No export route exists on the failure; working data destroyed |
| Zero-byte file | Refused by the sender (`FILE_EMPTY`) and undescribable by the protocol (`planSegmentation` rejects a transport size below one byte) |

---

## 10. What Phase 08 inherits

- **A verified transfer path that does not care how it got there.** Resumed or fresh, the reconstruction is hashed end to end. Compression will change what `transportSize` means relative to `originalSize`, and the one place that assumption is currently asserted — `verifyV2` refusing a manifest where the two differ — is the seam to open.
- **A checkpoint that already carries `originalSize` and `transportSize` separately**, plus `compressionMode` reachable from the manifest it validates against. A compressed transfer's checkpoint needs no new field; it needs the two sizes to be allowed to differ.
- **A resume token bound to the *plan*, not to compression.** `segmentCount` is what it carries, and a compression mode that changes the transport size changes the segment count with it — so a token minted under one compression setting is already refused under another, by the check that exists.
- **The remaining half of Phase 03's `0.75` repair overhead.** Whole segments now survive an interruption; partial symbol recovery within a segment does not, and cannot without persisting a FEC graph. That is the last thing standing between the measured overhead and a lower one.
