# PHASE-10 — Security Hardening and Abuse Resistance

**Program**: DEQR Large-File / Maximum-Speed Program
**Phase**: 10 (threat model, resource maxima, parser/FEC/compression/storage/IPC hardening, fuzz and property testing)
**Date**: 2026-08-22
**Verdict**: **PASS** — every gate criterion is met with executed evidence. Four deviations are stated in §8. Physical iPhone certification remains **PENDING** and is Phase 11's, unchanged.

---

## 1. Headline

**The wire format was already hard. The seams around it were not.**

Phases 01–09 built a parser that never throws, a decoder whose every quantity is capped, and a decompressor whose output buffer *is* its bound. Auditing them found nothing to fix. What the audit did find were four defects at the joints — the places where one hardened component hands something to another — and one of them was not a hypothetical:

**Every compressed transfer received to OPFS was being thrown away by DEQR's own security guard.** The receiver writes two payload files: `data.part` holds whatever the segments carried, and `original.part` holds the file when those segments carried a GZIP container. The allowlist that validates a `verified` message on arrival at the main thread named exactly one of them. So a compressed transfer would scan for an hour, recover every segment, decompress correctly, pass its SHA-256 — and then the main thread would silently drop the message announcing it, leaving a receive screen waiting forever for a file that already existed on the device. `export.ts` would have refused to open it for the same reason.

A too-narrow allowlist is a correctness defect exactly as a too-wide one is a security defect. Both are the same mistake: the set of things permitted did not match the set of things the system produces.

The other three:

| Defect | What it did | Fix |
|---|---|---|
| Manifest-level refusals were a rejected frame and nothing more | `progress().fault` is the only route from the pipeline to a screen. A phone pointed at a blocked file type, or at a transfer this browser cannot decompress, went on scanning silently — while the copy written in Phase 09 to explain exactly that sat unreachable in `faultCopy` | Every refusal `beginV2Session` can return is now a terminal session fault |
| `loopback:start` read a renderer-supplied `options` object inside a `setInterval` callback | A throw in a timer reaches no caller. `loopback:start(1, null)` surfaces as Electron's "A JavaScript error occurred in the main process" dialog — a renderer-triggered fault in the privileged process | Validated and clamped once at the IPC boundary, into a number; no renderer-supplied structure reaches a timer |
| A checkpoint on the device was read and decoded without a size bound | `base64ToBytes` allocates three bytes per four characters, and the length check ran *after* the decode. Origin-private storage is only writable by this origin, which is a statement about a browser, not a property of this code | Bounded file read, and the base64 length is checked before the allocation it exists to prevent |

Plus two smaller ones: a manifest declaring more segments than the receiver admits reached `SegmentedReceiver`'s constructor inside the provisioning callback and surfaced as `CHECKPOINT_INCONSISTENT` — a sentence about a checkpoint that had nothing to do with it; and `receive:saveReceivedFile` passed a renderer-supplied `defaultName` straight to `dialog.showSaveDialog`'s `defaultPath`, which accepts an absolute path.

---

## 2. What was built

| Component | File | What it is |
|---|---|---|
| Receiver resource policy | `src/core/receiver-policy.ts` | **New.** Every receiver-side maximum, in one module, with the arithmetic that makes each a bound rather than a guess |
| Manifest admission check | `receiver-policy.ts` → `manifestPolicyRefusal` | Whether this build will act on a manifest, decided before any device is touched |
| Payload-file allowlist | `mobile-web/src/opfs.ts` → `isReceiverSessionFile` | The closed set of files a session can be exported from: `data.part` and `original.part`, and nothing else — notably not `checkpoint.json` |
| Checkpoint size bound | `mobile-web/src/opfs.ts` → `MAX_CHECKPOINT_BYTES` | A checkpoint larger than the largest one this receiver writes is refused unread |
| IPC argument guards | `src/main/ipc-handlers.ts` → `asSessionId`, `readLossPercentage` | Types at the boundary, so nothing renderer-supplied reaches a timer callback |
| Frame length gate | `mobile-web/src/receive-pipeline.ts` → `submit` | One comparison in front of two O(n) passes |
| Refusal copy | `mobile-web/src/receiver-view-model.ts` → `MANIFEST_POLICY_FAULT_CODES` | A sentence, a remedy, and which device the remedy is on |
| Repair-id observability | `src/core/segment-decoder.ts` → `trackedRepairIds` | So `maxTrackedRepairIds` can be asserted rather than merely stated |
| Threat model | `.ai-team/engineering/SECURITY.md` §6 | Thirteen v2 threats, each naming the file that enforces its control |

---

## 3. Acceptance gate

