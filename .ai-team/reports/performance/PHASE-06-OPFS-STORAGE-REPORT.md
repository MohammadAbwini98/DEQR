# PHASE-06 — OPFS Large-File Storage, Offset Writes, and Export

**Program**: DEQR Large-File / Maximum-Speed Program
**Phase**: 06 (receiver working storage on OPFS, bounded-memory writes, checkpoints, storage preflight, file-backed export — no resume, no compression, no transfer UX)
**Date**: 2026-08-21
**Verdict**: **PASS** — every gate criterion is met with executed evidence. Nine deviations are stated in §8. Physical iPhone certification remains **PENDING** and is Phase 11's, unchanged.

---

## 1. Headline

**The receiver's memory has stopped being a function of the file.**

Before this phase the v2 receiver could only finish a transfer it could hold: segments accumulated in a bounded in-memory store of about 9 MB, and verification assembled every one of them into a single buffer to hand to `crypto.subtle.digest`. Both are gone.

A full receive of a logical file, written through the store and verified by reading it back, measured on real files:

| File | Segments | Store resident | **Peak JS growth** | Growth ÷ file | Retained after GC |
|---|---|---|---|---|---|
| 32 MiB | 15 | **0 B** | 13.1 MiB | 0.41 | 9.9 MiB |
| 128 MiB | 58 | **0 B** | 88.8 MiB | 0.69 | 1.0 MiB |
| 1 GiB | 461 | **0 B** | 106.7 MiB | 0.10 | −1.1 MiB |
| 4 GiB | 1,842 | **0 B** | **125.1 MiB** | **0.031** | −1.3 MiB |

**128× the file grows peak memory by 9.5× and retained memory by nothing.** The peak is segment buffers the collector has not reached yet — real pressure on a phone, and bounded by the collector rather than by the transfer. What the receiver is still *holding* once it has collected is flat at zero within measurement noise, at every size.

4 GiB is 128× the ~32 MB ceiling this program exists to remove, and it crosses the 32-bit boundary.

And the verification path, which was the other file-sized allocation:

| File | Assemble + WebCrypto | Streaming | **Heap ratio** | Digests agree |
|---|---|---|---|---|
| 16 MiB | 15.87 MiB | 1.29 MiB | 12× | yes |
| 64 MiB | 63.78 MiB | 1.31 MiB | 49× | yes |
| 256 MiB | 255.94 MiB | 0.36 MiB | **712×** | yes |

The old path allocates the file exactly. The new one allocates one 256 KiB window, and the ratio grows without bound because only one of the two numbers grows at all.

---

## 2. What was built

- **`src/core/sha256-stream.ts`** — an incremental SHA-256. `crypto.subtle.digest` is one-shot and needs its whole input resident, so a receiver that never holds the file cannot use it. Pinned against Node's own SHA-256 across every length from 0 to 129 bytes, at multi-block sizes, and across seven chunk-split sizes that never align to a block.
- **`mobile-web/src/opfs.ts`** — the storage seam: retyped File System API surfaces, capability detection, a runtime probe, the quota preflight, session paths, checkpoint metadata, and the retention sweep.
- **`mobile-web/src/opfs-segment-store.ts`** — one file per transfer, one exclusive synchronous access handle, pre-sized to the declared transport size, written at plan-derived offsets, checkpointed at segment boundaries.
- **`mobile-web/src/receiver-storage.ts`** — chooses storage at the manifest and refuses before scanning starts when there is nowhere to put the file.
- **`mobile-web/src/segment-store.ts`** — `write` now reports *which* refusal, not just that there was one.
- **`mobile-web/src/export.ts`** — a `File` over the OPFS entry rather than over a copy of it.
- **`mobile-web/src/receive-pipeline.ts`** — storage provisioning, streaming verification, retention on reset.
- **`scripts/bench/phase06-opfs-storage.ts`** — the harness behind every number above.

---

## 3. Acceptance gate

