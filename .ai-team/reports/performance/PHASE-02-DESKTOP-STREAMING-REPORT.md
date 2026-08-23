# PHASE-02 — Desktop Streaming Sender and Bounded-Memory Segmentation

**Program**: DEQR Large-File / Maximum-Speed Program
**Phase**: 02 (sender pipeline only — no QR density work, no receiver work)
**Date**: 2026-08-20
**Verdict**: **PASS** — every gate criterion is met with executed evidence. Three deliberate scope decisions are stated in §6.

---

## 1. Headline

**v1 holds two times the file, resident, before it draws a frame. v2 holds 1.05 MiB regardless of the file.**

Measured on the shipping v1 preparation path and the new v2 pipeline over identical corpora, with settled live bytes (`heapUsed + external` after forced collection — the metric Phase 00 validated against a controlled allocation):

| File | v1 held | v1 ÷ size | v2 held | v2 ÷ size | v2 budget | v2 peak buffered |
|---|---|---|---|---|---|---|
| 1 MiB | 2,471,630 B | **2.00×** | 1,217,519 B | 1.16× | 1,099,411 B | 1,098,867 B |
| 8 MiB | 16,886,214 B | **2.00×** | 1,168,439 B | 0.14× | 1,099,411 B | 1,098,867 B |
| 16 MiB | 33,669,270 B | **2.00×** | 1,235,304 B | 0.07× | 1,099,412 B | 1,098,868 B |
| 31 MiB | 65,124,302 B | **2.00×** | 1,320,792 B | 0.04× | 1,099,412 B | 1,098,868 B |
| 128 MiB | *refused — above v1 capacity* | — | 1,325,081 B | 0.010× | 1,099,413 B | 1,098,869 B |
| **1 GiB** | *refused* | — | **1,339,042 B** | **0.0012×** | 1,099,414 B | 1,098,870 B |

v1's line is `2.00 × size` at every point. v2's is flat: 1.22 MB at 1 MiB and 1.34 MB at 1 GiB, an 850× difference in input for a 10 % difference in memory. Peak RSS is flat too, 102–104 MB across the whole v2 range.

Two numbers in that table mean different things and should not be read as one. `memoryBudgetBytes()` is what the pipeline's own buffers may hold, computed from configuration alone; `heldBytes` is the whole process's live-byte delta, which also carries the session object, the manifest, closures, and V8 bookkeeping — 120–240 KB of it. The contract the tests enforce is `bufferedBytes() ≤ memoryBudgetBytes()`, and it holds at every size.

Reproduce:

```bash
node --expose-gc node_modules/vite-node/vite-node.mjs scripts/bench/phase02-sender-memory.ts -- --path v1 --mib 16
```

---

## 2. What was built

| Artifact | Location | Purpose |
|---|---|---|
| Segment symbolizer | `src/core/segment-encoder.ts` | Systematic-first symbols scoped to one segment; browser-safe |
| Streaming sender | `src/main/streaming-sender.ts` | Preflight, bounded segment reads, bounded queue, lifecycle |
| Session registry | `src/main/streaming-session-registry.ts` | Privileged ownership, the renderer-facing surface |
| IPC + preload | `src/main/ipc-handlers.ts`, `src/preload/index.ts`, `src/shared/types.ts` | Four channels, pull-based |
| Shutdown wiring | `src/main/index.ts` | Descriptors released on window close, renderer loss, and quit |
| Memory bench | `scripts/bench/phase02-sender-memory.ts` | v1 vs v2, one size and one path per process |
| Sender tests | `tests/main/streaming-sender.test.ts` | 27 tests |
| Boundary tests | `tests/main/streaming-ipc-boundary.test.ts` | 8 tests, including a real file through the real opener |
| Symbolizer tests | `tests/core/segment-encoder.test.ts` | 9 tests |

The pipeline:

```
file handle → preflight (stat, sampled compressibility, streamed SHA-256, re-stat)
            → segment reader (one reusable buffer, optional single read-ahead)
            → segment symbolizer (systematic first, then XOR repair)
            → v2 frame serializer
            → bounded ready queue
            → renderer, one frame per request
```

