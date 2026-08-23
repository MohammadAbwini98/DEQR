# PHASE-03 — Systematic-First Fountain / Segmented Recovery

**Program**: DEQR Large-File / Maximum-Speed Program
**Phase**: 03 (FEC and receiver-side recovery only — no QR visual profiles, no PWA UI)
**Date**: 2026-08-20
**Verdict**: **PASS** — every gate criterion is met with executed evidence. Six deliberate scope decisions are stated in §7, one of which changes a shipping default and costs clean-channel throughput.

---

## 1. Headline

**A loss-free segment now costs exactly zero XOR operations. Not near-zero — zero, and the test asserts the integer.**

v1's decoder treats every frame as an equation, including the systematic ones: it builds a degree-1 node, pushes it into a graph that spans the whole file, ripples it, and copies the payload back out. On a clean channel that is entirely ceremony, because the frame already *is* the block.

| Path | Loss-free decode, 1 MiB | Rate | Under 30% loss | Rate |
|---|---|---|---|---|
| v1 whole-file LT | 3.065 ms | 342 MiB/s | 17.5 ms | 57 MiB/s |
| **v2 systematic-first** | **0.811 ms** | **1,302 MiB/s** | 25.9 ms | 39 MiB/s |

3.8× faster when nothing is lost, 1.5× slower when a third of it is. Both are enormous against the 5,120 B/s optical link Phase 00 measured — the slower of the two numbers is a **7,900× margin** — and §7.3 records that two attempts to close the lossy gap were measured as no-change and reverted rather than kept on a theory.

The number the phase existed to produce is the second headline. Phase 02 shipped `repairOverheadRatio = 0.05` and its own report said the value was "backed by no recovery evidence at all". It is now backed by evidence, and the evidence says **0.05 recovers nothing at any loss rate above zero**.

---

## 2. What was built

| Artifact | Location | Purpose |
|---|---|---|
| Segment decoder | `src/core/segment-decoder.ts` | Systematic-first recovery for one segment; browser-safe |
| Segment sequencing | `src/core/segmented-receiver.ts` | Manifest binding, routing, bounded decoder budget, commit-and-release |
| FEC profile seam | `src/core/segment-encoder.ts` | `RepairNeighborFn` — the one thing a profile chooses |
| Measured budget | `src/main/streaming-sender.ts` | `MEASURED_REPAIR_OVERHEAD`, and the default derived from it |
| Recovery benchmark | `scripts/bench/phase03-fec.ts` | Required-overhead sweep, candidate rules, v1-vs-v2 comparison |
| Decoder tests | `tests/core/segment-decoder.test.ts` | 35 tests |
| Receiver tests | `tests/core/segmented-receiver.test.ts` | 25 tests |
| End-to-end tests | `tests/main/streaming-fec-end-to-end.test.ts` | 11 tests, real sender through a lossy channel into the real receiver |
| Shared-engine tests | `mobile-web/tests/protocol-v2-shared-codec.test.ts` | +6, incl. a full segmented receive inside the PWA project |
| Normative spec | `.ai-team/engineering/PROTOCOL-V2.md` §7.2, §7.3 | FEC profile `0x01` written down well enough to reimplement |

### 2.1 The two decisions that carry the phase

**A source symbol never enters the graph.** It is written straight into the segment store at its block offset and its bit is set. There is no node, no equation, no copy back out. That is why the loss-free path measures zero: there is nothing on it to measure. Everything algebraic is reached only from `symbolId ≥ sourceSymbolCount`.

**A committed segment is gone before the next frame arrives.** `SegmentedReceiver` holds at most `maxActiveSegments` decoders (default 2 — the one being received, plus one still finishing as the sender crosses a boundary). When a segment completes, its buffer is *transferred* to the sink by `detach()` and every other structure — equations, bitmap, neighbour index, duplicate set — is dropped in the same call. A frame for a committed segment afterwards costs one bit test.

The only state proportional to the file is the completion bitmap: one bit per segment, 128 bytes for a 1 GiB transfer at 1 MiB segments.