| Gate criterion | Evidence | Verdict |
|---|---|---|
| Received data can exceed memory comfortably | 4 GiB through the store at 125 MiB peak growth, 0 B resident (§1, `PHASE06_RECEIVE`) | **PASS** |
| 1 GB logical receiver test does not allocate 1 GB in JS memory | `opfs-segment-store.test.ts` — 1 GiB, 461 segments, `residentBytes()` 0 throughout, measured growth asserted under 256 MiB | **PASS** |
| Partial files survive intentional interruption when resume is enabled | `retention: 'retain'` keeps the directory; the checkpoint reads back with the committed bitmap bit-for-bit | **PASS** |
| Cancelled sessions clean up according to policy | Cancel deletes the directory and returns the store to zero bytes used | **PASS** |
| Working set bounded by segment/write buffers, not total file size | Two decoders plus one segment; `heldBytes` flat while `bytesCommitted` climbs | **PASS** |
| Temporary data managed deterministically | Sweep bounded twice, by age and by count; five lifecycle outcomes each asserted | **PASS** |

---

## 4. The measurements

### 4.1 Storage is not the bottleneck, and it is not close

Write-through, including an `fsync` per segment:

| File | Write | Verify (read + hash) |
|---|---|---|
| 32 MiB | 204 MiB/s | 107 MiB/s |
| 128 MiB | 195 MiB/s | 114 MiB/s |
| 1 GiB | 78 MiB/s | 116 MiB/s |
| 4 GiB | 94 MiB/s | 116 MiB/s |

Phase 04's fastest production profile, Turbo, delivers 1,139 B × 15 FPS ÷ 1.75 repair overhead = **9,763 verified B/s**. The slowest storage number above is **78 MiB/s — about 8,400× the channel**, and against the v1 link Phase 00 measured at 5,120 B/s it is 16,000×.

Nothing about storage will be visible next to the time spent pointing a camera at a screen. That is the answer to whether the synchronous-access-handle design was worth its constraints — worker-only, exclusive, one file at a time: it costs nothing that can be observed.

### 4.2 The hash is 3.5× slower than the platform's, and that is the right trade

| Size | WebCrypto | `Sha256Stream` | Slowdown | Projected per GiB |
|---|---|---|---|---|
| 16 MiB | 393 MiB/s | 113 MiB/s | 3.48× | 9.1 s |
| 64 MiB | 405 MiB/s | 115 MiB/s | 3.51× | 8.9 s |
| 256 MiB | 409 MiB/s | 116 MiB/s | 3.53× | 8.8 s |

Native SHA-256 is three and a half times faster and cannot be used, because it cannot be fed incrementally. The cost is stated rather than hidden: **a 1 GiB transfer ends with about nine seconds of verification**, on a desktop CPU, and proportionally more on a phone.

Against what that transfer costs optically at Turbo's 9,763 verified B/s — roughly **31 hours** — nine seconds is under 0.01% of the total. The trade is nine seconds against a hard ceiling, and it is not close either.

It is a visible wait nonetheless, which is why verification yields to the event loop every 16 MiB: the worker keeps reading its port, so a Cancel during a long verification is answered rather than queued behind the hash. Roughly sixty yields per gigabyte.

### 4.3 Memory is bounded by the segment, through the real pipeline

Driving real frames from the sender's own encoder through the real pipeline into a real store: six segments of file, peak held **never above three segments' worth**, `bytesCommitted` reaching the full transfer, `heldBytes` returning to the size of the committed bitmap — one bit per segment, 128 bytes for a 1 GiB transfer.

That divergence between *held* and *committed* is the phase, and it is asserted rather than described.

### 4.4 Pre-sizing turns a guess into an attempt

The file is truncated to the full transport size before the first segment arrives, which is the only check in the preflight sequence that is not an estimate:

1. **Can this context write to a device?** OPFS with a synchronous access handle — in practice, a worker on a current browser.
2. **Is there plausibly room?** `navigator.storage.estimate()`, plus a margin of 15% or 4 MiB, whichever is larger.
3. **Does the device actually accept it?** Creating the file and pre-sizing it.

A device that cannot hold the transfer fails at step 3, in the second after Receive is pressed, rather than forty minutes in. The gaps between arrived segments read back as zeros, which is why the checkpoint carries a bitmap of what is really present.

**The quota is never called free space.** `navigator.storage.estimate()` reports a grant the browser is willing to make; on iOS it moves with overall disk pressure. The preflight labels its answer `reported` or `unknown` and a browser with no estimate API is allowed to proceed, because refusing every transfer on such a browser would be worse than starting one that might fail at the far end — which the write path handles cleanly.

---

## 5. Three refusals, not one boolean

Phase 05's `SegmentStore.write` returned a boolean, and the only refusal it could express was "full". A real device has three, and collapsing them would put the wrong screen in front of a user:

