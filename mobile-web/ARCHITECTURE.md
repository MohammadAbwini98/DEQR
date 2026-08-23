# DEQR Mobile Web/PWA Architecture

## Scope and boundary

`mobile-web/` is the active mobile receiver. The prior .NET MAUI sources in
`mobile/` are **SUPERSEDED, NOT ACTIVE, and preserved for history/reference**.
This PWA has no backend and does not send transfer contents over the network.

## Components and data flow

```text
Main thread                          Receive worker
-----------                          --------------
permissions, video lifecycle
receiver state machine
capture scheduling
  |
  | ImageBitmap (preferred) or
  | RGBA ArrayBuffer, transferred
  v
                                     jsQR decode
                                     fingerprint dedupe
                                     v1 / v2 frame parse + CRC
                                     fountain / segmented recovery
                                     SegmentStore -> OPFS sync access handle
                                     gzip container -> original.part (if compressed)
                                     streaming SHA-256 over the stored file
  ^                                    |
  |  counters only, throttled           |
  +-------------------------------------+
  |
  v
verified source descriptor           /deqr/sessions/<session>-<file>/
  |                                     data.part       (payload, binary)
  |                                     original.part   (compressed transfers only)
  |                                     checkpoint.json (progress metadata)
  v                                           ^
File over the OPFS entry ---------------------+
  |
  v
Web Share / download fallback
```

**No payload byte crosses back to the main thread on the v2 path.** The worker
hands over a *path*; the main thread opens the same file and wraps it in a
`File`, whose bytes are read from disk by the share sheet or the download. That
is the difference between a transfer bounded by the device and one bounded by a
tab's memory.

- `src/receiver-state.ts`: **the one authoritative state machine.** Transitions
  are data; whether the camera runs, whether cancel means anything, and whether
  the session's buffers may still be alive are all *derived* from the single
  state rather than stored beside it.
- `src/camera.ts`: user-initiated camera lifecycle and frame scheduling, main
  thread only. Asks `CaptureTarget.canAccept()` before reading a single pixel,
  so a saturated decoder costs a timer rather than a 1.5 MB readback. Prefers
  `createImageBitmap` transferred to the worker; falls back to a canvas
  readback where that or `OffscreenCanvas` is missing.
- `src/receiver-client.ts`: owns the worker, and **owns the queue bound** —
  at most `maxInFlight` (2) frames outstanding, with every posted frame
  guaranteed exactly one terminal event so a slot can never be leaked.
- `src/worker-protocol.ts`: versioned, guarded, bounded message schema. Both
  sides refuse anything stamped with another version, which is what stops a
  cached shell and a fresh worker bundle from misreading each other's fields.
- `src/receive-worker.ts` / `receive-worker-core.ts`: the worker entry and its
  behaviour. Decodes, refuses captures older than 250 ms without decoding them,
  and reports `OpticalObservation` — camera pixels per module, observed from
  jsQR's corner quad rather than assumed.
- `src/receive-pipeline.ts`: everything downstream of decode, with no DOM and no
  worker in it. Routes v1 to `ReceiverSession` and v2 to the `SegmentedReceiver`
  the desktop sender shares, dedupes, recovers, stores, and verifies.
- `src/frame-dedupe.ts`: bounded fingerprint set. Capacity is a memory bound,
  never a correctness parameter — a forgotten frame is re-parsed, and the
  session's own duplicate detection still catches it.
- `src/segment-store.ts`: the `SegmentStore` contract plus the bounded in-memory
  implementation used where OPFS is absent. `write` reports `ok`, `full`,
  `invalid` or `failed`; anything but `ok` is terminal for the session, and the
  three refusals stay distinguishable because they are three different things to
  tell a user.
- `src/opfs.ts`: the storage seam — retyped File System API surfaces, capability
  detection, a runtime probe for the Safari revision whose "synchronous" handle
  was not, the quota preflight, the session directory layout, checkpoint
  metadata, and the retention sweep.
- `src/opfs-segment-store.ts`: one file per transfer, opened once with an
  exclusive synchronous access handle, pre-sized to the declared transport size,
  and written at the offset the *manifest's own plan* computes — never at one
  taken from a frame. Holds no payload byte between writes.
- `src/receiver-storage.ts`: chooses storage at the manifest, in order — can this
  context write to a device, is there plausibly room, does the device actually
  accept the file — and refuses before scanning starts when the answer is no.
  For a compressed transfer "the file" means both of them: the container and
  what it expands into.