> Malformed input fails closed without crash, unbounded allocation, infinite/very long CPU loop, arbitrary file write, or privilege escalation.

**Without a crash.** The parser is total by construction and stays so under 8,000 randomized buffers (`protocol-v2-fuzz.test.ts`, unchanged). Recovery is now held to the same standard: 20,000 bit-flipped frames, 5,000 header-corrupted frames and 5,000 random buffers carrying a valid v2 prefix, driven through `SegmentedReceiver`, with `expect(...).not.toThrow()` on every one (`tests/core/hostile-stream.test.ts`). On the PWA side, 5,000 random payloads through the real `ReceivePipeline`, a third of them forced to carry the v2 prefix (`mobile-web/tests/hostile-receive.test.ts`).

**Without unbounded allocation.** Asserted against numbers the decoder reports about itself, not against wall-clock time:

| Attack | Bound that holds | Evidence |
|---|---|---|
| 50,000 identical repair frames | `pendingEquations`, `pendingNeighborRefs`, `xorBytes` and `heldBytes` are all *unchanged* from after the first | `hostile-stream.test.ts` |
| 20,000 distinct repair ids the algebra cannot consume | Refused as `saturated` after the cap; 19,000+ refusals, `heldBytes` under a stated ceiling | `hostile-stream.test.ts` |
| 20,000 distinct repair ids on the shipping soliton | `heldBytes` checked under the ceiling on **every single frame**, `trackedRepairIds` under its cap | `hostile-stream.test.ts` |
| 10,000 frames at a completed segment | `xorBytes` unchanged: a second display pass is free, not quadratic | `hostile-stream.test.ts` |
| Manifest declaring 2^24 + 1 segments | Refused at the manifest; **zero bytes** created on the device | `hostile-receive.test.ts` |
| Frame declaring a u32-maximum `sourceSymbolCount` | Refused against the manifest's own plan before a decoder exists; `heldBytes` unchanged, `activeSegments` still 0 | `hostile-stream.test.ts` |
| 64 MiB of zeros gzipped into a 64 KiB window | `DECOMPRESSED_SIZE_MISMATCH`; the sink is still exactly one window | `hostile-receive.test.ts` |
| Checkpoint with a 2.8 MB base64 bitmap | `CHECKPOINT_UNREADABLE`, decided by a length comparison | `hostile-receive.test.ts` |
| Payload longer than any DEQR frame | `FRAME_TOO_LONG`, before the fingerprint walks it | `hostile-receive.test.ts` |

**Without a long CPU loop.** The two O(1) refusals in `acceptRepair` are ordered before the neighbour computation, so a saturated decoder costs a constant per frame rather than O(K) — the duplicate-storm and saturation tests are what hold that. Verification and decompression yield to the event loop every 16 MiB and check for cancellation at each yield.

**Without arbitrary file access.** No path or filename from the wire ever reaches a file operation. Session directories are `sessionDirectoryName(sessionId, fileId)` — two u32 rendered as fixed-width hex, filename-safe by construction. The transmitted *filename* is metadata only, sanitized on serialize and again on parse. The one path that crosses a process boundary is validated on receipt (`isReceiveWorkerEvent`) and again at the open (`openSessionFile`), for shape and filename both. Nine hostile path shapes and eight hostile filenames are refused in `hostile-receive.test.ts`, including `['deqr','sessions','..']` and `checkpoint.json`.

**Without a false verified state.** 5,000 header-corrupted frames never once report `sessionComplete`. A forged adoption bitmap with every bit set cannot push `committedCount` past `segmentCount`. The digest runs over bytes *read back from the device*, so a write that did not happen fails it. `verifyV2` compares the store's own `segmentsWritten()` and `bytesCommitted()` against the manifest before hashing, because a manifest is untrusted input and hashing on its word would read whatever was in the file.

**Without privilege escalation.** The Electron posture is unchanged and re-verified: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, navigation and popups denied, network denied by `onBeforeRequest`, media permission narrowed to video, CSP applied as a real header. Every IPC channel goes through `handleTrusted` with no exempt tier, and now every argument through a type guard as well.

---

## 4. One policy, and why it is one file

The brief asks for explicit maxima "centralized so tests and parser share the same policy". Before this phase they were spread across five modules, and a test could only assert against whichever copy it happened to import.

`src/core/receiver-policy.ts` is now the single copy. `segment-decoder.ts`, `segmented-receiver.ts`, `receiver-client.ts`, `worker-protocol.ts`, `segment-store.ts`, `opfs.ts` and `receive-pipeline.ts` all read it; `tests/core/security-limits.test.ts` compares the policy against the constants those modules actually expose, so reintroducing a literal fails the build rather than passing quietly.