| Outcome | Cause | What the user is told |
|---|---|---|
| `full` | Quota exceeded, or a short write | "Not enough room" — free space |
| `invalid` | Offset or length disagrees with the manifest's segmentation | Not a storage problem at all |
| `failed` | The writer itself broke | "Storage unavailable" — freeing space will not help |

Reporting a dead writer as a full disk sends someone to delete photos over a fault that has nothing to do with space. All three are terminal for the session; only one of them is actionable.

The store is the last code between camera-originated data and a byte offset in a file, so it re-derives every offset and length from the manifest's own segmentation and refuses anything that disagrees — an index outside the plan, an offset the plan does not put that segment at, a length that is not the segment's own, and a segment already committed. Those offsets happen to be locally derived today. The check is there because the protocol has room to carry explicit offsets later, and because a store that trusts its input is a store that can be told to write outside its file.

---

## 6. The one asynchronous step, and how it is fenced

Storage is chosen from the manifest's declared size, so opening it is asynchronous in a pipeline that is otherwise entirely synchronous per frame. Two consequences, both handled:

- **Frames arriving in that window** are reported as `pending-storage`: not accepted, not rejected, and deliberately not fingerprinted. The sender repeats everything, so the honest report is that the receiver was not ready — and remembering those frames would make it discard the very symbols it is waiting to use. A test submits a frame during the window and asserts the same frame is accepted afterwards.
- **A cancel landing inside the window** bumps a generation counter. A store that finishes opening for a session that no longer exists is released and discarded rather than attached to the next one — which on the OPFS path would mean writing one transfer's segments into another transfer's file. Asserted directly.

---

## 7. Export, and the ownership handoff

`getFile()` on an OPFS file handle returns a `File` that *refers to* the entry on disk. Wrapping it as `new File([entry], filename)` to give it the user's filename keeps the reference — blob parts are stored by reference — so a gigabyte-sized export allocates a descriptor rather than a gigabyte. No payload byte crosses back from the worker on the v2 path; only a path does, and that path is validated on receipt and again at the open against the exact shape this receiver writes.

Sealing a verified transfer closes the exclusive handle *before* the path is handed over. Without that, `getFile()` would fail on the last step of an hour-long transfer.

From `seal` onward the file belongs to the main thread, and the worker stops deleting it:

- **After a share** — deleted once `navigator.share` resolves, which is after iOS has taken the file.
- **After a download** — left for the next session's sweep. A blob URL is read by the browser's downloader on its own schedule, and removing the file underneath it would truncate a large save.
- **Cancelled, failed, interrupted** — deleted immediately.
- **Crashed or abandoned** — left deliberately, and collected by a sweep bounded twice: by age (24 h) and by count (3 sessions, newest kept).

---

## 8. Stated deviations

1. **No real OPFS implementation has been exercised.** Node has none. The tests run against a fake that models a quota, an exclusive lock, a dying writer, a short write, and the early Safari revision whose "synchronous" handle returned promises; the benchmarks run against real files through `fs`, which is a one-to-one mapping of the API and *not* a measurement of a phone. Physical certification is Phase 11's.
2. **The 1 GiB unit test uses a backing that stores no bytes.** It records which ranges were written, checks their contents against a generator as they arrive, and regenerates them on read. This is not a way of avoiding the test — it is the only way to run it in a process that must not allocate 1 GiB, and a segment written to the wrong offset still fails it, because an unwritten range reads back as zeros and changes the digest.
3. **The v2 path no longer uses WebCrypto.** A hand-written incremental SHA-256 replaces it, 3.5× slower and measured in §4.2. v1 still verifies through `ReceiverSession` and WebCrypto, unchanged.
4. **No export size limit is claimed for iOS.** Apple publishes none for the share sheet, `showSaveFilePicker` does not exist there, and the behaviour has changed between releases. What this build guarantees is only that DEQR is not the component imposing a ceiling.
5. **Download-route cleanup is deferred to the next session's sweep**, not done at export. The alternative races the browser's downloader against a delete.
6. **The worker protocol version moved 1 → 2.** `verified` carries a source descriptor instead of a byte buffer, `open` carries a storage margin, and `frame` can report `pending-storage`. A cached shell against a fresh worker bundle now fails at the handshake, which is what the version field is for.
7. **The v1 path still assembles in memory** and keeps its 64 MiB `LIMITS` ceiling. The shipping desktop sender still emits v1, so the OPFS path has no user-facing flow until Phase 09; it is reachable today only through the tests, the benches, and a v2 sender.
8. **Resume is not offered.** Retention defaults to `discard`; `retain` exists, is tested, and is Phase 07's to wire up.
9. **`heldBytes` changed meaning** from "bytes the decoders and the store hold" to "bytes resident in JavaScript memory". On the OPFS path the store contributes zero, which is the point. A doc comment in `src/core/segmented-receiver.ts` that contradicted its own code — claiming the committed bitmap was excluded when the code adds it — was corrected to match the code; no behaviour changed.