- `src/inflate-verify.ts`: expands a GZIP transport container into original
  bytes, one window at a time, under bounds taken from the manifest rather than
  from the stream. Refuses an oversized declared record length before
  allocating, an expansion past a window's declared size, a member that will not
  decode, and any byte past the last window.
- `src/opfs-original-sink.ts`: `original.part` — the file a compressed transfer
  is decompressed into, created and pre-sized when the session opens and opened
  for writing only during verification.
- `src/metrics.ts`: bounded instrumentation — rate windows, p50/p95 reservoirs,
  and a long-task observer that reports `supported: false` on Safari rather
  than reporting zero.
- `src/protocol.ts`: the v1 wire format, fountain decoder, resource limits,
  filename sanitization, SHA-256 and receiver session. Still authoritative for
  v1 because the shipping desktop sender still emits it.
- `src/receiver-view-model.ts`: every derivation the receive screen draws, with
  no React and no DOM — the transfer summary, the storage summary, the
  verification view, the interruption summary and the fault copy. Two rules run
  through it: a number is shown only when it was measured, and nothing in it can
  express success. `mayOfferExport(state)` is the single predicate gating the
  save control, so "offer a save" and "the hash matched" cannot come apart.
- `src/App.tsx`: accessible, state-driven UI. It is not the protocol authority
  and no longer holds any state of its own about the transfer. Since Phase 09 it
  is layout and side effects only; what each derived fact *says* lives in
  `receiver-view-model.ts`, and which phase of a transfer each state represents
  lives in `src/shared/transfer-ui-state.ts`, shared with the desktop sender.
- `src/export.ts`: user-controlled Web Share first, object-URL download
  fallback, over a `File` that references the OPFS entry rather than a copy of
  it. An export request is not reported as a Files save confirmation.
- `public/sw.js`: narrowly scoped application-shell caching only. It never
  caches transfer contents.

## Backpressure

Capture posts a frame only while fewer than `maxInFlight` are unanswered. The
bound cannot live inside the worker: jsQR is synchronous, so a worker is never
decoding one frame and receiving another, and anything posted early waits in the
worker's own message queue, which is unbounded and which the worker cannot trim.

Measured against a decoder eighteen times slower than the capture rate, for five
minutes: 18,000 capture attempts, 1,001 submitted, peak in-flight 2, peak worker
queue 2. Skipping a capture costs one timer.

## Trust boundaries and limits

Camera images, QR bytes, metadata, filenames, lengths, frame indexes, manifests,
and sender hashes are untrusted. The receiver rejects unsupported versions,
invalid checksums and CRCs, inconsistent sessions, unsafe or oversized
declarations, conflicting duplicates, truncated frames and containers, encrypted
containers, unsupported compression, blocked file extensions, length mismatch,
and hash mismatch before a file can be exported. v2 assembly checks what the
store actually accepted before hashing, never the manifest's declared size.

The store is the last code between camera-originated data and a byte offset in a
file, so it re-derives every offset and length from the manifest's segmentation
and refuses a write that disagrees. Those offsets happen to be locally derived
today; the check is there because a store that trusts its input is a store that
can be told to write outside its file. The same rule covers the OPFS path that
crosses back for the export — validated against the exact shape this receiver
writes, on receipt and again at the open.

v1 browser limits are centralized in `LIMITS`: 64 MiB reconstructed container,
65,535 blocks, 2 KiB block/frame payload, 255-character filenames. v1 keeps its
own numbers because it is a separate, frozen wire format whose unit of
allocation is a whole in-memory container.

**Every v2 receiver-side maximum lives in `src/core/receiver-policy.ts`** and
nowhere else — frame length, filename and MIME bytes, segment size, source
symbols per segment, the FEC work budgets, active decoders, frames in flight,
checkpoint size, the decompression window, worker pixels, the fallback store's
budget and the storage margin. `DEFAULT_WORKER_LIMITS` is now assembled from it
and is still passed at session open, never taken from a manifest.

Two rules make that module more than a container, and `tests/core/security-limits.test.ts`
holds both. Policy **narrows** what the wire format can express and may never
widen it, so every derived bound is computed from `V2_LIMITS` rather than typed
in. And a refusal is decided **before a device is touched**:
`manifestPolicyRefusal` runs after the parser has proved a manifest
self-consistent and before storage is provisioned, so a transfer this receiver
was never going to accept creates nothing on the device and is reported as the
refusal it is rather than as a storage failure.

