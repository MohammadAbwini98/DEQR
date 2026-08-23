# PHASE-00 — Baseline Audit, Limit Discovery, and Measurement Harness

**Program**: DEQR Large-File / Maximum-Speed Program
**Phase**: 00 (audit and measurement only — no architecture change)
**Date**: 2026-08-20
**Tree audited**: `main` at `05ec275` (worktree carried the two new bench scripts and this report; no `src/` or `mobile-web/src/` file was modified)
**Verdict**: **PASS** — both required questions are answered with runtime evidence. One planned deliverable was deliberately not built; see [Stated deviations](#stated-deviations).

---

## 1. Executive summary

1. **The ~32 MB ceiling is not a size constant. It is a field width.** The optical frame header stores the source-block count `K` in **16 bits** (`src/core/protocol.ts:69`) and the sender fixes the block size at **512 bytes** (`src/main/session-manager.ts:14`). The product, `65,535 × 512 = 33,553,920` bytes, is the entire v1 transport capacity — 31.99951 MiB. A nominal 32 MiB file is 512 bytes past it, which is why the limit presents as "about 32 MB".

2. **The segment field that could have relieved this is hard-wired to zero.** The header has a 16-bit `segmentNumber`, but the encoder always writes `0` (`src/core/fountain-encoder.ts:88`) and the receiver rejects anything else (`mobile-web/src/protocol.ts:39`). v1 is structurally single-segment.

3. **File extension does not change transport behaviour anywhere.** Measured: the same 4 MiB of bytes under `.txt/.pdf/.zip/.xlsx/.bin` produced identical block counts, and with filenames held to equal byte length, byte-identical containers outside the filename field. Per-extension end-to-end means fell within 0.8 % (natural names) and 2.6 % (equal-length names), against 21 % run-to-run noise in the same data.

4. **The extension-speed *perception* has a real cause, and it is entropy, not extension — but DEQR currently captures none of it.** `compressIfBeneficial` exists (`src/core/compression.ts:11`) and is never called by the sender; `session-manager.ts:82-83` hard-codes `compressed: false`. A text corpus that gzip shrinks to **12.8 %** of its size is transmitted at full size, so it takes ~7.8× longer than it needs to, while an already-compressed corpus (ratio 1.000) cannot benefit. Users who name compressible things `.txt` and incompressible things `.zip` will see exactly the correlation they report, from a mechanism that has nothing to do with the extension.

5. **Nothing in software is the throughput bottleneck.** The optical link runs at **10 FPS × 512 B = 5,120 B/s (5 KiB/s)**. The slowest software stage measured is fountain decode at ~44 MiB/s — about **9,000×** faster than the link. A full systematic pass at the v1 ceiling takes **109 minutes** with zero loss and zero repair frames.

6. **Neither side is bounded-memory, and the receiver has no persistence at all.** There is no OPFS, no IndexedDB, and no incremental write anywhere in `mobile-web/` — verified by search. The receiver holds the whole transfer in RAM and then makes several more whole-payload copies to verify and export it.

---

## 2. Root causes, ranked by evidence

| # | Root cause | Location | Evidence class |
|---|---|---|---|
| 1 | `blockCount` is `uint16`; sender block size fixed at 512 B ⇒ 33,553,920 B transport capacity | `src/core/protocol.ts:69`, `:117`; `src/main/session-manager.ts:14-17` | **Demonstrated at runtime** (§4.1) |
| 2 | Encoder rejects `K > 65535` | `src/core/fountain-encoder.ts:31` | **Demonstrated** — thrown message captured for 32/48/64 MiB |
| 3 | Protocol is single-segment: `segmentNumber` always written `0`; receiver rejects non-zero | `src/core/fountain-encoder.ts:88`; `mobile-web/src/protocol.ts:39` | **Demonstrated** (source is unconditional; receiver rejects in test corpus) |
| 4 | Two selection gates derived from #1, both in the sender | `src/main/session-manager.ts:61`, `:112` | **Demonstrated** (§4.1, plus `tests/main/session-manager-capacity.test.ts`) |
| 5 | Secondary ceiling: `MAX_FILE_SIZE = 64 MiB` in the container and `LIMITS.maxFileBytes = 64 MiB` in the receiver — looser than #1, so never reached today, but becomes the next wall the moment #1 is lifted naively | `src/core/container.ts:26`; `mobile-web/src/protocol.ts:6` | Source-derived; never binds today because #1 is tighter |
| 6 | `totalPayloadLength` is `uint32` ⇒ hard 4 GiB−1 ceiling even after #1–#5 | `src/core/protocol.ts:75`, `:123` | Source-derived (field width) |
| 7 | Whole-file memory paths on both sides would fail before #6 at multi-GB | §5 | Measured growth (§4.3, §4.4) |

**Ranked answer to "why ~32 MB":** #1 is the cause. #2 and #4 are the two places it surfaces. #3 is why it cannot be worked around inside v1. #5–#7 are the walls that come next.

---

## 3. Inventory

### 3.1 Size constraints, with file:line

| Constraint | Value | Location | Binds today? |
|---|---|---|---|
| `V1_FOUNTAIN_BLOCK_SIZE_BYTES` | 512 | `src/main/session-manager.ts:14` | yes (factor of the ceiling) |
| `V1_MAX_BLOCK_COUNT` | 65,535 | `src/main/session-manager.ts:15` | yes |
| `V1_MAX_SERIALIZED_CONTAINER_BYTES` | 33,553,920 | `src/main/session-manager.ts:16-17` | **yes — the ceiling** |
| Raw-size preflight `stat.size >= …` | 33,553,920 | `src/main/session-manager.ts:61` | yes (rejects before read) |
| Serialized-size gate `payload.length > …` | 33,553,920 | `src/main/session-manager.ts:112` | yes |
| Encoder block-count guard | `K > 65535` | `src/core/fountain-encoder.ts:31` | yes |
| Received-container IPC guard | 33,553,920 | `src/main/ipc-handlers.ts:206` | yes |
| `MAX_FILE_SIZE` | 67,108,864 | `src/core/container.ts:26` (used `:56`, `:184`) | no (looser than the ceiling) |
| Decoder payload guard | `MAX_FILE_SIZE` | `src/core/fountain-decoder.ts:46`, `:49` | no |
| `LIMITS.maxFileBytes` | 67,108,864 | `mobile-web/src/protocol.ts:6` | no |
| `LIMITS.maxBlockCount` | 65,535 | `mobile-web/src/protocol.ts:7` | mirrors #1 |
| `LIMITS.maxBlockSize` | 2,048 | `mobile-web/src/protocol.ts:8` | not today (sender sends 512) |
| `LIMITS.maxSeenFrames` | 131,072 | `mobile-web/src/protocol.ts:12` | dedupe-table bound |
| `LIMITS.maxUnsolvedBytes` | 16 MiB | `mobile-web/src/protocol.ts:13` | repair-buffer bound |
| Receiver container floor/ceiling | 60 B … 64 MiB | `mobile-web/src/protocol.ts:61` | no |
| Filename / MIME | 1,024 B each | `mobile-web/src/protocol.ts:10-11` | no |
| Decoder worker pixel cap | 720×720 | `mobile-web/src/decoder.worker.ts:3` | camera ROI bound |
| UI capacity copy | "below 32 MiB" | `src/renderer/App.tsx:240`, `src/renderer/components/Dashboard.tsx:19` | **prose only — and it is the wrong number**; the real figure is 31.99951 MiB of *serialized container*, i.e. ≤ 33,553,818 source bytes for a typical filename |

### 3.2 Whole-file allocations and copies

**Sender — peak ≈ 2 × source, held for the whole transfer**

| # | Allocation | Location |
|---|---|---|
| 1 | `fs.readFileSync(filepath)` — entire source into one Buffer | `src/main/session-manager.ts:77` |
| 2 | `Buffer.alloc(totalSize)` — entire container | `src/core/container.ts:78` |
| 3 | `payload.copy(buffer, offset)` — full source copy into #2 | `src/core/container.ts:122` |
| 4 | `session.payload` retains #2 for the session lifetime | `src/main/session-manager.ts:120` |
| — | Encoder blocks are `subarray` **views** of #2 (no copy), except one padded tail block — the one part of the sender that is already allocation-clean | `src/core/fountain-encoder.ts:36-50` |
| 5 | Per frame: `Buffer.alloc(blockSize)` + `Buffer.concat` — 2 small allocations at 10 Hz, not a scaling problem | `src/core/fountain-encoder.ts:65`; `src/core/protocol.ts:141` |

**Desktop receive path (loopback / desktop camera) — peak ≈ 4 × container**

| # | Allocation | Location |
|---|---|---|
| 6 | `Buffer.concat(this.decodedBlocks)` — whole payload | `src/core/fountain-decoder.ts:207` |
| 7 | Whole container crosses IPC as one `Uint8Array` (structured clone) | `src/main/ipc-handlers.ts:196`, `:201` |
| 8 | `Buffer.from(containerData)` — private main-side copy | `src/main/ipc-handlers.ts:214` |
| 9 | `Buffer.from(data.subarray(offset))` — payload copy during parse | `src/core/container.ts:217` |

**PWA receiver — peak ≈ 4–5 × payload**

| # | Allocation | Location |
|---|---|---|
| 10 | `blocks[]` — K separate 512-byte `Uint8Array`s ⇒ 1 × payload **plus 129–380 B of JS object overhead per block** (measured, §4.4) | `mobile-web/src/protocol.ts:87`, `:94`, `:105` |
| 11 | `seen` Map — one entry per observed frame, bounded at 131,072 | `mobile-web/src/protocol.ts:87`, `:101` |
| 12 | `reconstruct()` — `new Uint8Array(blockCount * blockSize)` | `mobile-web/src/protocol.ts:99` |
| 13 | `parseContainer` `take()` → `bytes.slice(...)` — whole payload again | `mobile-web/src/protocol.ts:63`, `:73` |
| 14 | Digest input may be re-sliced when the view is not buffer-aligned | `mobile-web/src/protocol.ts` (`verifyOnce`) |
| 15 | Export: `Uint8Array.from(file.bytes).buffer` **and** `new File([...])` — two more copies | `mobile-web/src/export.ts:2` |
| 16 | gzip inflate accumulates `chunks[]` then re-joins — 2 × decompressed size (unreachable today: the sender never compresses) | `mobile-web/src/protocol.ts:169-170` |

No `base64`, `btoa`/`atob`, or `JSON.stringify` of binary exists on any transport path. Searched and clean.

### 3.3 32-bit / bounded size semantics

| Field | Width | Location | Consequence |
|---|---|---|---|
| `blockCount` | uint16 | `src/core/protocol.ts:69`, `:117` | **the 32 MB ceiling** |
| `blockSize` | uint16 | `src/core/protocol.ts:72`, `:120` | max 65,535 B per symbol |
| `segmentNumber` | uint16 | `src/core/protocol.ts:63`, `:111` | present but pinned to 0 |
| `sequenceNumber` | uint32 | `src/core/protocol.ts:66`, `:114` | 4.29 G frames — not binding |
| `totalPayloadLength` | **uint32** | `src/core/protocol.ts:75`, `:123` | hard 4 GiB−1 protocol ceiling |
| Container `originalSize` | uint64 written, **`Number()` on read** | `src/core/container.ts:114`, `:182` | 64-bit on the wire; JS-safe to 2^53, so the container is *not* the 64-bit problem |
| Container `timestamp` | uint64 → `Number()` | `src/core/container.ts:206` | fine |
| Filename / MIME length | uint16 | `src/core/container.ts:90`, `:96` | fine |
| Header checksum | **1-byte XOR over 19 bytes** | `src/core/protocol.ts:38-43` | 1-in-256 chance of accepting a corrupted header; see §6 |

**Conclusion for Phase 01:** the container format is already 64-bit-safe on the wire. The *frame* header is not: `blockCount`, `blockSize`, `segmentNumber` and `totalPayloadLength` all need widening or replacing with a segment-relative scheme.

### 3.4 Extension-specific branches — complete list

| Branch | Location | Effect |
|---|---|---|
| `BLOCKED_EXTENSIONS` (14 entries) / `isBlockedExtension` | `src/core/filename-sanitizer.ts:64-77` | Sender **refuses** the file. Categorical, not a speed path. |
| Sender selection check | `src/main/session-manager.ts:71` | as above |
| Received-file check (desktop) | `src/main/ipc-handlers.ts:219` | refuses to save |
| `BLOCKED_RECEIVER_EXTENSIONS` (14 entries) | `mobile-web/src/protocol.ts:26`, `:30` | receiver refuses after reconstruction |
| Extension recorded in display metadata | `src/main/session-manager.ts:86` | display only; never read by transport |

That is the whole list. **No transport, framing, block-size, FPS, compression, or QR setting anywhere reads the extension.** MIME is hard-coded to `application/octet-stream` (`src/main/session-manager.ts:88`), so it cannot introduce a branch either.

### 3.5 Browser / PWA persistence model

**There is none.** `indexedDB`, `navigator.storage`, `getDirectory`, `createWritable`, and `storage.estimate` return **zero matches** across `src/` and `mobile-web/`.

The receiver's storage model is: accumulate every recovered block in a JS array, join into one `Uint8Array`, parse, hash, retain the verified bytes in memory, then hand a `File` to `navigator.share` or an object-URL download (`mobile-web/src/export.ts:2`). There is no preflight against available space, no incremental persistence, no checkpoint, and therefore no resume: a backgrounded or reloaded tab loses the entire transfer.

### 3.6 Current integrity path

| Stage | Mechanism | Location |
|---|---|---|
| Source digest | `computeSha256` over the whole source | `src/main/session-manager.ts:80` |
| Digest carried | 32 bytes in the container header | `src/core/container.ts:114` |
| Per-frame | 1-byte XOR checksum over the 19 header bytes; **payload bytes are not checksummed at all** | `src/core/protocol.ts:38-43`, `:90-96` |
| Duplicate detection | FNV-1a 32-bit fingerprint per sequence number; a differing fingerprint on a seen sequence raises `CONFLICTING_DUPLICATE` | `mobile-web/src/protocol.ts:28`, `:91` |
| Size check | reconstructed length vs declared `originalSize` | `mobile-web/src/protocol.ts:74` |
| Final authority | `crypto.subtle.digest('SHA-256')` over the whole reconstructed payload vs the container digest | `mobile-web/src/protocol.ts` (`verifyOnce`) |
| Desktop re-check | main re-hashes before writing the received file | `src/main/ipc-handlers.ts:225` |

**Gap for Phase 07:** verification is all-or-nothing at the very end, over a fully materialised buffer. There is no incremental hash, no per-segment digest, and no checkpoint. At the v1 ceiling that means a single corrupted byte discovered after ~109 minutes invalidates the whole transfer with nothing recoverable.

---

## 4. Measured baseline

Harness: `scripts/bench/phase00-baseline.ts` and `scripts/bench/phase00-receiver-memory.ts` (both new, both reusable by later phases).
Evidence file: `.local-run/bench/phase00-baseline-phase00.json` (gitignored; regenerate with the commands in §7).
Environment: Node v24.18.1, win32 x64, 5 samples per extension cell, deterministic synthetic corpora.
Delivery: in-process desktop encoder into the real browser-safe `ReceiverSession`. **No camera, no display, no network** — see §8 for what that leaves unmeasured.

### 4.1 Capacity boundary — the exact ceiling

```
containerHeaderBytes (filename "boundary-probe.bin")   102
V1_MAX_SERIALIZED_CONTAINER_BYTES               33,553,920   (= 512 × 65,535 = 31.99951 MiB)
largest accepted source                         33,553,818   (= 31.999414 MiB)  → K = 65,535, gate: accepted
largest accepted source + 1 byte                33,553,819   → gate: rejected-serialized-size
                                                             → encoder: "Invalid block count K=65536. Must be 1-65535."
nominal 32 MiB (33,554,432)                                  → rejected by the raw-size gate, before the file is read
```

### 4.2 Size sweep

| Corpus | Size | Selection gate | K | Encoder |
|---|---|---|---|---|
| text | 1 MiB | accepted | 2,049 | ok → verified COMPLETE |
| text | 16 MiB | accepted | 32,769 | ok → verified COMPLETE |
| text | 32 MiB | **rejected-raw-size** | — | `Invalid block count K=65537` |
| text | 48 MiB | **rejected-raw-size** | — | `Invalid block count K=98305` |
| text | 64 MiB | **rejected-raw-size** | — | `Invalid block count K=131073` |
| random | 1 MiB | accepted | 2,049 | ok → verified COMPLETE |
| random | 16 MiB | accepted | 32,769 | ok → verified COMPLETE |
| random | 32/48/64 MiB | **rejected-raw-size** | — | same K values as above |

Container overhead is 105–108 bytes, independent of size and corpus. Frame on the wire is **532 bytes for 512 payload bytes** — 3.9 % header overhead.

### 4.3 Throughput budget — where the time actually goes

| Stage | Measured | Ratio to the optical link |
|---|---|---|
| Container serialize | 2,450–5,088 MiB/s | ~10⁶ × |
| File read (`readFileSync`) | 556–2,376 MiB/s | ~10⁵ × |
| SHA-256 (sender) | 372–465 MiB/s | ~10⁵ × |
| PWA verify (reconstruct + parse + digest) | 172–299 MiB/s | ~10⁴ × |
| Fountain encode | 107k–434k symbols/s ≙ 52–212 MiB/s | ~10⁴ × |
| Fountain decode | 90k–125k symbols/s ≙ 44–61 MiB/s | ~10⁴ × |
| **Optical link (10 FPS × 512 B)** | **5,120 B/s ≙ 0.0049 MiB/s** | **1 ×** |

Projected systematic-only transfer time (zero loss, no repair frames):

| Payload | K | Time |
|---|---|---|
| 1 MiB | 2,049 | 3 min 25 s |
| 16 MiB | 32,769 | 54 min 37 s |
| v1 ceiling (31.999 MiB) | 65,535 | **1 h 49 min** |

**The link is roughly four orders of magnitude slower than the slowest software stage.** Every optimisation that is not "more useful payload bytes per displayed frame" is noise until Phase 04 moves the link itself.

### 4.4 Memory growth

Sender-side peak `external` bytes rise linearly with input at roughly **3 × input** (source + container + gzip sample buffers): 72 → 100 → 132 → 120 → 168 MiB across the 1/16/32/48/64 MiB text sweep.

Receiver, measured per size in a fresh process (`scripts/bench/phase00-receiver-memory.ts`, settled `heapUsed + external` after forced collection; the metric was validated first against a controlled allocation of the same shape):

| Payload | K | Decoder holds | Per-block overhead | Retained after verify | Peak RSS |
|---|---|---|---|---|---|
| 1 MiB | 2,049 | 1.7 MiB (1.74 ×) | 380 B | 1.1 MiB (1.11 ×) | 88 MiB |
| 4 MiB | 8,193 | 6.4 MiB (1.61 ×) | 313 B | 4.2 MiB (1.05 ×) | 107 MiB |
| 16 MiB | 32,769 | 21.0 MiB (1.31 ×) | 160 B | 12.2 MiB (0.76 ×) | 180 MiB |
| 31 MiB | 63,489 | 38.8 MiB (1.25 ×) | 129 B | 23.4 MiB (0.76 ×) | 262 MiB |

Reading: the decoder's block array alone costs **1.25–1.74 × the payload**, because each 512-byte block is a separate `Uint8Array` carrying 129–380 B of JS object overhead. `retainedAfterVerify` is the least reliable column — the baseline snapshot's treatment of the sender-side buffers moves it by up to ±1 × payload — so treat 0.76–1.11 × as "about one payload retained", which is what the source says it should be. Peak RSS in the combined sender+receiver process grows about **5.8 MiB per MiB of payload**.

**Phase 05/06 consequence:** an iPhone that must hold ~1.25 × payload as fragmented small allocations, then ~2 × more transiently to reconstruct, parse, and export, has an in-RAM ceiling well below any multi-GB target regardless of what the protocol permits.

### 4.5 Extension matrix — identical bytes, five names

4 MiB of identical bytes, 5 samples per cell, running order rotated each sample so no extension keeps the warm-up position.

| Scheme | Distinct container digests **excluding the filename field** | Distinct block counts | Distinct container lengths | Filename lengths |
|---|---|---|---|---|
| natural (`identical-bytes.<ext>`) | 2 | **[8193]** | [4194407, 4194408] | [19, 20] |
| equal-length (12-byte names) | **1** | **[8193]** | **[4194400]** | **[12]** |

End-to-end means:

| Scheme | `.txt` | `.pdf` | `.zip` | `.xlsx` | `.bin` | spread |
|---|---|---|---|---|---|---|
| natural | 124.9 ms | 124.9 ms | 124.4 ms | 123.9 ms | 124.4 ms | **0.8 %** |
| equal-length | 123.5 ms | 126.4 ms | 125.5 ms | 123.2 ms | 124.8 ms | **2.6 %** |

Run-to-run spread within the equal-length cells was **1.21 ×** (113.1–137.0 ms) — an order of magnitude larger than any between-extension difference. In 7 of 10 samples the slowest cell was whichever extension happened to run **first**, which is what rotation was added to expose.

Blocked-extension probe: `.exe` → `blockedBySender = true`, i.e. a categorical refusal, not a slow path.

**Conclusion.** With filename length held constant, the five extensions produce byte-identical containers outside the filename field, identical block counts, and identical frame counts. The only mechanism by which a *name* changes a transfer is its **length**: a one-byte-longer name grew the container by one byte (4,194,407 → 4,194,408) and can move the block count by ±1 — 0.012 % of one block at 8,193 blocks.

### 4.6 Compressibility — the real content effect

| Corpus | Sampled gzip ratio | Sample cost |
|---|---|---|
| text-like (redundant) | **0.128** | 38–112 ms for 3 MiB sampled |
| random (high entropy) | **1.000** | 22–80 ms for 3 MiB sampled |

Sampling 3 × 1 MiB windows costs under 120 ms, against a link that needs **109 minutes** to move 32 MiB. Sampled-compressibility decision-making is effectively free at this link speed, and on the text corpus it would cut transfer time by 7.8 ×. This is the single largest available speed win that does not touch the QR layer, and Phase 08 should treat it as such.

---

## 5. Likely CPU / memory bottlenecks, ordered

1. **The optical link itself (10 FPS × 512 B).** Four orders of magnitude below every software stage. Nothing else matters until Phase 04 raises payload-bytes-per-frame and validated FPS.
2. **Receiver RAM.** No persistence, ~1.25 × payload held as K fragmented allocations, plus 2–3 more whole-payload copies to reconstruct, parse, verify, and export.
3. **Sender RAM.** 2 × source held for the whole transfer, allocated up front by `readFileSync` + `serializeContainer`.
4. **Camera sampling ceiling.** `SCAN_INTERVAL_MS = 90` (`mobile-web/src/camera.ts:3`) caps capture at ~11.1 Hz before decode cost, with one decode in flight. This is why the sender is pinned to 10 FPS (`src/main/ipc-handlers.ts:24-26`) — the comment says so explicitly, and it is an unvalidated hypothesis by the project's own record.
5. **Fountain decode at high K.** Decode measured 90k–125k symbols/s and the belief-propagation ripple scans the unsolved map per solve, so cost grows with K rather than with a bounded window. Segment isolation (Phase 03) removes this as a scaling term.
6. **Per-block object overhead in the receiver.** 129–380 B per 512-byte block is 25–74 % waste, entirely from representing blocks as individual `Uint8Array`s.

Note that the sender's encoder is **already** allocation-clean — its blocks are `subarray` views of the container (`src/core/fountain-encoder.ts:38-44`). It is the two allocations feeding it that are not.

---

## 6. Security and correctness observations (recorded, not acted on)

- **The frame header checksum is 1 byte of XOR over 19 bytes** (`src/core/protocol.ts:38-43`). A corrupted header has a ~1/256 chance of being accepted, and **payload bytes carry no checksum at all**. Today the container SHA-256 catches it at the end; once transfers are segmented and resumable, a bad symbol accepted into a checkpoint is a real hazard. Phase 01/10 should raise this to a real CRC over the whole frame.
- **`compressIfBeneficial` is unreachable from the sender.** By this project's own precedent (`DESKTOP-UI-009`), unreachable exported code is a defect to resolve, not to leave. Phase 08 either wires it or deletes it — it should not stay in this state.
- **The UI capacity copy is wrong in two ways** (`src/renderer/App.tsx:240`, `src/renderer/components/Dashboard.tsx:19`): it says "below 32 MiB" where the true figure is 31.99951 MiB of *serialized container*, and it gives the user no way to know how much the filename and metadata consume. Cosmetic today, but it is the only place a user learns the limit.
- **`decodedBlocks` is typed `Buffer[]` but initialised with `null`** (`src/core/fountain-decoder.ts:27`, `:57`), relying on truthiness checks. Not a live bug; worth cleaning when the decoder is reworked in Phase 03.

---

## 7. Reusable harness

Two new scripts, both offline, both payload-safe (no transferred bytes, no absolute source paths, no key material recorded), both writing only under `.local-run/bench/`:

**`scripts/bench/phase00-baseline.ts`** — modes `boundary`, `capacity`, `extension`, `all`.

```bash
node --expose-gc --max-old-space-size=4096 node_modules/vite-node/vite-node.mjs \
  scripts/bench/phase00-baseline.ts -- \
  --mode all --sizes 1,16,32,48,64 --decode-max-mib 32 --extension-size-mib 4 --samples 5 --label phase00
```

**`scripts/bench/phase00-receiver-memory.ts`** — one payload size per process, by design.

```bash
node --expose-gc --max-old-space-size=4096 node_modules/vite-node/vite-node.mjs \
  scripts/bench/phase00-receiver-memory.ts -- --mib 16
```

Corpora are regenerated deterministically into `.local-run/phase00-corpus/` when absent, so the ~322 MiB of fixtures can be deleted freely. Later phases should re-run the same commands with a different `--label` and diff the JSON against `phase00`.

The pre-existing `scripts/bench/desktop-pwa-pipeline.ts` remains valid for the 5 KiB–1 MiB range and loss simulation; the new harness deliberately does not duplicate it.

---

## 8. What this phase did **not** establish

- **No optical measurement.** Rendered QR FPS, camera frames observed, and in-situ decode rate were not measured. They need a real display and a real iPhone, which the project record confirms is unavailable (`CURRENT-STATE.md`, WEB-IOS-10). Every throughput number here is a software-stage ceiling, not an observed transfer rate.
- **No packaged-Electron measurement.** The harness drives the modules in Node, not the shipped binary. IPC cost per frame, renderer paint cost, and the `qrcode` library's own encode cost at 400 px / EC-L are unmeasured.
- **No physical-device memory ceiling.** The receiver memory figures are from Node on a desktop. What an iPhone actually survives is a Phase 05/11 gate.
- **`storageWriteBytesPerSec` and `bytesPersisted` are unmeasurable today** because no storage layer exists (§3.5). They become measurable in Phase 06.

---

## 9. Stated deviations

**The development-only in-app telemetry stream described in the Phase 00 plan was deliberately not built.** Reasoning:

1. Most of the counters the plan asks for already exist in shipping code: `TransferStats { framesGenerated, sourceBlocks, elapsedMs, targetFps, effectiveFps }` (`src/shared/types.ts:37`, emitted at `src/main/ipc-handlers.ts:338-344`); `CameraMetrics { capturedFrames, decodedFrames, cameraAverageMs, decodeAverageMs, roiEdge, stalledRecoveries }` (`mobile-web/src/camera.ts:13-21`); and `ReceiverSnapshot { receivedBlocks, totalBlocks, duplicates, foreignFrames }` (`mobile-web/src/protocol.ts`).
2. Everything else the plan lists is measured by the new harness, against the same modules the app runs.
3. The three counters that genuinely need in-app wiring — rendered-QR FPS at the canvas, camera frames observed in situ, and storage write throughput — are all attached to subsystems that Phases 04, 05, and 06 replace. Instrumenting the v1 whole-file path now produces code that is thrown away in two phases' time, across three ownership domains, in a tree where every claim is evidence-bound.

**Recommendation:** carry the telemetry object into Phase 04 (display/QR), Phase 05 (capture/decode), and Phase 06 (storage), where it instruments the pipeline that will actually ship. Phase 00's measurement obligation is met by the harness.

No other deviation. No `src/` or `mobile-web/src/` file was modified.

---

## 10. Verification

| Check | Command | Result |
|---|---|---|
| Desktop unit suite | `npm test` | **286 PASS / 25 files** |
| PWA unit suite | `npm run mobile-web:test` | **63 PASS / 11 files** |
| Desktop typecheck | `npx tsc --noEmit` | **PASS** |
| PWA typecheck | `npm run mobile-web:typecheck` | **PASS** |
| New bench scripts typecheck | `npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --strict --esModuleInterop --skipLibCheck --resolveJsonModule --types node scripts/bench/phase00-baseline.ts scripts/bench/phase00-receiver-memory.ts` | **PASS** (they sit outside `tsconfig.json`'s `include`, as the existing bench scripts do) |
| AI architecture doctor | `npm run doctor` | **PASSED (0 warnings)** |
| Adapter drift | `npm run drift-check` | **PASSED (zero drift)** |
| Baseline sweep | see §7 | **PHASE00_BASELINE_COMPLETE** capacity=10 extensionSamples=10 |
| Receiver memory probe | see §7 | **COMPLETE** at 1/4/16/31 MiB |

Suite counts are unchanged from the pre-phase baseline, which is the expected outcome: this phase added no shipping code.

**Changed files**

| File | Change |
|---|---|
| `scripts/bench/phase00-baseline.ts` | new — boundary/capacity/extension harness |
| `scripts/bench/phase00-receiver-memory.ts` | new — receiver memory probe |
| `.ai-team/reports/performance/PHASE-00-AUDIT.md` | new — this report |
| `.ai-team/project-control/CURRENT-STATE.md` | new Phase 00 section |
| `.ai-team/project-control/TASK-LOG.md` | new row |

---

## 11. Acceptance gate

| Gate criterion | Status |
|---|---|
| Every known 32 MB constraint identified | **MET** — §3.1, with the binding one demonstrated at the exact byte (§4.1) |
| Same bytes compared under different extensions | **MET** — §4.5, two naming schemes, rotated order, 5 samples |
| Baseline throughput recorded | **MET** — §4.3 |
| Memory growth observed at increasing sizes | **MET** — §4.4 |
| No claim made from source inspection alone where runtime evidence was feasible | **MET** — every claim is tagged; §8 states what could not be measured and why |

**PHASE 00: PASS.** Phase 01 (Protocol v2) is unblocked.

**What Phase 01 must carry forward:** the ceiling is `blockCount` × `blockSize`, not a size constant, so widening `MAX_FILE_SIZE` changes nothing. v2 needs a segment-relative frame header with a real segment number, 64-bit-safe total-size semantics (the frame's `totalPayloadLength` uint32 is the next wall at 4 GiB−1), a payload checksum stronger than 1-byte header XOR, and a block size that is a transport profile rather than a constant.