---

## 3. Acceptance gate

| Gate criterion | Status | Evidence |
|---|---|---|
| Loss-free transfer requires near-zero repair work | **MET** | `stats().xorBytes === 0`, `rippleSteps === 0`, `pendingEquations === 0`, `repairAccepted === 0` after a complete clean segment; asserted again end-to-end through the real sender |
| 5%, 10%, 20%, 30% simulated loss reconstructs correctly | **MET** | Decoder loss ladder at 0/1/5/10/20/30%, five seeds each, byte- and SHA-256-identical; repeated end-to-end through sender → lossy channel → receiver |
| Duplicates / out-of-order frames do not corrupt output | **MET** | Every frame delivered three times over; fully shuffled streams at three seeds; repair-before-source; repair delayed until after the source pass |
| SHA-256 fixtures match | **MET** | Every recovery assertion is a digest comparison, and the end-to-end test compares against the digest the **manifest** carried before the first frame was drawn |
| CPU / memory is segment-bounded | **MET** | `heldBytes()` asserted against a configuration-only bound after every frame; per-frame work capped and the caps asserted; a saturated decoder proven to refuse without deriving a neighbour set |

Execution-prompt gate, restated:

| Requirement | Status |
|---|---|
| Loss-free v2 transfer follows the cheap systematic path | MET — zero algebra, measured |
| Repair work occurs only when needed | MET — `xorBytes` is 0 until a symbol is actually missing |
| 30% simulated loss fixtures reconstruct and hash-identically | MET — decoder, receiver, and end-to-end |
| Memory stays segment-bounded | MET — decoder budget, receiver budget, both asserted per frame |

### 3.1 The prompt's test list

| Required test | Where |
|---|---|
| 0%, 1%, 5%, 10%, 20%, 30% deterministic loss | `reconstructs byte- and hash-identically at %s loss` (×6, five seeds each) |
| Duplicates | `treats a repeated symbol as a duplicate rather than as information` |
| Randomized out-of-order delivery | `accepts a fully shuffled stream and reconstructs identically` |
| Delayed repair symbols | `recovers when repair symbols are delayed until well after the source pass` |
| Segment boundary cases | `handles a file that is exactly one segment and one that is exactly two`, `handles a final segment of a single byte` |
| Final short symbol / padding | `reconstructs the final short symbol without its padding`, and the same symbol recovered *through repair* |
| Corrupt symbol CRC | `rejects a frame whose CRC does not match its contents` |
| Invalid repair seed / index / degree | `rejects an equation whose profile hands back an out-of-range index or degree` (5 cases) |
| Cancel / reset while decoder is active | `releases cleanly mid-recovery, with equations still outstanding`; `drops every decoder on release and refuses afterwards` |
| Multiple sequential segments, no state leakage | `carries no state from one segment into the next` |

The leakage test is worth naming: two segments are given **byte-identical contents**. If any bitmap, equation, or store survived the commit, the second segment would appear partly pre-solved. It costs exactly the same number of accepted frames as the first.

---

## 4. The number Phase 02 left open

`scripts/bench/phase03-fec.ts --mode sweep` emits a full systematic pass, then repair symbols, and records the frame at which the segment closed. That frame *is* the answer — a run that completes after r repair symbols would also complete at any larger budget — so no search over ratios is needed.

**99th-percentile repair-to-source ratio required to close a segment**, independent per-frame loss:

| Segment / symbol | K | 0% | 1% | 5% | 10% | 20% | 30% |
|---|---|---|---|---|---|---|---|
| 1 MiB / 512 B | 2,048 | 0.00 | 0.46 | 0.71 | 0.71 | 0.72 | **0.94** |
| 2 MiB / 512 B | 4,096 | 0.00 | 0.60 | 0.60 | 0.62 | 0.79 | 0.92 |
| 4 MiB / 512 B | 8,192 | 0.00 | 0.52 | 0.73 | 0.74 | 0.98 | 0.98 |
| 1 MiB / 1 KiB | 1,024 | 0.00 | 0.91 | 0.91 | 0.94 | 0.98 | 1.20 |
| 1 MiB / 2 KiB | 512 | 0.00 | 0.57 | 1.17 | 1.17 | 1.17 | **1.55** |

