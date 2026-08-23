# PHASE-08 — Adaptive Compression and Extension-Neutral Throughput

**Program**: DEQR Large-File / Maximum-Speed Program
**Phase**: 08 (sample-based adaptive streaming compression; no UX redesign, no security re-threat-model, no physical certification)
**Date**: 2026-08-22
**Verdict**: **PASS** — every gate criterion is met with executed evidence. Seven deviations are stated in §9. Physical iPhone certification remains **PENDING** and is Phase 11's, unchanged.

---

## 1. Headline

**A file's name can no longer reach a transport decision, and a compressible file now takes a quarter of the optical time it did — because the sender measured it, not because it ended in `.txt`.**

This repository's own TypeScript, 16 MiB of it, sent through the real streaming sender at the Balanced profile:

| | Uncompressed | Compressed |
|---|---|---|
| Original bytes | 16.00 MiB | 16.00 MiB |
| Optical bytes | 16.00 MiB | **4.30 MiB** |
| Ratio | 1.000 | **0.269** |
| Optical hours | 0.97 | **0.26** |
| Effective original bytes/sec | 4,786 | **17,820** |
| **Speed-up** | — | **3.72×** |

The same sender, over 16 MiB of high-entropy bytes:

| | Value |
|---|---|
| Compression applied | **none** |
| Reason | `BELOW_THRESHOLD` |
| Optical bytes | 16.00 MiB — byte-identical to the uncompressed path |
| Cost paid | one 48 KiB sample, 16 ms |

And the gate's own sentence, run end to end: **identical bytes opened as `.txt`, `.zip`, `.pdf`, `.xlsx` and `.bin` produced one decision, one transport size, one segment count and one digest — five times out of five, for both compressible and incompressible content.**

---

## 2. What was built

| Component | File |
|---|---|
| The decision, from bytes and nothing else | `src/core/compression-policy.ts` |
| GZIP container format, window plan, manifest rules | `src/core/protocol-v2.ts` §compression windows |
| Sender-side container encoder | `src/main/window-compressor.ts` |
| Sender preflight, fused hash + sizing pass | `src/main/streaming-sender.ts` |
| Receiver-side expansion, bounded and fail-closed | `mobile-web/src/inflate-verify.ts` |
| The file a container expands into | `mobile-web/src/opfs-original-sink.ts`, `mobile-web/src/segment-store.ts` |
| Two-phase verification | `mobile-web/src/receive-pipeline.ts` |
| Benchmark harness | `scripts/bench/phase08-compression.ts` |
| Normative spec | `.ai-team/engineering/PROTOCOL-V2.md` §4.5 |

**No new dependency was added.** Compression is `node:zlib` on the sender and `DecompressionStream('gzip')` on the receiver — both already present in the runtimes DEQR targets, both offline, neither affecting CSP or bundle size beyond the 9 kB of DEQR code that drives them. The plan's WASM-audit requirement therefore does not apply; nothing was proposed to audit.

---

## 3. Acceptance gate

| Gate criterion | Evidence | Result |
|---|---|---|
| Identical bytes renamed to different extensions produce identical compression decision | `PHASE08_NEUTRAL … distinctDecisions=1 verdict=identical` for both a compressible and an incompressible fixture; `tests/main/streaming-sender-compression.test.ts` asserts mode, param, transport size, segment count and digest are all identical across five names | **PASS** |
| Incompressible bytes bypass compression | 16 MiB of high-entropy bytes: `applied=none reason=BELOW_THRESHOLD ratio=1`, transport size equal to original size | **PASS** |
| Compressible data improves effective throughput | 3.72× on real source, 8.87× on tabular data, 11.12× on JSON, measured as optical seconds at the Phase 04 Balanced rate | **PASS** |
| Compression never weakens integrity semantics | `sha256` and `originalSize` describe the original file in both modes, asserted directly; verification hashes the decompressed file read back off the device; a corrupt container fails before the hash and a wrong digest still fails after it | **PASS** |
| No extension branch influences raw transport/compression | `decideCompression` has three parameters and none of them can carry a name; asserted structurally and end to end | **PASS** |
| Sample only bounded byte ranges | Three windows of 256 KiB (4 KiB in tests), reusing the preflight scratch buffer; no additional allocation | **PASS** |
| Never precompress the entire file into memory | Sender holds one window and one record: **budget 3.39 MiB, peak 2.51 MiB, unchanged from a 64 MiB file to a 256 MiB one** | **PASS** |
| Decompression bombs and size mismatches guarded | Five separate refusals, each with its own code and its own test; the output bound is a manifest constant and the allocation bound is zlib's expansion ceiling | **PASS** |
| Compression/decompression off the main UI thread | Sender: Electron main process. Receiver: the receive worker, with a yield every 16 MiB | **PASS** |