---

## 9. Verification

Everything below was executed and its output captured.

```text
npm run mobile-web:typecheck     clean
npm run typecheck                clean
npm run mobile-web:build         built in 1.48s, receive-worker chunk 198.86 kB
npm run mobile-web:test          20 files, 206 tests, all passed
npm test                         39 files, 609 tests, all passed
```

Phase 06 adds **56 tests**: 21 in `mobile-web/tests/opfs-segment-store.test.ts`, 25 in `mobile-web/tests/receiver-storage.test.ts`, 9 in `tests/core/sha256-stream.test.ts`, and one case added to the shared browser-safety contract, which the incremental hash now has to satisfy. The pre-existing 159 mobile-web tests and 600 root tests all still pass. Five existing test files were updated for the new store, payload and message shapes — `receive-pipeline`, `receive-worker-core`, `receiver-client-backpressure`, `worker-message-schema`, `protocol-v2-shared-codec` — with every prior assertion preserved.

Four of those updates were expectations that turned out to be wrong rather than stale, and each one is a fact about the system worth keeping: a repeated manifest during storage provisioning is a *duplicate*, not `pending-storage`, because the first one was acted on and remembered; and `heldBytes` after a completed transfer is the size of the committed bitmap, not zero, because that bitmap is genuinely resident.

Benchmarks (`.local-run/bench/` is gitignored; the tables in §1 and §4 are the durable copy):

```text
node --expose-gc node_modules/vite-node/vite-node.mjs \
  scripts/bench/phase06-opfs-storage.ts -- --mode receive --sizeMib 32|128|1024|4096
node --expose-gc node_modules/vite-node/vite-node.mjs \
  scripts/bench/phase06-opfs-storage.ts -- --mode compare --sizeMib 16|64|256
node --expose-gc node_modules/vite-node/vite-node.mjs \
  scripts/bench/phase06-opfs-storage.ts -- --mode hash --sizes 16,64,256
```

### 9.1 Two defects the benchmark found in its own gate

Worth recording, because both would have made a passing test meaningless.

**`heapUsed` is the wrong number.** The first `compare` run reported a *negative* heap growth for assembling 64 MiB into one buffer. A `Uint8Array`'s bytes live in external memory, not the V8 heap — so a receiver holding an entire gigabyte in one would have reported a flat `heapUsed` and passed the gate. Every memory measurement here, in the bench and in the 1 GiB test, now reads `heapUsed + arrayBuffers`.

**The capability probe caught the harness.** The first `receive` run refused to open with `STORAGE_UNSUPPORTED`. The bench had opened its file with `a+`, and append mode ignores the position argument — every offset the store computed would have collapsed to "the end". The probe that exists for the promise-returning Safari revision caught a completely different bug, in the first environment it ever ran against.

---

## 10. What Phase 07 inherits

- **A checkpoint written to be read.** `checkpoint.json` carries the schema version, the manifest's plan, the declared digest, and a base64 bitmap of committed segments — sized by the segment count, not by progress. It is written before the first segment lands, so a session that crashes immediately still leaves something identifiable rather than debris the sweep deletes.
- **A retention policy that already has both halves.** `retain` keeps the directory and its metadata; `discard` removes it. Phase 07 chooses when to pass which.
- **The reason the FEC overhead is 0.75.** Phase 03 recorded that a segment must close inside the pass in which it is received, and that the real fix needs Phase 06 storage *and* Phase 07 checkpoints. Half of that is now in place: partial progress survives in a file. Carrying partial *symbol* recovery across passes is the remaining half, and it is what would let the overhead come down.
- **An incremental hash.** `Sha256Stream` is on the shared browser-safe path and can be driven per segment as easily as per file, which is what per-segment integrity would need.
- **One measurement worth having before designing resume**: verification costs about 9 s/GiB. A resume that re-verifies from scratch on every reconnection would spend more time hashing than a fresh transfer spends scanning.