Zero failures in every cell, across 12–40 trials each.

Three findings, none of them guessable from the code:

**The requirement barely moves between 1% and 20% loss.** It is not the loss that costs, it is the tail. Closing the last few symbols of a segment needs a repair symbol that happens to touch exactly one of them, and once only a handful are missing that is rare however few there are. This is why the curve is flat and why there is no cheap operating point above zero: the cost is close to binary — either a transfer tolerates loss for about +0.7, or it does not tolerate loss at all.

**Segment size barely matters; symbol size does.** At a fixed 512-byte symbol, 1/2/4 MiB segments all need 0.92–0.98 at 30%. Holding the segment at 1 MiB and growing the symbol to 2 KiB — which cuts K to 512 — pushes 30% to 1.55 and 5% from 0.71 to 1.17. **`symbolSizeBytes` is a recovery-efficiency decision as well as a QR-capacity one.** Phase 04 must weigh both; a bigger symbol means fewer QR frames *and* materially worse FEC efficiency.

**Burst loss costs the same as independent loss.** At 1 MiB / 512 B: 0.46 / 0.69 / 0.71 / 0.78 / 0.99 against 0.46 / 0.71 / 0.71 / 0.72 / 0.94. Neighbour selection is pseudorandom over the segment, so index adjacency means nothing to it. A hand that moves and a camera that occasionally misses are the same event to this code.

### 4.1 Two alternative degree rules, measured and rejected

The plan invites "an improved compatible implementation" and warns against adopting one on theory. Both candidates were run through the **real** encoder and the **real** decoder via the `RepairNeighborFn` seam, so nothing about the comparison is a reimplementation.

p99 required ratio, 1 MiB / 512 B, shipping decoder caps:

| Rule | 0% | 1% | 5% | 10% | 20% | 30% |
|---|---|---|---|---|---|---|
| **Robust soliton (shipped)** | 0.00 | 0.46 | 0.71 | 0.71 | 0.72 | 0.94 |
| Geometric degree ladder | 0.00 | **0.08** | **0.24** | **0.44** | *failed 40/40* | *failed 40/40* |
| Fixed degree 3 | 0.00 | 1.68 *(1 fail)* | 1.97 *(7)* | 1.98 *(17)* | 1.97 *(37)* | *failed 40/40* |

The ladder is **5.8× cheaper at 1% loss** and better anywhere below about 10%, which is plausibly where a real optical link lives. It was still rejected, and the reason was checked rather than assumed: rerun with the decoder's memory caps removed, it recovers at 20% and 30% but needs p99 1.54 against the soliton's 0.94. So the failure is not purely an artefact of our caps — the rule genuinely spends most of its symbols at the wrong scale when a third of the segment is missing — and the caps then turn a bad outcome into a total one, because high-degree equations at high loss fill the pending budget with rows nothing can use.

Fixed degree 3 is worse everywhere, which disposes of the intuition that the optimal single degree for 30% loss (≈ 1/q ≈ 3) is a good setting: it ignores that belief propagation *cascades*, and the soliton's shape exists to feed that cascade.

**The robust soliton was the only rule that closed every trial at every measured rate under the shipping caps.** Profile `0x01` is therefore unchanged, and no new dependency was added. The measurement is handed to Phase 04 with the seam in place; a soliton/ladder hybrid plus degree-preferential eviction of pending equations is the specific hypothesis the data points at, and it is Phase 04's to test.

---

## 5. The default changed, and it costs something

`DEFAULT_STREAMING_SENDER_CONFIG.repairOverheadRatio`: **0.05 → 0.75.**

0.05 was not merely low. At the default profile it closes a segment only when nothing at all is lost; at 1% loss it leaves roughly twenty symbols per segment unrecoverable. Shipping it would have been a promise the code cannot keep.