### 2.1 Two design decisions worth naming

**Frames are pulled, not pushed.** The renderer asks for the next frame when it is ready to paint one. Backpressure is then structural rather than advisory: frames are produced *only* inside `take()`, so a consumer that stops asking stops the encoder and the file reader because there is nothing else that drives them. There is no background pump that can outrun a slow display, and — not incidentally — no main-process timer of the kind that kept v1 encoding for a destroyed renderer and surfaced as a shutdown crash (`c5cde64`).

**Preflight streams the whole file once to hash it.** That is the price of promising a SHA-256 before the first frame is drawn, and it is paid in bounded memory at a measured 390–520 MiB/s: under three seconds per gigabyte, against an optical link Phase 00 measured at 5,120 B/s. The file is re-stat'd afterwards, because a digest computed over bytes that have since changed would surface as a verification failure hours later with nothing to point at.

---

## 3. Acceptance gate

| Gate criterion | Status | Evidence |
|---|---|---|
| Synthetic 1 GB stream passes the sender pipeline without a 1 GB allocation | **MET** | `passes a synthetic 1 GiB stream…` drives all 262,272 frames through the real pipeline against a synthetic file that never exists on disk; peak buffered ≤ budget throughout, budget < 5 MiB |
| Peak memory within an explicitly justified bound | **MET** | `memoryBudgetBytes()` is a pure function of configuration with a per-term table in the module header; asserted `≥ bufferedBytes()` at every step of every test; the bench shows it flat from 1 MiB to 1 GiB |
| Cancellation closes resources | **MET** | Abort mid-segment, abort during preflight, dispose at a boundary, dispose twice, read failure, truncation — all assert `closes === 1` and that `take()` refuses afterwards |
| Renderer never receives the entire file | **MET** | Largest IPC response is one symbol plus 32 header bytes; `select` returns no path, and the returned metadata is asserted not to contain the temp directory or any drive-letter path |
| Tests verify backpressure | **MET** | Three tests: nothing is produced until a consumer asks; the queue never exceeds capacity under a deliberately slow consumer; a stalled consumer stops all reads, and read-ahead is bounded to exactly one segment |

Requirements from the execution prompt:

| Requirement | Status |
|---|---|
| Main retains file access; renderer gets no filesystem primitive | MET — the whole capability is a three-method `SenderFileHandle` held in main |
| No whole-file `readFile`/`readFileSync` on the v2 path | MET — every read is `hashChunkBytes` or one segment, both clamped to the reusable buffer |
| Configurable 1–4 MiB segments, winner not hard-coded | MET — `segmentSizeBytes` accepts 64 KiB–64 MiB, defaults to 1 MiB, documented as a starting point for Phase 04 |
| Source symbols produced from the current segment only | MET — the symbolizer holds one segment reference and one degree distribution sized to it |
| Bounded read-ahead and bounded output queue | MET — read-ahead is 0 or 1 segments; queue capacity is a hard cap |
| Real backpressure | MET — production happens only inside `take()` |
| Cancellation/error/window close releases everything | MET — `AbortSignal` throughout, `dispose()` idempotent, wired into all three main-process teardown paths |
| Original/transmitted/frame progress kept distinct | MET — `transportBytesCovered`, `bytesOnTheWire`, `framesEmitted` are separate and separately asserted |
| No large binary chunks through IPC | MET — one symbol per response |
| contextIsolation, sanitized errors, no payload logging preserved | MET — new channels go through the same `handleTrusted` wrapper and `sanitizeError`; nothing logs payload bytes |

### 3.1 The prompt's test list