---

## 4. The measurements

All figures from `scripts/bench/phase08-compression.ts`, Windows 10, Node v24.18.1. Optical seconds are derived from `expectedVerifiedBytesPerSecond(BALANCED_PROFILE, designLossRate)` = **4,786 B/s**, Phase 04's own function rather than a rate re-derived in the harness.

### 4.1 What compression is worth, per content shape

`--mode corpus --sizeMib 16`

| Fixture | Ratio | Applied | Reason | Optical hours | Effective B/s | Speed-up |
|---|---|---|---|---|---|---|
| **source** (this repo's TypeScript) | 0.269 | gzip | `MEASURED_ABOVE_THRESHOLD` | 0.26 | 17,820 | **3.72×** |
| table (CSV rows) | 0.113 | gzip | `MEASURED_ABOVE_THRESHOLD` | 0.11 | 42,454 | 8.87× |
| json (object per row) | 0.090 | gzip | `MEASURED_ABOVE_THRESHOLD` | 0.09 | 53,215 | 11.12× |
| text (synthetic prose) | 0.016 | gzip | `MEASURED_ABOVE_THRESHOLD` | 0.02 | 301,782 | 63.05× |
| mixed (⅛ text, ⅞ entropy) | 0.754 | gzip | `MEASURED_ABOVE_THRESHOLD` | 0.73 | 6,346 | 1.33× |
| **random** | **1.000** | **none** | `BELOW_THRESHOLD` | 0.97 | 4,786 | **1.00×** |

**`source` is the number to quote.** The synthetic generators exist to sweep a parameter and are useless as ratio estimates — a sixteen-word vocabulary compresses far better than anything a person wrote, which is why `text` reaches 63×. The `source` row is real text with real entropy, read from the repository, and 0.269 is in the range published for source and prose generally.

Sampling cost is 4–18 ms for three bounded windows, whatever the file size. Full-file sizing cost is in §4.4.

### 4.2 The extension is not consulted, demonstrated rather than asserted

`--mode neutral --sizeMib 8`

```text
PHASE08_NEUTRAL fixture=table  names=5 distinctDecisions=1 verdict=identical
PHASE08_NEUTRAL fixture=random names=5 distinctDecisions=1 verdict=identical
```

Each run opens the *same buffer* five times as `payload.txt`, `payload.zip`, `payload.pdf`, `payload.xlsx` and `payload.bin`, and hashes together the compression mode, the window exponent, the transport size, the segment count and the file digest. One distinct value means the five transfers are indistinguishable on the wire.

This is a demonstration, not the guarantee. The guarantee is structural: `decideCompression(originalSize, sample, options)` has no parameter that could carry a name, a MIME type or a path, and `tests/core/compression-policy.test.ts` asserts both its arity and that its source text contains no such identifier. A future change that reintroduced extension-based dispatch would have to add a parameter, and would fail there.

### 4.3 Where the threshold belongs

`--mode threshold --sizeMib 16`, sweeping the fraction of a file that is text:

| Text % | Ratio | Gain | Optical hours saved **per GiB** | at 5% | at 10% | at 20% |
|---|---|---|---|---|---|---|
| 0 | 1.0003 | −0.03% | −0.02 | skip | skip | skip |
| 5 | 0.951 | 4.9% | 3.04 | skip | skip | skip |
| 10 | 0.902 | 9.8% | 6.11 | compress | skip | skip |
| 15 | 0.853 | 14.7% | 9.18 | compress | compress | skip |
| 20 | 0.804 | 19.7% | 12.25 | compress | compress | skip |
| 30 | 0.705 | 29.5% | 18.38 | compress | compress | compress |
| 50 | 0.508 | 49.2% | 30.66 | compress | compress | compress |

**The threshold is not a throughput decision — it is a storage decision, and the sweep is what makes that visible.** In optical time, even a 5% gain saves three hours per gigabyte, which dwarfs the ~24 s/GiB of sender CPU and ~8 s/GiB of receiver CPU it costs. If time were the only axis the threshold should be near zero.

It is not near zero because of what the receiver pays in space. A compressed transfer holds the container *and* the file it expands into at once, so peak device usage is `originalSize + transportSize`. At a marginal 5% gain that is 1.95× the file; at the measured `source` ratio it is 1.27×. Asking a phone to find nearly twice the file's space to save 5% is a bad trade; asking it to find 1.27× to save 74% is an obvious one.

**10% is kept as the default**, matching the plan's 8–10% ask and sitting where the storage multiplier starts to fall. It is a configurable field (`compressionThreshold`), the evidence for moving it is the table above, and `tests/main/streaming-sender-compression.test.ts` asserts a caller can move it and that the decision follows.

### 4.4 zlib level: 6, and the reason

`--mode levels --sizeMib 16`, real source corpus:

| Level | Ratio | MiB/s |
|---|---|---|
| 1 | 0.319 | 107.4 |
| 4 | 0.280 | 70.0 |
| **6** | **0.269** | **39.4** |
| 9 | 0.268 | 26.9 |

Level 6 takes 15.7% more off the wire than level 1 for 2.7× the CPU. The CPU is invisible: at level 6 the sizing pass costs ~24 s/GiB against an optical link that needs *hours* per gigabyte, so a ratio improvement is worth almost any compression cost DEQR can pay. Level 9 buys 0.2% for another 1.5× — the knee is at 6, which is also zlib's default.

On incompressible bytes every level lands at 1.0003 and ~46 MiB/s, which is the cost the *sampler* exists to avoid paying over a whole file.

### 4.5 Window size: 1 MiB, and the reason

`--mode window --sizeMib 16`, tabular fixture:

| Window | Windows | Ratio | Framing as % of file |
|---|---|---|---|
| 64 KiB | 256 | 0.1286 | 0.0061% |
| 256 KiB | 64 | 0.1167 | 0.0015% |
| **1 MiB** | **16** | **0.1127** | **0.0004%** |
| 4 MiB | 4 | 0.1118 | 0.0001% |

Framing is negligible everywhere — that is not what decides it. What decides it is that windows share no deflate history, so a small window throws away cross-window matches: 64 KiB costs 14% of the compression that 1 MiB achieves. Going past 1 MiB recovers only another 0.8% and doubles the buffer a phone must hold to expand one window. **1 MiB is the knee**, and it is `compressionParam = 20`.

### 4.6 Sender memory does not know the file size

`--mode memory`

| File | Mode | Budget | Peak buffered | Frames | Within budget |
|---|---|---|---|---|---|
| 64 MiB | gzip | 3.39 MiB | 2.51 MiB | 19,470 | yes |
| 256 MiB | gzip | 3.39 MiB | 2.51 MiB | 76,906 | yes |

Four times the file, identical budget, identical peak. The budget grew by one window plus one record (`compressorBudgetBytes`) over the uncompressed path, and that term is a function of `compressionParam`, not of the transfer.

`tests/main/window-compressor.test.ts` asserts the same bound against the encoder directly, including that the peak is genuinely at least one window — a bound that passed because nothing was ever loaded would prove nothing.

### 4.7 What the receiver pays

`--mode receiver --sizeMib 64`, through the receiver's own `inflateWindowContainer` and `digestSegmentStore`:

| Fixture | Container | Inflate | Hash | Added s/GiB | Total verify s/GiB | Peak storage |
|---|---|---|---|---|---|---|
| source | 17.15 MiB | 124.4 MiB/s | 113.2 MiB/s | **8.23** | 17.28 | **1.27×** |
| table | 7.16 MiB | 193.4 MiB/s | 119.1 MiB/s | **5.29** | 13.90 | **1.11×** |

Three things worth reading off this:

- **Hashing is unchanged at 113–119 MiB/s**, which agrees with Phase 06's 114–116 MiB/s. The decompression pass did not slow the thing it was added in front of.
- **Decompression adds 5–8 seconds per gigabyte** to a verification that already cost ~9. Against a transfer measured in hours, this is a rounding error; it is reported because the plan requires decompression CPU to be recorded, and because it is the phase's only new receiver-side time cost.
- **Peak storage is `original + container`**, 1.11–1.27× here. This is the real price of the design and is discussed in §5.3.

---

## 5. The design, and why it is shaped like this

### 5.1 The transport stream is a container, not a stream

The obvious implementation — one gzip stream over the file, sliced into segments — is wrong for DEQR in three separate ways, and each one is fatal on its own:

1. **A sender could not seek.** Resuming at segment 4,000 would mean recompressing everything before it, because a deflate stream's state at byte *n* depends on every byte before *n*.
2. **A receiver could not bound the output.** A single stream gives no intermediate checkpoint at which "you have produced too much" can be said. The bound would have to be the whole file, which is a bound only in the sense that it is finite.
3. **It would depend on multi-member gzip behaviour** in whatever `DecompressionStream` the user's Safari happens to ship. Concatenated members are legal and widely supported; "widely" is not a contract, and finding out on a user's phone is not a test strategy.

So the transport stream is `[u32BE length][gzip member]` per fixed run of original bytes (`PROTOCOL-V2.md` §4.5). Every member is delimited before it is decoded, every window's output length is a manifest-derived constant, and every seek costs one window.

### 5.2 The sample decides whether to *try*; the file decides whether to *use*

Three bounded 256 KiB windows are cheap and are also only three windows. A file whose first, middle and last quarter-megabyte are text can be mostly video, and the sampler will say 0.02.

So the sample gates a **full sizing walk**, and the walk's measured total goes through the same threshold again. `MEASURED_BELOW_THRESHOLD` is a real outcome that ships: a sample that guesses wrong costs preflight time and can never cost transport correctness. `tests/main/streaming-sender-compression.test.ts` builds precisely the adversarial file — text in exactly the three windows the sampler reads, entropy in the 99% between — and asserts it goes out uncompressed.

The walk is **fused into the SHA-256 pass the sender already had to make**, so one read of the file feeds both the digest and the compressor. That is why the exact `transportSize` in the first manifest costs one pass and not two.

### 5.3 The receiver expands into a second file, and reserves it before scanning starts

A container cannot expand into the buffer it is being read from, so a compressed transfer needs `data.part` and `original.part` at once. That is a real cost — peak device usage becomes `originalSize + transportSize` — and it is the reason the threshold is not near zero.

What it is **not** allowed to be is a surprise. Phase 06's whole storage philosophy is that "will this fit?" is answered by attempting it in the second after Receive rather than estimating it and failing forty minutes in. `original.part` is therefore created and pre-sized **at session start**, alongside `data.part`, and a quota refusal there ends the session before a single frame is accepted. `mobile-web/tests/receiver-compression.test.ts` asserts both files exist at full size before the first segment lands, and that a device with room for the container but not the file refuses at the manifest.

The handle is closed again immediately. Holding an exclusive lock on a file nothing will touch for an hour buys nothing.

### 5.4 Determinism is what makes resume work, and it is already checked

A resumed transfer must reproduce a byte-identical container, or the token's segment index addresses different bytes. Node's `gzipSync` at a fixed level over fixed input is deterministic — verified directly, and asserted in `tests/main/window-compressor.test.ts` by building the same container from two independent encoders and comparing bytes.

The safety net was already there and needed no new code: a resume token is bound to `segmentCount`, which is derived from `transportSize`, which is the compressed total. A token minted under one compression setting — or by a build whose zlib produced different output — has a different segment count and is refused by a check that has existed since Phase 07. This is exactly what Phase 07's handoff note predicted.

### 5.5 A backward seek recompresses from window zero, on purpose

The encoder holds one window and one record and does not remember where each record began, so serving a backward seek means recompressing forward from the start. The alternative is an index of per-window lengths — four bytes per megabyte, so 4 MiB for a terabyte — which is a buffer that scales with the file, and the program's first rule is that no buffer does.

A resume is a person typing a code across an air gap, once. Paying one compression pass for it is the cheaper trade, and it is documented at the seek rather than discovered.

---

## 6. Five refusals, and why each is its own code

Expanding a container can fail in five ways. Collapsing them would make a decompression bomb look like a scratched screen.

| Code | Means | Bound it enforces |
|---|---|---|
| `COMPRESSED_CONTAINER_INVALID` | A record length above zlib's expansion ceiling for this window, a length that runs off the end of the container, a container that ends early, or bytes past the last window | **Checked before allocating.** The ceiling is `maxCompressedWindowBytes(windowBytes)` — a function of the manifest, not of the stream |
| `DECOMPRESSION_FAILED` | A member zlib will not decode | gzip's own CRC-32 and Huffman validity |
| `DECOMPRESSED_SIZE_MISMATCH` | A window that expanded past, or fell short of, its declared original length; or a total that is not `originalSize` | **The decompression-bomb guard.** The output buffer *is* the bound, sized to exactly what the manifest says the window holds, and the stream is cancelled mid-flight when a chunk would not fit |
| `STORAGE_FULL` / `STORAGE_WRITE_FAILED` | The device filled or the writer broke while the file was being written | — |
| `UNSUPPORTED_COMPRESSION` | This context has no `DecompressionStream` | Refused **at the manifest**, before storage work, because there is no back channel and the message has to be one a user can act on |

`tests/core/compression-policy.test.ts` checks that the allocation ceiling is not merely safe but **tight**: gzip of incompressible bytes at 64 KiB, 256 KiB and 1 MiB windows lands within 1% of it. A guard with a factor-of-two margin would let a hostile length through.

The overflow case is deliberately kept distinct from a decode failure inside `inflateMember`. A member that expands past its window is not damage — it is the shape of a bomb, and Phase 10 should be able to find it in a log.

---

## 7. Verification is still one thing, in two passes

Nothing about what makes a transfer real changed. SHA-256 over the reconstructed **original** file, compared against the manifest, is still the only authority, and it still reads back from the device rather than trusting what the writer was handed.

What changed is that a compressed transfer reaches that point through an extra pass, and the two passes are reported separately. `verify-progress` now carries `phase: 'decompressing' | 'hashing'`; a bar that silently restarted at zero half way through a compressed verification would read as a stall at exactly the moment somebody is watching hardest. `mobile-web/tests/receiver-compression.test.ts` asserts the phases appear in order and do not interleave.

Two failure modes are worth naming because they are now distinguishable:

- A container that will not expand fails **before** the hash, with a code that names the container. Under the old design the same corruption would have surfaced as `HASH_MISMATCH` minutes later.
- A container that expands perfectly into bytes that are not the file still fails **after** the hash, with `HASH_MISMATCH` — and its working data is destroyed, exactly as Phase 07 established, so a later resume cannot adopt it and fail the same way again.

---

## 8. The worker protocol moved 3 → 4

`verify-progress` gained the phase, and `progress` gained `originalBytes`, `transportBytes` and `compressionMode` — two sizes, never one, because for a compressed transfer `bytesCommitted` counts optical bytes and reporting it as progress towards the file would look like a transfer that had lost most of itself.

A cached Phase 07 shell against a Phase 08 worker bundle now fails at the handshake **by design**, which is the third time this mechanism has done its job.

---

## 9. Stated deviations

1. **The receiver holds two files.** Peak device usage for a compressed transfer is `originalSize + transportSize`, 1.11–1.27× measured on real fixtures and up to ~1.95× for a transfer sitting on the threshold. Reserved up front so it fails fast, and it is the reason the threshold is 10% rather than near zero. An in-place design does not exist for a container that must also be verifiable.
2. **`DecompressionStream` is required to receive a compressed transfer.** Safari 16.4+. This adds no new floor in practice — the receiver already requires a worker-side `FileSystemSyncAccessHandle`, which is the same era — but it is a hard requirement and a context without it refuses the manifest rather than degrading.
3. **The synthetic fixtures compress unrealistically well.** `text` at 0.016 and `json` at 0.090 are properties of their generators, not of prose or JSON. The `source` fixture (0.269) is real data and is the row that should be quoted. This is stated rather than quietly fixed because the synthetic rows are still the right tool for the threshold and window sweeps.
4. **A backward seek recompresses from window zero.** §5.5. Cost is one compression pass up to the resume point; the alternative violates the program's memory rule.
5. **The golden vector `manifest-compressed.bin` moved.** It declared `compressionParam = 6` while the byte was documented as "profile-defined" and opaque; it now declares 20. No shipped build ever emitted a non-zero `compressionParam`, so nothing on any wire or any device is invalidated — but the vector's bytes changed and its `expected.json` entry with them. Two new rejection vectors were added for the rules Phase 08 introduced.
6. **A new ceiling exists in GZIP mode.** `originalSize ≤ 2^32 × windowBytes` — 4 PiB at the default window, 256 PiB at the maximum — because the window count shares the u32 segment-count limit. Uncompressed transfers are unaffected. One existing test used a 2^63 originalSize purely to exercise 64-bit safety and now uses 2^57, which is still a thousand times past where a JavaScript number stops counting.
7. **Neither shipping UI is wired to any of this.** The desktop renderer still drives v1 and the PWA still has no screen showing the two sizes or the compression decision. That is Phase 09's, and the telemetry it needs is in place: `SenderPreflight.compression` on one side and `ReceiveProgress.originalBytes/transportBytes/compressionMode` on the other.

Not deviations, but carried forward unchanged: no real OPFS implementation has been exercised (Phase 11's), no iOS share-sheet size limit is claimed, and physical certification of any profile remains **PENDING**.

---

## 10. Verification

Every command below was executed and its output observed.

| Command | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run mobile-web:typecheck` | clean |
| `npx vitest run` | **696 passed / 45 files** (from 643 / 41) |
| `npm run mobile-web:test` | **282 passed / 24 files** (from 262 / 23) |
| `npm run mobile-web:build` | clean; receive worker chunk **215.59 kB** (from 206.55 kB) |
| `npm run vectors:v2:generate` | 24 vectors written, deterministic |
| `scripts/bench/phase08-compression.ts --mode corpus/levels/threshold/neutral/window/memory/receiver` | all six modes ran; figures in §4 |

**Phase 08 adds 53 desktop tests and 20 PWA tests** — the desktop figure includes the two new rejection vectors, which the golden-vector suite parameterises over. Four pre-existing tests changed and every one is accounted for:

| Changed | Why |
|---|---|
| `tests/core/protocol-v2.test.ts` — compression independence | Used `compressionParam: 6` while the byte was opaque; now uses the window exponent |
| `tests/core/protocol-v2.test.ts` — 64-bit sizes | Used a 2^63 `originalSize` in GZIP mode, which the new window-count ceiling forbids; now 2^57, still far past `Number.MAX_SAFE_INTEGER`, and the ceiling itself is asserted in the new suite |
| `mobile-web/tests/receiver-integrity.test.ts` — verify progress | The reported object gained `phase` |
| `mobile-web/tests/worker-message-schema.test.ts` — verify-progress schema | Now supplies and requires a phase; a second test was added for an unnamed or unknown one |

**No prior assertion was weakened or deleted.** `protocol/test-vectors-v2/manifest-compressed.bin` and its `expected.json` entry were regenerated — see deviation 5.

New test files:

| File | Covers |
|---|---|
| `tests/core/compression-policy.test.ts` | the decision cannot see a filename; threshold behaviour; framing charged against the gain; the allocation ceiling against real zlib output |
| `tests/core/compression-window.test.ts` | window exponent range, window plan arithmetic, every GZIP manifest rule in both directions, the new u32 window-count ceiling |
| `tests/main/window-compressor.test.ts` | container round-trip including incompressible and sub-window files, backward seek, determinism across encoders, the counting walk, the memory bound, truncation and abort |
| `tests/main/streaming-sender-compression.test.ts` | the five-extension gate, bypass, the adversarial sample file, threshold configurability, digest over original bytes in both modes, fewer frames on the wire, memory under compression |
| `mobile-web/tests/receiver-compression.test.ts` | end-to-end compressed receive, both files pre-sized at session start, export route, the two verify phases, and all five refusals |

---

## 11. What Phase 09 inherits

- **A transfer whose two sizes genuinely differ**, plumbed to both UIs' doorsteps and displayed by neither:

  | Side | Surface | Carries |
  |---|---|---|
  | Sender, in-process | `SenderPreflight.compression` | mode, window, level, transport size, ratio, reason, threshold, predicted gain, CPU |
  | Sender, across IPC | `StreamingTransferMetadata` | `transportSizeBytes`, `compressionMode`, `compressionRatio`, `compressionReason`, `compressionBytesPerSecond` |
  | Sender, across IPC | `StreamingProgressView` | `transportBytesTotal` beside `originalBytesTotal` |
  | Receiver, across the worker port | `ReceiveProgress` | `originalBytes`, `transportBytes`, `compressionMode` |

  `tests/main/streaming-ipc-boundary.test.ts` asserts both sizes cross and that they agree when nothing is compressed. The plan's metric list is *recorded* in full; **displaying it is Phase 09's**, along with the resume-token entry screen Phase 07 left open.
- **A verification with two phases and a progress event that names them.** A screen that shows one bar for both, or two, is a UX decision with the data already available to make it either way.
- **A refusal a user has to be able to act on.** `UNSUPPORTED_COMPRESSION` from a receiver means "ask the desktop to send this without compression", and there is no back channel that could say so automatically. That sentence has to exist on a screen.
- **A threshold with a measured trade behind it.** §4.3 is the table to reason from if Phase 09 or Phase 11 wants to move it, and it is a configuration field rather than a constant.

For Phase 10: the new attack surface is the container reader, and §6 is the list of what it refuses and why each bound comes from the manifest rather than the stream. The one asymmetry worth a threat model's attention is that a compressed transfer makes the receiver reserve `originalSize + transportSize` from a manifest — bounded by `transportSize ≤ originalSize`, but a manifest is still the thing declaring both.