0.75 covers every measured rate up to 20% loss at p99, and 30% about half the time. **It makes a clean transfer carry 75% more frames than it needs** — 1 GiB at the Phase 00 link rate goes from about 33 hours to about 58. That is a real cost and it is stated rather than buried; `spends the shipping repair budget on a clean channel, at a cost this test states` asserts it in the suite, so changing the default requires changing a test that spells the trade out.

Why it cannot simply be smaller today: **a segment has to finish inside the pass in which it is received.** The receiver holds at most two decoders, so when the sender moves on, an unfinished segment's partial recovery is discarded. A second display pass therefore restarts it from zero rather than topping it up, and a small budget plus retries is strictly worse than one generous pass — at 5% loss, a 0.30 budget needs about 2.5 passes averaging 3.25 K frames against 1.75 K for a single 0.75 pass.

The right fix is not a bigger budget. It is **carrying partial segment recovery across passes**, which needs receiver storage (Phase 06) and checkpoints (Phase 07). Both are recorded in `PROTOCOL-V2.md` §12. Until they exist, 0.75 is an operating point, not an optimum, and Phase 04 sets the value per transport profile against a link whose real loss rate nobody has yet measured on a device.

---

## 6. Bounds, and what a hostile stream can buy

Every quantity an attacker or a corrupt stream can influence is capped, and — the part that matters — the cheap refusals are tested **before** the expensive ones.

| Quantity | Cap | Consequence at the cap |
|---|---|---|
| Pending equations | K | Further repair symbols refused as `saturated` |
| Pending neighbour references | 12 K + 1024 | Same |
| Tracked repair identities | 4 K + 64 | Tracking stops; untracked duplicates still eliminate to degree 0 and are discarded |
| Equation degree | K | Enforced by the shared generator, re-validated on receipt |
| Live decoders | `maxActiveSegments` (2) | Least-recently-advanced segment evicted |
| Declared segment count | 2²⁴ | Manifest refused at construction |

`answers a saturated decoder in constant time, without computing neighbours` proves the ordering directly: a counting neighbour function is injected, the decoder is driven to saturation, then 500 further repair frames are pushed in and the call count does not move. A stream of unusable repair frames therefore cannot buy O(K) of elimination work per frame.

The segment-count cap deserves naming: the protocol field is u32, and honouring it literally would mean allocating a 512 MB completion bitmap on a phone from an untrusted manifest. 2²⁴ segments is 16 TiB at 1 MiB segments, which at 5,120 B/s is about a century of transfer; the bitmap costs 2 MiB in that pathological case and 128 bytes for a 1 GiB file.

Memory, asserted after every accepted frame rather than sampled: the decoder never exceeds segment + K/8 + K × symbolSize, and the receiver never exceeds twice that plus the bitmap. Neither bound mentions the file.

**One correctness boundary is explicit.** `never lets a corrupted payload silently pass as a reconstruction` feeds a flipped byte past the wire layer and asserts the segment comes out **different**. The frame CRC rejects optical damage and SHA-256 over the reconstructed file remains the sole authority on identity; the decoder itself claims neither, and the test says so rather than leaving it implied.

---

## 7. Stated deviations

**7.1 No adaptive repair ratio.** The plan lists it as optional. It is not implemented, and the reason is structural rather than schedule: adaptation needs either a back channel — the optical link has none, it is a screen and a camera — or partial state carried across passes, which is Phases 06/07. Measuring the curve and publishing it as `MEASURED_REPAIR_OVERHEAD` is what could be done honestly instead.

**7.2 The default now costs clean-channel throughput.** §5. Raising 0.05 to 0.75 fixes a default that recovered nothing, and charges 75% more frames on a link where nothing is lost. Phase 04 owns the operating value.