Two rules make it more than a container:

- **Policy narrows the wire format and never widens it.** `V2_LIMITS` says what the format can *express* — a u32 segment count, a u64 size. Policy says what this build will *act on*. Every derived bound is computed from `V2_LIMITS` rather than typed in, so a narrowing of the format narrows policy with it, and the test asserts the direction.
- **A refusal is decided before a device is touched.** `manifestPolicyRefusal` runs after the parser has proved a manifest self-consistent and before storage is provisioned, so a transfer this receiver was never going to accept costs no device work and is reported as the refusal it is.

| Quantity the brief names | Policy field | Value |
|---|---|---|
| manifest bytes | `maxManifestFrameBytes` | 1,363 (derived: 84 + 1,024 + 255) |
| filename bytes | `maxFilenameBytes` | 1,024 |
| frame payload | `maxSymbolSizeBytes` / `maxFrameBytes` | 4,096 / 4,128 |
| segment size | `maxSegmentSizeBytes` | 64 MiB |
| source symbols per segment | `maxSourceSymbolsPerSegment` | 2,097,152 (derived: 64 MiB ÷ 32 B) |
| FEC degree | enforced per segment as `sourceSymbolCount` | re-checked in `segment-decoder.ts` |
| repair symbols before policy action | `pendingNeighborRefsPerSymbol`, `trackedRepairIdsPerSymbol` | 12 + 1,024 refs; 4K + 64 ids |
| active sessions | `maxActiveSegments` (decoders); one pipeline per worker | 2 |
| queued frames | `maxFramesInFlight` | 2 |
| checkpoint size | `maxCheckpointBytes` | 2,800,300 (bitmap base64 + 4 KiB) |
| compression expansion ratio | `maxDecompressedWindowBytes` | 64 MiB; per window, the manifest's own figure |
| worker message size | `maxFramePixelBytes`, `maxReasonChars` | 2,073,600; 200 |

---

## 5. Fuzz and property testing

No dedicated fuzzer binary exists in this project's tooling and adding one would mean a new dependency on an offline-only build, so the phase used seeded property testing instead — deterministic on purpose, so a failure is reproducible from the test name rather than "sometimes".

| Input class the brief names | Where |
|---|---|
| malformed / truncated frames | `protocol-v2-fuzz.test.ts` (existing), `hostile-stream.test.ts`, `hostile-receive.test.ts` |
| boundary values | `security-limits.test.ts` — every cap tested at the edge and one past it |
| offset / count overflow | `security-limits.test.ts` (`transportSize` at 2^60), `hostile-stream.test.ts` (segment index at 0xffffffff) |
| random bytes | 8,000 buffers (parser, existing) + 30,000 (recovery) + 5,000 (pipeline) |
| duplicate storms | `hostile-stream.test.ts` — 50,000 identical, 20,000 distinct, 10,000 post-completion |
| pathological FEC metadata | `hostile-stream.test.ts` — degree above K, neighbour outside the segment, negative index, id at the u32 ceiling |
| decompression bombs (generated safely at small scale) | `hostile-receive.test.ts` — 64 MiB of zeros into a 64 KiB window, an impossible record length, a short expansion, a non-gzip member, trailing bytes |
| malicious filename | `hostile-receive.test.ts` — eight shapes including traversal, both separators, a null byte, an ANSI escape, 300 dots |
| checkpoint tampering | `hostile-receive.test.ts` — oversized bitmap, disagreeing counters, bits past the last segment, wrong session/file/digest/segmentation, oversized file |
| unsupported profile / version | `worker-message-schema.test.ts` (existing) + `hostile-receive.test.ts` protocol-version refusals |
| cancel during hostile stream | `hostile-stream.test.ts` (release mid-flood) and `hostile-receive.test.ts` (cancel through the real pipeline, storage checked empty afterwards) |

---

## 6. Performance

**No security rule was weakened for throughput, and none needed to be.**

Exactly one check was added to a per-frame path: a single integer comparison of `bytes.length` against `maxFrameBytes`, placed *ahead* of `frameFingerprint`, which is O(n) over the same buffer. On a refused payload this strictly reduces work; on an accepted frame it is one comparison against a decode that costs 60–90 ms. Nothing else on the accept path changed.

The remaining hardening runs once per session (manifest admission, checkpoint bounds) or once per message (the worker guards), not per frame. **No benchmark was re-run**, and that is recorded as an absence rather than reported as a measurement — see §8.

---

## 7. What did not change

