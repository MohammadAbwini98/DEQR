# PHASE-01 — DEQR v2 Binary Protocol and Large-File Semantics

**Program**: DEQR Large-File / Maximum-Speed Program
**Phase**: 01 (protocol definition and implementation only — no sender or receiver integration)
**Date**: 2026-08-20
**Tree**: `main` at `05ec275` plus the Phase 00 and Phase 01 working tree
**Verdict**: **PASS** — every gate criterion is met with executed evidence. Two deliberate deviations from the plan are stated in §5.

Normative specification: [`PROTOCOL-V2.md`](../../engineering/PROTOCOL-V2.md).

---

## 1. What was built

| Artifact | Location | Purpose |
|---|---|---|
| Normative spec | `.ai-team/engineering/PROTOCOL-V2.md` | Byte-layout tables, constraints, error model, migration |
| Codec | `src/core/protocol-v2.ts` | Types, serializer, parser, segmentation, 64-bit helpers |
| CRC-32/ISO-HDLC | `src/core/crc32.ts` | Per-frame integrity, shared by both surfaces |
| Golden vectors | `protocol/test-vectors-v2/` (21 files + `expected.json`) | Byte-for-byte fixtures, including 12 rejection cases |
| Vector generator | `scripts/protocol/generate-v2-vectors.ts` | Deterministic; `npm run vectors:v2:generate` |
| Round-trip / bounds / 64-bit tests | `tests/core/protocol-v2.test.ts` | 55 tests |
| Vector conformance | `tests/core/protocol-v2-vectors.test.ts` | 46 tests |
| Fuzz / property tests | `tests/core/protocol-v2-fuzz.test.ts` | 8 properties over ~20,000 generated inputs |
| Shared-codec tests | `mobile-web/tests/protocol-v2-shared-codec.test.ts` | 8 tests, run through the PWA's own Vite pipeline |
| CI reproducibility | `.github/workflows/ios1-core.yml` | Regenerate + `git diff --exit-code` on the v2 vectors |

**Nothing in the sender or the receiver emits or accepts v2 yet.** v1 remains the shipping wire format, unmodified. That is the phase boundary: Phase 02 makes the desktop sender streaming, and wiring v2 into it belongs there.

---

## 2. The design, in one page

**The manifest / data-frame split.** v1 repeated `blockCount`, `blockSize`, and `totalPayloadLength` in every one of tens of thousands of frames. v2 puts the expensive metadata — filename, SHA-256, sizes, segmentation, compression mode, FEC profile — in a **session manifest** that is retransmitted periodically, and keeps data frames to 32 bytes of overhead.

**Segments are real.** `segmentIndex` is a live u32 field, not a constant zero. Each segment is independently decodable, so decoder state is proportional to one segment rather than to the file. `tests/core/protocol-v2.test.ts` asserts this directly: a 5 MiB transfer and a 5 TiB transfer at the same segment size have byte-identical per-segment working sets and differ only in segment count.

**64-bit means `bigint`, not "a big number".** `originalSize`, `transportSize`, and every derived offset are `bigint` end to end. The only route to `number` is `toSafeNumber`, which throws `PRECISION_LOSS` above `Number.MAX_SAFE_INTEGER` rather than rounding.

**What data frames deliberately omit.** The logical file offset is derived from the manifest, not transmitted — eight bytes per symbol is real optical throughput at a link that Phase 00 measured at 5,120 B/s. The one manifest-derivable field v2 does repeat is `sourceSymbolCount`, because it lets a receiver bound its own state before acquiring a manifest and gives a cheap cross-check afterwards.

**The parser never throws.** Every malformed input is a typed failure. That is what makes it fuzzable, and it is asserted rather than asserted-about.

**One codec, not two.** v1 forced the PWA to carry a second implementation of the wire format in `mobile-web/src/protocol.ts`, because `src/core/protocol.ts` is written in terms of Node `Buffer`. v2 is written against `Uint8Array`, `DataView`, `TextEncoder`/`TextDecoder`, and `BigInt` only, so both surfaces import the same module.

**Frame sizes.** Manifest `84 + filename + mime` bytes — 126 bytes for a 5 GiB transfer, comfortably inside one QR symbol. Data frame `32 + payload`: 3.1 % overhead at a 1,024-byte symbol, 6.25 % at 512 bytes against v1's 3.9 %. The extra bytes buy a real segment index, a CRC over the whole frame, and file identity in every symbol.

---

## 3. Acceptance gate