| Required test | Where |
|---|---|
| Logical 1 GB+ input without allocating it | `passes a synthetic 1 GiB stream…` |
| Peak buffered bytes below the budget | asserted in that test and in every drain |
| Cancel at a segment boundary and mid-segment | `aborts mid-segment…`, `refuses to keep producing after dispose…` |
| Renderer slowdown / backpressure | three tests in `backpressure is structural` |
| Read error | `surfaces a read failure and still releases the descriptor` |
| File truncated or changed during preparation or transfer | `refuses a file that changed while it was being hashed`, `detects a file truncated mid-transfer` |
| Zero-byte and tiny files | `refuses an empty file…`, `handles a one-byte file` |
| Very long but valid filename | `carries a long but legal filename through to the manifest` (200 characters) |
| >4 GB size and offset metadata | `derives segment offsets above 2^32…`, `reads past the 4 GiB boundary using 64-bit positions` |

---

## 4. Verification

| Check | Result |
|---|---|
| Desktop unit suite | **439 PASS / 31 files** (was 395 / 28 — **+44 tests, +3 files**) |
| PWA unit suite | **71 PASS / 12 files** (unchanged — this phase touches no receiver code) |
| Desktop typecheck, main, preload | PASS |
| PWA typecheck | PASS |
| Desktop and PWA production builds | PASS |
| `npm run test:packaged` | PASS |
| AI doctor | PASSED (0 warnings) |
| Adapter drift | PASSED (zero drift) |
| `git diff --check` | clean |

**Suite runtime rose from ~4 s to ~18 s**, almost entirely from two tests: the 1 GiB stream (8.3 s) and the 4 GiB read-position proof (9.2 s). The second is expensive because preflight hashes the whole file and SHA-256 runs at ~450 MiB/s; there is no way to reach a read position above 2³² without getting there. Both are the phase's headline gates and were kept for that reason. If the inner loop matters more than the end-to-end proof later, the 4 GiB case is the one to reduce to a plan-level assertion — the arithmetic is already covered by `derives segment offsets above 2^32` at zero cost.

### 4.1 The existing suites already cover the new surface

Two pre-existing tests pick up the four new IPC channels without being edited, which is the property they were written for:

- `ipc-sender-policy.test.ts` enumerates whatever `registerIpcHandlers` actually registers and proves each channel rejects an untrusted origin, every subframe, and a destroyed sender frame.
- `ipc-contract.test.ts` walks the real preload bridge and requires a main handler for every channel it invokes.

Neither carries a maintained list, so neither could go stale the way `DESKTOP-SEC-050`'s duplicated policy did.

---

## 5. Defects found and fixed during the phase

**A validation rule that rejected a configuration nobody wrote.** `hashChunkBytes` and `compressibilitySampleBytes` share the segment buffer, and both were validated against `segmentSizeBytes`. Pairing a small segment with the default 1 MiB hash chunk therefore failed with an error about a knob the caller had never set. Both are now validated against the protocol maximum and clamped to the buffer at use.

**Three defects in the tests themselves**, all found by running them rather than by reading them: a read-ahead assertion that counted preflight's hashing reads as run-ahead; a `> 2^32` bound where the first out-of-range position is exactly 2³²; and a read-failure test whose config was invalid, so it exercised a config error instead of the read failure it claimed to cover. The third is the interesting one — it passed its `rejects.toThrow()` assertion for entirely the wrong reason, and only the follow-up assertion on the descriptor caught it.

---

## 6. Stated scope decisions

**1. The shipping UI still uses v1.** The v2 sender is wired end to end — service, registry, four IPC channels, preload bridge, shutdown teardown — and driven by tests through the real registration, but `QRCanvas` and `App.tsx` still drive the v1 path. The display strategy is Phase 04's subject and the transfer UX is Phase 09's; wiring the renderer now would mean doing it twice, against a frame cadence that is about to change. The gate's wording anticipates this: *"No whole-file sender allocation remains on the v2 path."*

**2. Read-ahead defaults to off.** The plan's suggested budget allows one prefetched segment. A segment read is roughly four orders of magnitude faster than the optical link, so prefetching buys nothing today and costs a whole segment of RAM. The mechanism is implemented and tested in both settings — the budget difference is asserted to be exactly one segment — and the default is `0` because that is the honest answer at 5,120 B/s. A faster link changes the answer, not the code.