**7.3 The v2 decoder is slower than v1's under loss.** 1.5× at 30%, against 3.8× faster loss-free. Two candidate causes were tested and both measured as no-change: replacing the equation `Set`s with swap-removal arrays, and rewriting the XOR loops against zero-based views. **Both were reverted rather than kept on a plausible-sounding theory** — the array form was kept only because it allocates less at equal speed, and `src/core/segment-encoder.ts` was returned to its Phase 02 text. The residual cause is not established. It was not pursued further because the margin over the link is 7,900× and the decoder's real deadline is the iPhone camera loop, where 26 ms per 1 MiB segment at 30% loss is not the binding constraint.

**7.4 A `RepairNeighborFn` seam was added to a Phase 02 file.** `src/core/segment-encoder.ts` gained an optional constructor parameter. Measuring a candidate degree rule *through the real encoder and decoder* is impossible without it, and the manifest's `fecProfileId` already anticipated exactly this extension point. The XOR loop in that file is byte-identical to Phase 02.

**7.5 Evicting a segment discards its partial recovery.** That is the honest cost of a fixed decoder budget, and it is why the budget is a configured number rather than an implicit one. `evicts the least recently advanced segment when the budget is full` asserts both halves: work is lost, and **nothing is committed on a guess**.

**7.6 Still not wired into either shipping UI.** The renderer still drives v1 and the PWA still reads v1. Wiring the receiver is Phase 05 and display cadence is Phase 04; doing either here would mean doing it twice. No v1 transfer file was modified — `fountain-encoder.ts`, `fountain-decoder.ts`, `protocol.ts`, `container.ts`, `session-manager.ts` and both renderers are untouched — so every v1 claim in `CURRENT-STATE.md` still stands.

---

## 8. Verification

| Command | Result |
|---|---|
| `npm test` | **510 PASS / 34 files** (Phase 02: 439 / 31) |
| `npm run mobile-web:test` | **77 PASS / 12 files** (Phase 02: 71 / 12) |
| `npm run typecheck` | PASS |
| `npm run mobile-web:typecheck` | PASS |
| `npm run build` | PASS |
| `npm run mobile-web:build` | PASS |
| `npm run test:packaged` | PASS |
| `npm run doctor` | PASS, 0 warnings |
| `npm run drift-check` | PASS, zero drift |

The receiver's modules are held to the same browser-safety contract as the v2 codec: `prng.ts`, `segment-encoder.ts`, `segment-decoder.ts` and `segmented-receiver.ts` are asserted inside the **mobile-web** project to import nothing outside the repository, never mention `Buffer`, never call `require`, and never touch `process`. A full segmented receive with a third of the frames discarded runs there too, through the same Vite pipeline the PWA builds with — so Phase 05 imports this engine rather than reimplementing it.

Reproduce the measurements:

```bash
node node_modules/vite-node/vite-node.mjs scripts/bench/phase03-fec.ts -- --mode sweep --segment-kib 1024 --symbol 512 --trials 40
```

```bash
node node_modules/vite-node/vite-node.mjs scripts/bench/phase03-fec.ts -- --mode compare --segment-kib 1024 --symbol 512 --loss 0,0.05,0.30 --trials 40
```

Evidence lands in `.local-run/bench/`, which is gitignored; this report is the durable copy.

---

## 9. What Phase 04 inherits

- **The seam and the data to use it.** `RepairNeighborFn`, `fecProfileId`, and a measured comparison of three degree rules across six loss rates. The soliton/ladder hybrid is the specific candidate worth testing, together with evicting pending equations by degree so a badly-matched rule degrades instead of failing.
- **A symbol-size trade-off with numbers on it.** Bigger symbols mean fewer QR frames and materially worse FEC efficiency: 512-byte symbols need 0.94 at 30% loss, 2 KiB symbols need 1.55.
- **A repair budget that is currently a stated assumption.** 0.75 covers 20% loss and costs 75% of a clean transfer. It should be a per-profile value chosen against a link whose loss rate has actually been observed.
- **Receiver telemetry that already exists.** `recovery()` reports per-segment solved, missing, pending equations, and `needsMoreRepair`; `stats()` reports accepted, duplicate, rejected, repaired, and `xorBytes` as a CPU proxy. Phase 09 needs these to explain a stall rather than show a spinner.