| Gate criterion (from the phase plan) | Status | Evidence |
|---|---|---|
| 5+ GB logical file sizes representable in unit tests **without allocating those files** | **MET** | `manifest-5gib.bin` is 126 bytes and parses to `originalSize = 5368709120n`; a 1 TiB vector and a 256 PiB-class segmentation are also exercised. Peak allocation in those tests is the frame itself |
| Round-trip serialization is deterministic | **MET** | Serialize-twice byte-equality for manifests and data frames; `npm run vectors:v2:generate` verified byte-identical across regeneration; CI enforces it with `git diff --exit-code` |
| Parser rejects malformed lengths safely | **MET** | 12 rejection vectors; explicit tests for a declared length past the buffer, past the protocol limit, and zero-length; ~20,000 fuzz inputs with zero escaped throws |
| v1 and v2 are unambiguous | **MET** | `detectProtocolVersion` classifies real v1 frames as 1 and v2 as 2; the v2 parser reports v1 input as the distinct code `V1_FRAME`, never as corruption |
| No `number` precision loss for 64-bit offsets | **MET** | `2^63 + 12345` round-trips exactly; a segment offset of `2^26 × 3,999,999,999` is computed exactly above `MAX_SAFE_INTEGER`; `toSafeNumber` throws rather than rounding |
| Documented, deterministic, fuzzable, 64-bit safe, unit-tested **independently of QR rendering and the camera** | **MET** | `PROTOCOL-V2.md` is normative with byte tables; no test in this phase touches a canvas, a QR library, or a camera |

Additional requirements from the execution prompt:

| Requirement | Status |
|---|---|
| Explicit v2 magic/version detection | MET — `0x44 0x32 0x02` |
| Binary frames only; no JSON/Base64 optical payload | MET — spec §2; `expected.json` is fixture metadata, never a frame |
| Bounded manifest metadata | MET — filename ≤ 1024 B, MIME ≤ 255 B, both length-checked before decode |
| Session manifest plus compact data/repair frames | MET |
| Session/file identity, segment index, symbol identity, payload length, fast integrity field | MET — all present in every data frame |
| End-to-end expected SHA-256 in the manifest | MET — 32 bytes at offset 44 |
| Feature/profile/compression identifiers | MET — `featureFlags`, `fecProfileId`, `compressionMode`/`compressionParam` |
| Parser validates every length/index before allocation or slice | MET — ordering documented in spec §9.1 and tested |
| Decoder-state design segment-bounded | MET — asserted in test, documented in spec §6 |
| Byte order, maximum legal values, reserved fields, failure behaviour documented | MET — spec §2, §6.2, §7, §9 |
| Do not silently reinterpret v1 frames as v2 | MET — distinct `V1_FRAME` code |

---

## 4. Verification

| Check | Command | Result |
|---|---|---|
| Desktop unit suite | `npm test` | **395 PASS / 28 files** (was 286 / 25 — **+109 tests, +3 files**) |
| PWA unit suite | `npm run mobile-web:test` | **71 PASS / 12 files** (was 63 / 11 — **+8 tests, +1 file**) |
| Desktop typecheck | `npx tsc --noEmit` | PASS |
| PWA typecheck | `npm run mobile-web:typecheck` | PASS |
| Desktop production build | `npm run build` | PASS |
| PWA production build | `npm run mobile-web:build` | PASS |
| Packaged renderer contract | `npm run test:packaged` | PASS |
| AI architecture doctor | `npm run doctor` | PASSED (0 warnings) |
| Adapter drift | `npm run drift-check` | PASSED (zero drift) |
| v2 vector determinism | `npm run vectors:v2:generate` twice, SHA-256 both trees | **Identical** |
| Browser bundling of the shared codec | production Rollup build of a probe entry through the mobile-web Vite config | **20,691-byte ES module, 0 Node imports, 0 `Buffer` references** |

The bundling check is worth naming precisely, because "browser-safe" is easy to claim and easy to get wrong. The codec was bundled by the **production** Rollup path the receiver builds with, not merely transformed by vitest, and the emitted module was inspected for Node imports and `Buffer` references rather than assumed clean. The probe entry was removed afterwards; no shipping PWA code imports v2 yet.

### 4.1 Fuzz coverage

`tests/core/protocol-v2-fuzz.test.ts` drives roughly 20,000 generated inputs across eight properties: 4,000 fully random buffers, 4,000 buffers carrying a forced v2 prefix, 3,000 single-byte mutations of a valid data frame, 3,000 of a valid manifest, every truncation of both, every boundary value of every declared length, a 6,000-input sweep asserting that every failure is a typed `DeqrV2Error` with a known code, and a re-sealed-header sweep asserting that every field of an accepted frame is inside its declared range.

**One finding worth recording.** The first version of the code-coverage sweep passed while silently exercising only one code path. The generator is a power-of-two LCG, whose low bits have a period as short as two, so `next() % 2` alternated in lockstep with the buffer length and the forced-prefix arm never ran — 5,958 of 6,000 inputs were rejected at `BAD_MAGIC` and nothing deeper was reached. It surfaced only because the test asserts *which* rejection codes it reached rather than only that rejections happened. The generator now draws from the high bits, and the assertion stays as the thing that would catch a recurrence.

---

## 5. Stated deviations

**1. Data frames do not carry the logical file offset.** The plan's frame model lists "logical file offset where relevant". v2 derives it instead:

```
symbolStart = segmentSizeBytes × segmentIndex + symbolSizeBytes × symbolId
```

Reason: the offset is fully determined by fields the manifest already carries, and the plan's own design constraint is explicit — "If a field can live in the one-time manifest, do not repeat it in every data frame unless needed for recovery/resynchronization." Eight bytes per symbol against a link Phase 00 measured at 5,120 B/s is not a rounding error. `segmentByteRange` and `symbolByteRange` are the normative derivations and are tested against offsets above `MAX_SAFE_INTEGER`.

**2. `PROTOCOL-V2.md` lives at `.ai-team/engineering/PROTOCOL-V2.md`, not the repository root.** `AGENTS.md` names `.ai-team/engineering/` as the canonical home for engineering specifications, and `.ai-team/` is the project's declared single source of truth. Placing it at the root would have created a second authority.

**Scope taken beyond the letter of the plan, deliberately:** the codec is `Buffer`-free so the Electron sender and the iOS PWA receiver share one implementation. The plan did not ask for this. Phase 00 recorded that v1's duplicated receiver-side protocol is a standing drift risk — two implementations of one wire format where a limit can disagree without anything failing to build — and v2 was the moment to not repeat it. The cost was writing against `Uint8Array`/`DataView` instead of `Buffer`; the guard against regression is a source-text assertion in the PWA test project.

---

## 6. Not established by this phase

- **No optical measurement.** No frame has been rendered as a QR code or read by a camera. `symbolSizeBytes` and `segmentSizeBytes` are protocol fields with documented bounds, not chosen values; Phase 04 picks them from measured verified-payload throughput.
- **No integration.** The sender still emits v1, the receiver still reads v1. Nothing in this phase changes shipping behaviour, which is why the pre-existing suite counts are unchanged apart from the added tests.
- **No repair-symbol generator.** v2 defines how a repair symbol is *identified* (`symbolId ≥ sourceSymbolCount`, used as the generator seed) and reserves `fecProfileId = 0x01` for the v1 soliton math. Producing and consuming segment-scoped repair symbols is Phase 03.
- **No compression path.** `compressionMode = 0x01` (gzip) is defined and validated, and no code compresses anything yet. Phase 08.
- **No adversarial review.** The parser is fuzzed for robustness, not threat-modelled. Phase 10.
- **No C# parity.** The `DEQR.Core` parity suite covers v1 only. If v2 needs a second-language conformance implementation, that is a decision for a later phase; the CI job now regenerates and diffs the v2 vectors, so the fixtures a parity implementation would target are already pinned.

---

## 7. Changed files

| File | Change |
|---|---|
| `.ai-team/engineering/PROTOCOL-V2.md` | new — normative specification |
| `.ai-team/reports/performance/PHASE-01-PROTOCOL-V2-REPORT.md` | new — this report |
| `src/core/protocol-v2.ts` | new — codec |
| `src/core/crc32.ts` | new — CRC-32/ISO-HDLC |
| `src/core/index.ts` | export the two new modules from the core barrel |
| `scripts/protocol/generate-v2-vectors.ts` | new — deterministic vector generator |
| `protocol/test-vectors-v2/` | new — 21 fixtures + `expected.json` |
| `tests/core/protocol-v2.test.ts` | new — 55 tests |
| `tests/core/protocol-v2-vectors.test.ts` | new — 46 tests |
| `tests/core/protocol-v2-fuzz.test.ts` | new — 8 properties |
| `mobile-web/tests/protocol-v2-shared-codec.test.ts` | new — 8 tests |
| `package.json` | add `vectors:v2:generate` |
| `.github/workflows/ios1-core.yml` | regenerate and diff the v2 vectors, same guarantee v1 already has |
| `.ai-team/project-control/CURRENT-STATE.md` | Phase 01 section |
| `.ai-team/project-control/TASK-LOG.md` | new row |

No v1 file was modified. `src/core/protocol.ts`, `src/core/container.ts`, `src/core/fountain-*.ts`, `mobile-web/src/protocol.ts`, and `protocol/test-vectors/` are byte-identical to before this phase.

---

## 8. What Phase 02 inherits

Phase 02 makes the desktop sender streaming and bounded-memory. From this phase it gets:

- A wire format that can describe the file it is about to stream, in a manifest small enough to fit one QR symbol regardless of file size.
- `planSegmentation` / `segmentByteRange` / `symbolByteRange` — the exact `bigint` arithmetic for turning a file-sized read plan into segment and symbol byte ranges, so the sender never needs the whole file resident to know what to send next.
- A validated invariant that decoder — and therefore encoder-window — state is bounded by a segment.

The two open protocol values Phase 02 will need placeholders for, and Phase 04 will fix from measurement, are `segmentSizeBytes` (plan's benchmark range 1/2/4 MiB; field accepts 64 KiB–64 MiB) and `symbolSizeBytes` (field accepts 32–4,096 B; v1 shipped 512).