- **The wire format.** No edit to `protocol-v2.ts`, `protocol.ts` or `container.ts`. The 24 golden vectors regenerate byte-identically and all 52 vector assertions pass.
- **The worker protocol version.** Still **5**. No message shape changed; `isVerifiedSource` became correct about a filename it was already validating, which is not a shape change and does not invalidate a cached shell.
- **The Electron posture.** Audited and unchanged; the IPC hardening is additive.
- **The PWA posture.** Camera is user-driven and video-only, CSP is served as a real header with `frame-ancestors 'none'`, `connect-src 'self'`, no remote origin anywhere, worker and WASM choices unchanged.
- **Any prior assertion.** No existing test was weakened, deleted or relaxed. The 789 desktop and 347 PWA tests that passed before this phase all still pass.

---

## 8. Stated deviations

1. **No dedicated fuzzer.** Property and randomized testing with a seeded LCG rather than a coverage-guided fuzzer, because none is present in this project's tooling and DEQR builds offline. The trade is real: seeded sweeps explore less than a coverage-guided run would. What they buy is reproducibility and a suite that runs in CI in under five seconds.
2. **No benchmark was re-run.** §6 argues from the shape of the change — one comparison ahead of an existing O(n) pass — not from a measurement. That is an argument, not evidence, and it is labelled as one. If Phase 11's certification run shows a per-frame regression, this is the first place to look.
3. **v1's `LIMITS` are not centralized.** `mobile-web/src/protocol.ts` keeps its own bounds. v1 is a separate, frozen wire format with a different unit of allocation (a whole in-memory container), and folding its numbers into a v2 receiver policy would blur exactly the distinction that makes the policy readable. v1 remains bounded by its own limits, which are unchanged and still tested.
4. **`StreamingSessionRegistry` has no cap on concurrent sessions.** Every session costs a modal `showOpenDialog` and a human choosing a file, so a renderer cannot mint them unattended, and each is released on cancel, window close, renderer loss and quit. Accepted with that reasoning rather than fixed with a number nobody could justify.

---

## 9. Verification

Every command below was executed; output was captured.

| Gate | Command | Result |
|---|---|---|
| Desktop tests | `npm test` | **842 passed / 51 files** (from 789 / 48) |
| PWA tests | `npm run mobile-web:test` | **378 passed / 28 files** (from 347 / 27) |
| Desktop typecheck | `npm run typecheck` | clean |
| Main typecheck | `tsc -p tsconfig.main.json --noEmit` | clean |
| PWA typecheck | `npm run mobile-web:typecheck` | clean |
| Desktop build | `npm run build` | clean |
| PWA build | `npm run mobile-web:build` | clean; receive worker chunk 218.23 kB |
| Packaged renderer | `npm run test:packaged` | PASS |
| Golden vectors | `npm run vectors:v2:generate` then vector suite | 24 written, 52 assertions pass |
| AI system validator | `npm run doctor` | PASSED, **0 warnings** |
| Adapter drift | `npm run drift-check` | PASSED, zero drift |
| Runtime | Vite on 5173, then `npx electron .` | `DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available`; renderer console at debug/info only, no error or warning |

**On the runtime check.** Six IPC handler signatures changed, so the app was
launched to confirm the preload bridge still resolves and the dashboard still
mounts — it does. What was **not** exercised in the live app is the
`loopback:start` crash itself: reproducing it means calling the bridge with a
deliberately malformed argument from inside the renderer, which needs either
remote debugging enabled or a change to the app to test the app. It is covered
instead by `tests/main/ipc-input-validation.test.ts`, which drives the real
registered handler through the real trusted-sender guard under fake timers and
advances the clock to prove no callback throws. That is an executed test against
the shipping code path, and it is what the claim rests on.

**Tests added: 84.** Three desktop files (`security-limits` 18, `hostile-stream` 21, `ipc-input-validation` 14 = 53) and one PWA file (`hostile-receive` 31). No existing test was modified.

---

## 10. What Phase 11 inherits

- **A policy object worth benchmarking against.** `worstCaseDecoderBytes(segmentSizeBytes, symbolSizeBytes)` states the memory claim as arithmetic rather than as a paragraph, so a certification run can compare a measured resident set against a number the build itself computes.
- **A regression that only a device can fully close.** The compressed-OPFS export path is now correct and is tested end to end against a fake OPFS. It has still never run against a real one — which is the constraint Phase 06 recorded and Phase 11 owns.
- **Two refusals that now have screens and have never been seen on one.** `UNSUPPORTED_COMPRESSION` and the manifest-policy refusals reach the UI for the first time in this phase. The copy is asserted; the layout on a real iPhone is not.
- **An unchanged worker protocol.** A cached Phase 09 shell still handshakes with a Phase 10 worker, so the shell-staleness class of failure is not in play for this phase's changes.