A refusal also has to be visible. Every code `beginV2Session` can return is
recorded as a terminal session fault, because `progress().fault` is the only
route from the pipeline to a screen — without it a phone pointed at a blocked
file type or a transfer this browser cannot decompress went on scanning in
silence.

The export allowlist is a **closed set of two**: `isReceiverSessionFile` admits
`data.part` and `original.part` and nothing else. Two, because a compressed
transfer exports the decompressed file rather than the container it arrived in;
`checkpoint.json` is deliberately absent, since it is metadata this receiver
writes about a transfer and never something to hand a user.

## Storage and lifecycle policy

Recovered segments are written straight through to OPFS at the offset the
manifest puts them at, so **the receiver's working set is bounded by the segment
size, not the file size**: two decoders, one segment in flight, and a bitmap of
one bit per segment. Verification reads bounded windows back into an incremental
SHA-256, so nothing holds the file at the end either.

Where OPFS or a synchronous access handle is missing, the receiver falls back to
the bounded in-memory store and **refuses a transfer larger than it at the
manifest**, rather than starting one that was always going to stop partway.

Session data lives at `/deqr/sessions/<sessionId>-<fileId>/`, named from the
manifest's own identifiers so an interrupted transfer maps back to its partial
file. `checkpoint.json` records the plan, the declared digest, and a base64
bitmap of committed segments — sized by the segment count rather than by
progress, so a 4 GiB transfer's checkpoint is 810 bytes. It is written before
the first segment and coalesced afterwards: at most one write in flight and one
pending, and its `state` moves `receiving` → `complete` the moment the last
segment lands → `verified` only once SHA-256 has matched.

Lifecycle, decided by *how a session ended* rather than by one global policy:

- **Cancelled or failed** — the working file is deleted. Leaving half a transfer
  behind after somebody pressed Cancel would be a surprise, not a feature.
- **Interrupted** — the working file is **kept**, because the user did not
  choose to stop and is likely to come back. See resume below.
- **Verified and handed to an export** — ownership moves to the main thread, and
  the worker stops deleting it. Deleting a file the share sheet is reading would
  be a race against the user's own save.
- **After a share** — deleted once `navigator.share` resolves, which is after
  iOS has taken the file.
- **After a download** — left for the next session's sweep, because a blob URL is
  read by the browser's downloader on its own schedule and removing the file
  underneath it would truncate a large save.
- **Crashed or abandoned** — left deliberately, and collected by a sweep bounded
  twice, by age (24 h) and by count (3 sessions), that runs when the next
  session opens.
- **Failed its hash** — deleted at once, whatever the policy. Bytes the only
  authoritative check has rejected are not worth keeping, and keeping them would
  let a later resume adopt them and fail identically after a whole transfer.

A background/hidden app enters `INTERRUPTED`: every camera track stops and the
session's in-memory buffers are cleared and zeroed. Returning to the foreground
lands deterministically in `IDLE`.

## Resume

DEQR's channel is one-way — a display and a camera — so a receiver cannot tell a
sender what it already holds. Resume is therefore split across the two halves in
the only way an air gap allows:

- **On the receiver it is automatic.** Every session opens with `resume`, and
  when a manifest arrives the store looks for a checkpoint under that session's
  directory. It is adopted only if the session id, file id, declared digest and
  the entire segmentation all match, the bitmap agrees with its own counters, and
  the data file is still exactly the transport size. Anything else is reported as
  a typed rejection and the directory is cleared before the new transfer
  pre-sizes its file. Adoption of a 4 GiB transfer's checkpoint costs about 11 ms.
- **On the sender it is explicit.** The receiver shows a 40-character resume
  token — Crockford base32, CRC-guarded, carrying session id, file id, segment
  count, a five-byte digest prefix, and the lowest segment it still needs. The
  user types it into the desktop, which refuses it unless the selected file's
  digest and segmentation both agree, then reuses the token's identity and
  restarts at that segment.

Restarting at the *lowest missing* segment is deliberately conservative: the
sender re-sends some segments the receiver already has, each costing one bit
test, and skips nothing the receiver still needs. A resumed transfer is hashed
end to end exactly as a fresh one is — **a checkpoint is never evidence about
bytes**, only about which bytes were written.

## Compressed transfers

A Phase 08 sender may decide, from sampled entropy and never from a filename,
that a file is worth compressing. When it does, the segments carry a **GZIP
transport container** — a length-prefixed sequence of independently gzipped
windows of original bytes, specified in `PROTOCOL-V2.md` §4.5.

**Reception does not change.** The same frames arrive, the same decoders recover
them, and the same pre-sized file takes the same offset writes; `data.part`
simply holds the container instead of the file. Everything compression-specific
happens once, after the last segment lands:

1. `original.part` is opened — created and pre-sized at *session start*, not
   here, so a device that cannot hold both files refuses in the second after
   Receive rather than after an hour of scanning.
2. `inflate-verify.ts` walks the container one window at a time: read a length,
   check it against zlib's expansion ceiling for the window size **before
   allocating**, read that many bytes, decompress into a buffer sized to exactly
   what the manifest says the window holds, and write it at the window's
   original offset. Two reused buffers, so the pass is bounded by the window and
   not by the file.
3. The digest then runs over `original.part`, read back off the device, exactly
   as it runs over an uncompressed transfer.

The export route points at `original.part`; the container is never handed to a
user. Verification therefore has two phases for a compressed transfer, and the
`verify-progress` event names which one is running — a bar that silently
restarted at zero half way through would read as a stall.

Costs, measured (`PHASE-08-COMPRESSION-ADAPTATION-REPORT.md`): decompression
runs at 124–193 MiB/s, adding 5–8 s/GiB to a verification that was already
~9 s/GiB, and peak device usage becomes `originalSize + transportSize` until the
session is swept. A context with no `DecompressionStream` refuses the manifest
with `UNSUPPORTED_COMPRESSION` rather than starting a transfer it cannot finish.


## What the screen is allowed to say

Phase 09's rule, stated once because it is the property everything else here
exists to protect: **no screen may imply a verified file before the hash has
been compared.**

It is held structurally rather than by review. `src/shared/transfer-ui-state.ts`
defines one phase vocabulary for both ends of a transfer, and
`claimsIntegrityVerified(phase)` is true for exactly `VERIFIED` and `EXPORTING`.
`RECEIVER_PHASES` contains both; `SENDER_PHASES` contains neither, so a desktop
state cannot be mapped to a phase that makes the claim. The receiver's
`COMPLETE` is the only state in either surface reaching `VERIFIED`, and it is
entered only from the worker's `verified` event — which the worker emits only
after `sameDigest` returns true.

The desktop's ending is `COMPLETED`: every frame displayed, and nothing said
about what arrived. That distinction has a screen of its own on the sender,
which states in as many words that it is not a confirmation.

Three consequences on this side:

- **Verification is its own panel, not a frozen transfer bar.** The camera has
  already stopped, and the transfer's own progress is finished and static while
  a gigabyte takes nine seconds to hash. A compressed transfer reports two
  steps, because expansion walks the container and the hash walks the file —
  two different totals, which a single merged bar would make run backwards.
- **The segment bar is drawn only while it means something.** `RECEIVING` and
  `COMPLETE`. Not `VERIFYING`, which measures something else, and not `FAILED`,
  where a partial bar implies partial success.
- **A refusal carries its remedy, and says whose it is.** The one that could not
  be closed any other way is `UNSUPPORTED_COMPRESSION`: a sender decides to
  compress from bytes it sampled and cannot learn that this browser has no
  `DecompressionStream`, because the optical link is one-way by construction.
  There is no automatic path back, so the screen tells the user what to ask the
  desktop for, marked as an instruction for the *other* device.

## What the screen shows about storage

The receiver has always computed a storage preflight and refused transfers it
had no room for. Until Phase 09 the numbers were discarded before reaching a
screen, so a refusal could say `INSUFFICIENT_STORAGE` without saying how much
room it had wanted.

`ReceiveProgress` now carries `storageRequiredBytes`, `storageAvailableBytes`
and `storageConfidence`. The confidence is three-valued rather than a boolean
because the three cases want three different sentences:

| Confidence | Meaning | What the screen says |
|---|---|---|
| `none` | No preflight has run for this session | Nothing at all |
| `reported` | The browser answered | Both figures, named as quota rather than free space |
| `unknown` | No estimate API | That the check did not happen, never that there is room |

The home screen additionally reports a device-level estimate before any transfer
exists to size against, and says nothing when the browser will not answer. A
missing measurement is not a reassurance.

`discardRetainedSessions` is the user's way to reclaim what an interrupted
transfer kept. That data lives in origin-private storage, which the Files app
cannot see and the user cannot clear, so without the control the only ways out
were the retention sweep or deleting the whole site's data. It is implemented as
the existing sweep with both bounds set to zero — one piece of code removes a
session directory, and it can reach only names matching the fixed-width hex form
this receiver produces.

## Offline and HTTPS