**3. Repair symbols are produced but not yet decoded.** The symbolizer emits systematic symbols first and then XOR repair symbols over a soliton-selected subset, reproducible from `symbolId` and `sourceSymbolCount` alone — the two fields every v2 data frame carries. Tests assert the XOR identity against the same neighbour function a receiver will call, and assert reproducibility across encoder instances. **The degree distribution, the repair overhead ratio, and any recovery guarantee are Phase 03's subject**; this phase establishes the segment-bounded shape and the identity rule, and claims nothing about how much loss the code survives.

Compressibility is sampled during preflight from three windows of the actual bytes and reported in the metadata, and **nothing acts on it** — `compressionMode` stays `NONE`. Applying it is Phase 08. Phase 00 measured that entropy, not extension, is the real content effect, and the sampling is here so Phase 08 inherits a measurement rather than a guess.

---

## 7. Not established by this phase

- **Nothing optical.** No frame has been rendered as a QR code or read by a camera. `segmentSizeBytes` and `symbolSizeBytes` remain configuration with documented bounds, not chosen values.
- **No receiver.** The PWA neither parses nor reassembles v2. Phases 03, 05, and 06.
- **No packaged-runtime measurement.** The memory numbers are from Node with `--expose-gc`, not from the shipped Electron binary. Electron's main process is Node, so the pipeline's own accounting carries over, but the process-level RSS of a packaged app has not been measured.
- **No throughput claim.** `encodeSymbolsPerSecond` is 221k–240k on the v2 path, four orders of magnitude above the optical link. It is recorded because Phase 00 asked for stage metrics, not because it is a bottleneck.
- **No resume.** Segments are independently addressable, which is what resume will be built from, but nothing checkpoints. Phase 07.

---

## 8. Changed files

| File | Change |
|---|---|
| `src/core/segment-encoder.ts` | new — segment-scoped symbolizer, browser-safe |
| `src/main/streaming-sender.ts` | new — the streaming pipeline |
| `src/main/streaming-session-registry.ts` | new — privileged session ownership |
| `src/main/ipc-handlers.ts` | four `streamTransfer:*` channels through the existing trusted wrapper |
| `src/preload/index.ts` | the matching bridge methods |
| `src/shared/types.ts` | streaming metadata, progress, and frame-result types |
| `src/shared/errors.ts` | `FILE_EMPTY`, `FILE_READ_FAILED`, `FILE_CHANGED_DURING_TRANSFER`, `TRANSFER_CANCELLED` |
| `src/main/index.ts` | release streaming sessions on window close, renderer loss, and quit |
| `src/core/index.ts` | export the new core modules |
| `scripts/bench/phase02-sender-memory.ts` | new — v1 vs v2 memory and stage throughput |
| `tests/main/streaming-sender.test.ts` | new — 27 tests |
| `tests/main/streaming-ipc-boundary.test.ts` | new — 8 tests |
| `tests/core/segment-encoder.test.ts` | new — 9 tests |

No v1 transfer file was modified. `session-manager.ts`, `container.ts`, `protocol.ts`, `fountain-encoder.ts`, `fountain-decoder.ts`, and the renderer are untouched, so every v1 claim in `CURRENT-STATE.md` still stands.

---

## 9. What Phase 03 inherits

- A sender that produces segment-scoped systematic and repair symbols, with the repair neighbour function (`repairNeighbors`) already shared and browser-safe, ready for a receiver to call with the two fields the frame carries.
- A memory contract with a stated budget and a test that enforces it, so a decoder design can be judged against the same standard.
- The two open values Phase 04 will fix from measurement: `segmentSizeBytes` (currently 1 MiB) and `symbolSizeBytes` (currently 512, matching v1 for comparability).
- The one number Phase 03 has to justify: `repairOverheadRatio`, currently 0.05, chosen as a placeholder and backed by no recovery evidence at all.