The initial install/update requires a stable HTTPS origin. All app assets are
bundled locally; the service worker precaches the shell after registration and
cache-serves same-origin static requests. The receive worker is a separate
hashed chunk and is constructed when the app mounts rather than on the first
Receive tap, so it is fetched and cached while the page loads. Optical transfer
and integrity checks use local browser APIs only. No CDN, analytics, API,
WebSocket, or upload path is present.

## The shell cache, and what an upgrade does to it

The cache is named `deqr-mobile-shell-v4` and the name is versioned deliberately:
it is bumped whenever what the cache must *contain* changes, not only when the
strategy does, so a device can never go on reusing a cache written by a populator
whose rules have since changed. On `activate` the worker deletes every
`deqr-mobile-` cache that is not the current one — older *or* newer, which is
what makes a host rollback safe as well as an upgrade.

Strategy depends on what is being fetched: the document is network-first so a
reachable host always wins; hashed build assets are cache-first because their URL
changes when their bytes do; everything else is cache-first with a background
refresh; and the health probe is never touched at all, because reachability has
to be measured rather than remembered.

**Filling the cache is the page's job, and getting that wrong breaks offline in a
way nothing else does.** The worker knows its own `CORE` list — the document,
`boot.js`, the manifest and an icon — but it cannot know the hashed names of this
build's module and stylesheet, and it certainly cannot know about the receive
worker, which is constructed from JavaScript and appears in no element. So the
page sends it a list.

The list has to go to the *controlling* worker rather than the one that happened
to be active when registration resolved, and on an upgrade those are different
workers:

```text
navigation        -> served by the OLD worker (network-first, gets the new HTML)
document assets   -> fetched, cached by the OLD worker, into the OLD cache
new worker        -> installs, skipWaiting, activate DELETES the old cache
                     ... taking this build's assets with it
controllerchange  -> the new worker claims the page
```

A single post at registration time lands in the cache that is about to be
deleted, leaving the new cache holding its `CORE` list alone — so the shell it
serves names an `/assets/index-HASH.js` that exists in no cache, and the next
offline launch reproduces the exact permanent-white-page failure `boot.js` exists
to recover from. `main.tsx` therefore posts again on `controllerchange`, and once
more on `load` for assets fetched after mount.

The list itself is the union of the document's declared graph (`<script>`,
`<link>`) and its observed one (`performance.getEntriesByType('resource')`). The
observed half is not redundant: it is the only thing that names the receive
worker chunk, and an offline receiver that cannot start its decoder is not an
offline receiver.

Verified in a real browser during Phase 12: a device installed on the previous
release, upgraded, ends with the old cache gone, the new cache holding every
asset its document names, and the host stopped — every one of those assets still
served with a real 200 from cache.

## Known validation boundary

Node/browser integration tests prove desktop-compatible raw-byte QR decode,
protocol reconstruction for v1 and v2, worker message handling against real
rendered QR images, the in-flight bound, and PWA assets. A physical iPhone is
still required to validate Safari camera behavior, `createImageBitmap` and
`OffscreenCanvas` availability, installed standalone behavior, offline launch,
Share/Save behavior, and desktop-screen-to-camera optical performance. Safari
does not implement the `longtask` PerformanceObserver entry, so main-thread
long tasks are measurable on Chromium only; the equivalent claim for iOS rests
on the CPU-time measurement in `PHASE-05-PWA-CAPTURE-WORKERS-REPORT.md` §1.

Storage's boundary has moved but has not closed. The unit tests run against a
fake that models a quota, an exclusive lock, a dying writer and the
promise-returning Safari revision, and the Node benchmarks run against real files
through `fs`. Since Phase 11 there is also `scripts/bench/browser/` — the
shipping `ReceivePipeline` and `ReceiverStorage` in a worker, writing through a
**real Chromium OPFS** — which certifies transfers to 64 MiB, the export handoff,
interrupt-and-resume across two pipelines, and the retention policy. What none of
that is, is **WebKit**: iOS ships its own OPFS implementation, and Chromium
agreeing with the spec says nothing about Safari agreeing with Chromium. Real
storage rates are also ~100× below the `fs` numbers (28.8 MiB/s against 2,948),
so every rate in the Phase 06–08 reports is an upper bound rather than a device
number — which changes nothing about the design, because one write per segment
covers 298 optical seconds.

And **no export size limit is claimed**: iOS publishes none for the share sheet,
the behaviour has changed between releases, and what this build guarantees is
only that DEQR is not the component imposing one. That, and WebKit's OPFS, are
gates G1 and G2 of the physical certification matrix.
