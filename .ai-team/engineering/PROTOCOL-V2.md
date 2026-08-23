# DEQR v2 Optical Frame Protocol — Normative Specification

**Status**: SHIPPING — carried end to end by the streaming sender (Phase 02) and the PWA receiver (Phase 05–08), and driven by both shipping UIs since Phase 09.
**Revision**: 2.0 — byte 43 gained meaning in Phase 04 and byte 42 in Phase 08, both in the one direction that leaves every earlier vector byte-identical.
**Reference implementation**: [`src/core/protocol-v2.ts`](../../src/core/protocol-v2.ts), [`src/core/crc32.ts`](../../src/core/crc32.ts)
**Golden vectors**: `protocol/test-vectors-v2/` (regenerate with `npm run vectors:v2:generate`)
**Supersedes for new transfers**: DEQR v1, for every optical transfer. v1 is still *accepted* by the receiver and is still used by desktop loopback; §10 says why, and why Phase 12 refused to retire it.
**Certified against a camera**: nothing. The wire format is certified by vectors, fuzzing and harnesses; the optical link it rides on has no physical-device rows behind it. See [PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md](../reports/performance/PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md).

---

## 1. Why v2 exists

Phase 00 established, by runtime probe rather than source reading, that DEQR v1's ceiling is a field width. The v1 frame header carries the source-block count `K` in 16 bits against a sender block size fixed at 512 bytes, so an entire v1 transfer cannot exceed `512 × 65,535 = 33,553,920` bytes. The header also has a 16-bit `segmentNumber` that the encoder always writes as `0` and the receiver rejects when non-zero, so the ceiling cannot be lifted from inside v1. Full evidence: [`PHASE-00-AUDIT.md`](../reports/performance/PHASE-00-AUDIT.md).

v2 does not stretch that model. It replaces it:

| v1 | v2 |
|---|---|
| Every frame repeats `blockCount`, `blockSize`, `totalPayloadLength` | A one-time **session manifest** carries the expensive metadata |
| One implicit segment, `segmentNumber` pinned to 0 | **Real segments**, each independently decodable and checkpointable |
| `totalPayloadLength` is `uint32` (4 GiB−1) | Sizes are **`uint64`**, held as `bigint` and never rounded through `number` |
| Decoder state scales with the whole file | Decoder state scales with **one segment** |
| 1 XOR byte over 19 header bytes; payload unchecked | **CRC-32 over the whole frame**, header and payload |
| No file identity in the frame | `sessionId` + `fileId` in **every** frame |
| Filename and digest in a separate container inside the payload stream | Filename and digest in the manifest, so a receiver knows what it is receiving from the first frame it reads |

**What has not changed**: SHA-256 over the reconstructed **original** file remains the sole authority on file identity. The CRC exists to reject damaged optical reads quickly; it proves nothing about the file.

---

## 2. Conventions

- **Byte order is big-endian (network order) for every multi-byte field.** No exceptions, no per-field variation.
- All integers are unsigned.
- Offsets in the tables below are byte offsets from the start of the frame.
- "MUST" and "MUST NOT" are normative. A receiver that accepts a frame this document says it must reject is non-conforming.
- `uint64` fields are represented in JavaScript/TypeScript as `bigint`. Converting one to `number` is only permitted through a checked conversion that refuses above `Number.MAX_SAFE_INTEGER` (`toSafeNumber`); a silent `Number()` on a size or offset is a defect.
- Every frame is a complete, independently parseable unit. A QR symbol carries exactly one frame.

---

## 3. Frame identification

Every v2 frame opens with the same four bytes:

| Offset | Size | Field | Value |
|---|---|---|---|
| 0 | 1 | `magic0` | `0x44` (`'D'`) |
| 1 | 1 | `magic1` | `0x32` (`'2'`) |
| 2 | 1 | `version` | `0x02` |
| 3 | 1 | `frameType` | `0x01` MANIFEST, `0x02` SOURCE, `0x03` REPAIR |

### 3.1 v1 and v2 are unambiguous

A v1 frame's first byte is its protocol version, `0x01`. A v2 frame's first byte is `0x44`. They cannot be confused, and a reader MUST NOT try.

`detectProtocolVersion(bytes)` returns:

- `2` when bytes 0–2 are `0x44 0x32 0x02`;
- `1` when byte 0 is `0x01` and the buffer is at least the 20-byte v1 header;
- `null` otherwise, including for v2 magic carrying a version this build does not implement.

The v2 parser reports a v1 frame as the distinct error `V1_FRAME` rather than as corruption. This matters in practice: a version mismatch surfaced to a user as "data corrupted" sends them looking for a camera or lighting problem that does not exist.

### 3.2 Unknown versions

A frame carrying v2 magic with any `version` other than `0x02` MUST be rejected with `UNSUPPORTED_VERSION`. It MUST NOT be parsed speculatively. The UX obligation is to say that the sender is running a newer DEQR than the receiver, not to fail obscurely.

---

## 4. Session manifest frame (`frameType = 0x01`)

The manifest is the only frame carrying filename, digest, and segmentation. It is transmitted **repeatedly** throughout a transfer, not once: a receiver can begin scanning at any moment and must be able to acquire the session without having seen its start.

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 4 | prefix | — | magic, version, `frameType = 0x01` |
| 4 | 2 | `featureFlags` | u16 | Bits 0–7 advisory, bits 8–15 critical. See §7 |
| 6 | 4 | `sessionId` | u32 | Identifies one transfer session |
| 10 | 4 | `fileId` | u32 | Identifies the file within the session |
| 14 | 8 | `originalSize` | u64 | Size of the original file, **before** compression |
| 22 | 8 | `transportSize` | u64 | Bytes actually placed into segments |
| 30 | 4 | `segmentSizeBytes` | u32 | Transport bytes per segment |
| 34 | 2 | `symbolSizeBytes` | u16 | Payload bytes per source symbol |
| 36 | 4 | `segmentCount` | u32 | MUST equal `ceil(transportSize / segmentSizeBytes)` |
| 40 | 1 | `fecProfileId` | u8 | `0x01` = LT systematic-first, robust soliton |
| 41 | 1 | `compressionMode` | u8 | `0x00` NONE, `0x01` GZIP |
| 42 | 1 | `compressionParam` | u8 | GZIP: log2 of the compression window, 16..26. MUST be `0` when mode is NONE. See 4.5 |
| 43 | 1 | `transportProfileId` | u8 | Named optical transport profile. **Advisory** — see 4.4 |
| 44 | 32 | `sha256` | bytes | Digest of the **original** file |
| 76 | 2 | `filenameLength` | u16 | 1..1024 |
| 78 | *n* | `filename` | UTF-8 | Sanitized; see §4.2 |
| 78+*n* | 2 | `mimeLength` | u16 | 0..255 |
| 80+*n* | *m* | `mimeType` | UTF-8 | **Advisory only**; see §4.3 |
| 80+*n*+*m* | 4 | `crc32` | u32 | Over bytes `[0, 80+n+m)` |

Total size: `84 + n + m` bytes. A typical manifest is 110–130 bytes — well inside one QR symbol, including for a multi-terabyte transfer.

### 4.1 Field constraints a receiver MUST enforce

| Constraint | Rejection code |
|---|---|
| `originalSize ≥ 1` and `transportSize ≥ 1` | `FIELD_OUT_OF_RANGE` |
| `symbolSizeBytes` in 32..4096 | `FIELD_OUT_OF_RANGE` |
| `segmentSizeBytes` in 65536..67108864 | `FIELD_OUT_OF_RANGE` |
| `segmentSizeBytes % symbolSizeBytes == 0` | `FIELD_OUT_OF_RANGE` |
| `segmentCount == ceil(transportSize / segmentSizeBytes)` | `INCONSISTENT_MANIFEST` |
| `compressionMode` is known | `UNSUPPORTED_COMPRESSION` |
| `compressionMode == NONE` ⇒ `transportSize == originalSize` and `compressionParam == 0` | `INCONSISTENT_MANIFEST` |
| `compressionMode == GZIP` ⇒ `compressionParam` in 16..26 | `FIELD_OUT_OF_RANGE` |
| `compressionMode == GZIP` ⇒ `transportSize ≤ originalSize` | `INCONSISTENT_MANIFEST` |
| `compressionMode == GZIP` ⇒ `transportSize ≥ windowCount × 22` | `INCONSISTENT_MANIFEST` |
| `fecProfileId` is known | `UNSUPPORTED_FEC_PROFILE` |
| `reserved == 0` | `FIELD_OUT_OF_RANGE` |
| `filenameLength` in 1..1024, and the field fits inside the frame | `FIELD_OUT_OF_RANGE` / `FRAME_TOO_SHORT` |
| `mimeLength ≤ 255`, and the field fits inside the frame | `FIELD_OUT_OF_RANGE` / `FRAME_TOO_SHORT` |
| Frame length is exactly `84 + n + m` | `FRAME_TOO_SHORT` / `TRAILING_BYTES` |
| Filename and MIME decode as valid UTF-8 | `INVALID_UTF8` |
| CRC-32 matches | `CRC_MISMATCH` |

`segmentCount` is **re-derived and compared**, never trusted. Every index downstream is bounded by it, so a transmitted value that disagrees with the sizes is the single most valuable thing to catch at the manifest.

**Segmentation is validated before the filename is decoded**, so a manifest that is structurally impossible is rejected without any variable-length work being done on its behalf.

### 4.2 Filename

The filename is sanitized on the way out **and again on the way in** — path separators, traversal sequences, control characters, and Windows-reserved characters removed, length capped. A receiver MUST NOT treat the transmitted name as safe because a sender promised it was. The sanitizer is shared: [`src/core/filename-sanitizer.ts`](../../src/core/filename-sanitizer.ts).

Because sanitization is applied on both sides, serialize→parse is idempotent and byte-deterministic for any already-sanitized name.

### 4.3 MIME type

Advisory metadata, present so a receiver can offer a sensible share sheet. It MUST NOT influence parsing, storage, verification, or any security decision, and it MUST NOT be used to decide whether a file is safe. Extension- and MIME-based dispatch is precisely what Phase 00 found had no place in transport.

---

### 4.4 Transport profile id

Byte 43 was `reserved` and MUST-be-zero through revision 2.0. From Phase 04 it carries `transportProfileId`, and the rule changed in one direction only: a receiver MUST accept any value and MUST NOT reject an unrecognised one.

That is safe because the field is **advisory in both directions**. Nothing about decoding reads it — `symbolSizeBytes`, `segmentSizeBytes` and `fecProfileId` already carry every parameter a receiver needs, and this only names which measured combination of them the sender chose. It exists so a receiver can report the profile to a user, and so a benchmark run can be attributed to one.

| Value | Profile | QR version | ECC | Payload bytes | Camera px per module |
|---|---|---|---|---|---|
| `0x00` | Unspecified | — | — | — | — |
| `0x01` | Reliable | 10 | L | 239 | 2.5 |
| `0x02` | Balanced *(default)* | 18 | L | 686 | 4 |
| `0x03` | Turbo | 24 | L | 1139 | 5 |
| `0x04` | Experimental | 32 | L | 1920 | 5 |

`0x00` is what every manifest written before Phase 04 says, and a sender that assembles a configuration by hand rather than from a profile still says it. **Every golden vector generated before this field existed is byte-identical after it**, because they all declare zero and the byte was already covered by the frame CRC.

Rejecting an unknown value would have made every future profile a breaking change for this build, which is exactly the forward-compatibility problem the advisory/critical flag split in section 7 exists to avoid. A field that cannot affect interpretation does not need the protection a field that can does.

Definitive values live in [`src/core/transport-profiles.ts`](../../src/core/transport-profiles.ts), together with the measured decode-success surface they were read off.

---

### 4.5 The GZIP transport container (`compressionMode = 0x01`)

Added by Phase 08. Byte 42 was "profile-defined" and never non-zero in any shipped build; it now carries **log2 of the compression window**, and the transport stream gains a defined structure.

When `compressionMode` is `GZIP`, the bytes the segments carry are **not** one gzip stream over the file. They are a sequence of *window records*:

```text
transport stream := record[0] record[1] … record[n-1]
record[j]        := u32BE compressedLength || gzip member (RFC 1952)
window[j]        := original bytes [ j·W , min((j+1)·W, originalSize) )
W                := 2 ^ compressionParam,  16 ≤ compressionParam ≤ 26
n                := ceil(originalSize / W)
transportSize    := Σ ( 4 + compressedLength[j] )
```

`transportSize` and `segmentCount` keep their existing meanings exactly: segmentation is planned over the container, not over the file, and every rule in §6 is unchanged. The receiver stores container bytes at container offsets exactly as it stores file bytes today.

**Three properties, each load-bearing:**

1. **Every member is delimited before it is decoded.** The receiver reads a length, hands exactly that many bytes to one decompressor, and requires exactly `min(W, originalSize − j·W)` bytes back. A decompression bomb has nowhere to expand into: the bound is a manifest-derived constant, never a number taken from the stream.
2. **The sender can seek.** Windows share no deflate history, so resuming at segment 4,000 recompresses one window rather than everything before it.
3. **No dependence on multi-member gzip.** Concatenated members are legal and widely supported, but "widely" is not a contract, and a receiver that guessed wrong about a browser's `DecompressionStream` would find out on a user's phone.

#### Receiver obligations

| Check | Rejection |
|---|---|
| A declared `compressedLength` at or below zlib's expansion ceiling for `W`, **checked before allocating** | `COMPRESSED_CONTAINER_INVALID` |
| A declared `compressedLength` that fits inside the remaining container | `COMPRESSED_CONTAINER_INVALID` |
| Exactly `n` records consuming exactly `transportSize` bytes — no short container, no trailing bytes | `COMPRESSED_CONTAINER_INVALID` |
| Each member decodes | `DECOMPRESSION_FAILED` |
| Each member produces exactly its window's declared length, and total output equals `originalSize` | `DECOMPRESSED_SIZE_MISMATCH` |

A receiver with no gzip decompressor MUST refuse the manifest with `UNSUPPORTED_COMPRESSION` rather than begin a transfer it cannot finish. There is no back channel; the refusal has to happen where a user can still act on it.

#### What compression does not change

`originalSize` and `sha256` describe the **original file**, in both modes, always. Decompressing successfully proves the container was well formed; gzip's per-member CRC-32 is a transmission check exactly like the frame CRC. SHA-256 over the reconstructed original bytes remains the sole authority on identity, and it is computed over what the device actually holds.

#### One new ceiling

`n` is bounded by the u32 segment-count limit, so in GZIP mode `originalSize ≤ 2^32 · W`: 4 PiB at the 1 MiB default window, 256 PiB at the 64 MiB maximum. Uncompressed transfers are unaffected. Nothing DEQR will certify comes near either bound, but the limit exists and is asserted in `tests/core/compression-window.test.ts`.

**Whether to compress is not a protocol question.** It is decided from sampled bytes by [`src/core/compression-policy.ts`](../../src/core/compression-policy.ts), whose decision function has no parameter for a filename, a MIME type, or a path. §4.3's rule about extension-based dispatch is enforced there by the shape of the function rather than by review.

---

## 5. Data frames (`frameType = 0x02` SOURCE, `0x03` REPAIR)

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 4 | prefix | — | magic, version, `frameType` |
| 4 | 4 | `sessionId` | u32 | MUST match the manifest |
| 8 | 4 | `fileId` | u32 | MUST match the manifest |
| 12 | 4 | `segmentIndex` | u32 | `0 ≤ segmentIndex < segmentCount` |
| 16 | 4 | `symbolId` | u32 | See §5.1 |
| 20 | 4 | `sourceSymbolCount` | u32 | Source symbols in **this** segment |
| 24 | 2 | `payloadLength` | u16 | 1..4096 |
| 26 | 2 | `frameFlags` | u16 | Bits 0–7 advisory, bits 8–15 critical |
| 28 | *p* | `payload` | bytes | `payloadLength` bytes |
| 28+*p* | 4 | `crc32` | u32 | Over bytes `[0, 28+p)` |

Total size: `32 + p` bytes. At a 1,024-byte symbol that is 1,056 bytes on the wire — 3.1 % overhead. At the v1-comparable 512-byte symbol it is 544 bytes, 6.25 %, against v1's 3.9 %; the extra bytes buy a real segment index, a real CRC, and file identity in every frame.

### 5.1 Symbol identity encodes the symbol's role

Systematic-first numbering, carried forward from v1 because it works:

- **SOURCE**: `symbolId < sourceSymbolCount`. The symbol is source-block `symbolId` of segment `segmentIndex`, verbatim.
- **REPAIR**: `symbolId ≥ sourceSymbolCount`. The symbol is a generated repair symbol, and `symbolId` is its generator seed.

A receiver MUST reject a SOURCE frame whose `symbolId` is not below its own `sourceSymbolCount`, and a REPAIR frame whose `symbolId` is below it. Both are `SYMBOL_OUT_OF_RANGE`. This makes a symbol's role readable from its identity alone, with no separate flag to disagree with it.

### 5.2 Why `sourceSymbolCount` is repeated per frame

It is the one piece of manifest-derivable data v2 repeats, for two reasons. A receiver that has not yet acquired a manifest can still bound its own state from a data frame, and a receiver that has one gets a cheap cross-check that catches a session mix-up before any symbol enters the decoder. Four bytes on a 1,056-byte frame is 0.4 %.

### 5.3 What data frames deliberately do NOT carry

**The logical file offset.** It is fully derivable, and eight bytes in every symbol is real optical throughput:

```
segmentStart = segmentSizeBytes × segmentIndex
symbolStart  = segmentStart + symbolSizeBytes × symbolId
symbolEnd    = min(symbolStart + symbolSizeBytes, segmentEnd)
```

All three are computed in `bigint`. `segmentByteRange` and `symbolByteRange` are the normative implementations.

**Filename, digest, sizes, compression mode, FEC profile.** All manifest-only. A receiver cannot verify or store anything without a manifest, so repeating this per symbol buys nothing.

### 5.4 Padding

Every symbol in a segment is exactly `symbolSizeBytes` long, including the last symbol of the last segment, which is **zero-padded** past the real data. XOR-based repair requires uniform symbol length within a segment; shortening the final symbol would break recovery rather than save bytes. The real length is recovered from `transportSize`, which the manifest carries.

`validateDataFrameAgainstManifest` enforces `payload.length == manifest.symbolSizeBytes`.

---

## 6. Segmentation

```
segmentCount           = ceil(transportSize / segmentSizeBytes)
symbolsPerFullSegment  = segmentSizeBytes / symbolSizeBytes          (exact; divisibility is required)
lastSegmentBytes       = transportSize − segmentSizeBytes × (segmentCount − 1)
symbolsInLastSegment   = ceil(lastSegmentBytes / symbolSizeBytes)
```

Requiring `segmentSizeBytes` to be a whole number of symbols keeps every full segment's symbol count identical and its byte ranges exact. It removes a class of off-by-one that v1's padding rules invited.

**Each segment is independently decodable.** Decoder state is proportional to `symbolsPerFullSegment`, never to the file: a 5 MiB transfer and a 5 TiB transfer at the same segment size have byte-identical per-segment working sets, and differ only in how many segments there are. This is the property Phase 03 (segmented FEC), Phase 06 (incremental storage), and Phase 07 (checkpoint and resume) all build on, and it is asserted directly in `tests/core/protocol-v2.test.ts`.

### 6.1 Choosing a segment size

**Not yet chosen.** The plan's benchmark range is 1 MiB / 2 MiB / 4 MiB and the field accepts 64 KiB … 64 MiB. Phase 04 selects the operating value from measured verified-payload throughput. Nothing in this specification depends on which value is picked; it is a manifest field, not a constant.

### 6.2 Hard limits

| Quantity | Limit | Set by |
|---|---|---|
| `symbolSizeBytes` | 32 … 4,096 | QR byte-mode capacity |
| `segmentSizeBytes` | 65,536 … 67,108,864 | Receiver working-set bound |
| `segmentCount` | ≤ 4,294,967,295 | u32 field |
| Source symbols per segment | ≤ 4,294,967,295 | u32 field |
| `originalSize` / `transportSize` | ≤ 2⁶⁴−1 | u64 fields |

The practical ceiling is `segmentSizeBytes × segmentCount`: at the maximum segment size that is 2⁵⁸ bytes ≈ **256 PiB**. A transfer needing more segments than the u32 field can index is rejected at planning time rather than silently truncated.

**No `Number` conversion is performed on any of these.** `planSegmentation` works in `bigint` end to end; `toSafeNumber` throws `PRECISION_LOSS` rather than rounding.

---

## 7. Feature and flag negotiation

`featureFlags` (manifest) and `frameFlags` (data frames) are both u16, split into halves:

| Bits | Half | Unknown bit behaviour |
|---|---|---|
| 0–7 | Advisory (`0x00FF`) | **Ignored.** The frame is processed normally |
| 8–15 | Critical (`0xFF00`) | **Rejected** with `UNSUPPORTED_CRITICAL_FEATURE` |

No flag bits are defined in revision 2.0; conforming senders write zero in both fields. The split is what makes forward compatibility real rather than aspirational: a later revision can add an optional behaviour in the advisory half that this build ignores safely, and anything that changes how bytes must be interpreted goes in the critical half, where this build refuses rather than guesses.

Manifest offset 43 was held in reserve for a field rather than a flag, on the reasoning that a field cannot be forward-compatible the way a flag can. Phase 04 spent it on `transportProfileId` and found the exception to that reasoning: a field that **cannot affect interpretation** is forward-compatible after all, so an unknown value there is reported rather than rejected. See 4.4.

### 7.1 Profile identifiers

| Identifier | Value | Meaning |
|---|---|---|
| `fecProfileId` | `0x01` | LT systematic-first with the robust soliton distribution DEQR v1 ships |
| `compressionMode` | `0x00` | None. `transportSize == originalSize` |
| `compressionMode` | `0x01` | gzip over the transport stream. `compressionParam` carries the level |

Both are extension points. Phase 08 may add a compression mode. Adding either is a new identifier value, never a change to an existing one's meaning. **Phase 03 evaluated two alternative degree rules and adopted neither**; see 7.3.

### 7.2 FEC profile `0x01`, normatively

Profile `0x01` is systematic-first LT over a single segment. Everything below is derived from `symbolId` and `sourceSymbolCount`, both of which travel in every data frame, so a receiver reproduces the sender's choices with no extra metadata and no shared state.

Let `K = sourceSymbolCount` for the segment.

**Source symbols.** For `symbolId < K`, the payload is source block `symbolId` of the segment, zero-padded to `symbolSizeBytes` (§5.4). No transformation is applied.

**Repair symbols.** For `symbolId ≥ K`, the payload is the XOR of a set of source blocks selected as follows:

1. Seed a Mulberry32 PRNG with `symbolId`. A seed of 0 is replaced by `0xDEADBEEF`; `symbolId ≥ K ≥ 1` so this never arises for a repair symbol, and it is stated because the generator is shared with v1.
2. Sample a degree `d` from the robust soliton distribution over `K` with `c = 0.1` and `δ = 0.05`, then clamp: `d = min(d, K)`.
3. Draw distinct indices in `[0, K)` from the same PRNG by rejection sampling until `d` distinct indices are held. Termination is guaranteed because `d ≤ K`.
4. The payload is the XOR of those source blocks, over the full `symbolSizeBytes` including padding.

The distribution is rebuilt per segment, sized to that segment's `K`. The final segment usually has a different `K` from the others and therefore a different distribution; a receiver that reuses one distribution across segments will disagree with the sender on the last one.

**Receiver obligations.**

- A source symbol MUST be placed directly at its block offset. It MUST NOT be routed through the equation graph. This is what makes a loss-free segment cost zero XOR operations, and it is observable: `stats().xorBytes` is exactly 0.
- A repair symbol MUST be eliminated against already-known blocks before it is stored, and MUST be discarded rather than stored when nothing unknown survives.
- Derived neighbour indices MUST be validated against `[0, K)` and the degree against `[1, K]` before use, even though both are derived rather than transmitted. A profile implementation that returns an out-of-range index is a defect, and a decoder that trusts it is a second one.
- Work triggered by one frame MUST be bounded. A conforming receiver caps the number of stored equations, the number of neighbour references it holds, and the number of repair identities it tracks for duplicate suppression, and it MUST test the cheap refusals — already-seen, saturated — **before** deriving a neighbour set, so that a saturated decoder answers a hostile stream in constant time. `src/core/segment-decoder.ts` documents the caps it uses and the arithmetic behind them.
- Duplicate suppression is an optimisation, not a correctness requirement: an untracked duplicate eliminates to degree 0 and is discarded as redundant.

**Repair budget is not part of the profile.** How many repair symbols a sender emits per segment is a transport setting, not a wire semantic. A receiver MUST NOT infer it and MUST accept any number, including none.

### 7.3 Measured recovery cost — informative

Phase 03 measured what a segment actually needs, rather than assuming. Figures are the 99th percentile repair-to-source ratio at which a segment closed, over the default profile (1 MiB segments of 512-byte symbols, so `K = 2048`), under independent per-frame loss. Burst loss of the same mean measured the same to within noise, because neighbour selection is pseudorandom over the segment and index adjacency means nothing to it.

| Frame loss | Repair ratio needed (p99) |
|---|---|
| 0% | 0.00 |
| 1% | 0.46 |
| 5% | 0.71 |
| 10% | 0.71 |
| 20% | 0.72 |
| 30% | 0.94 |

The requirement is nearly flat between 1% and 20%. What costs is not the loss but the tail: closing the last few symbols of a segment needs a repair symbol touching exactly one of them, which is rare however few remain. Smaller `K` is worse — at `K = 512` the 30% figure is 1.55 — which makes `symbolSizeBytes` a recovery-efficiency decision as well as a QR-capacity one, and therefore Phase 04's to make with both in view.

Two alternative degree rules were measured through the same encoder and decoder and **rejected**. A geometric degree ladder over 1, 2, 4 … K is far cheaper below 10% loss (p99 0.08 against 0.46 at 1%) but fails outright at 20% and 30% under bounded decoder memory, and still needs p99 1.54 against the soliton's 0.94 at 30% when the caps are removed. A fixed degree of 3 is worse everywhere and fails most trials above 5%. The robust soliton was the only rule that closed every trial at every measured rate under the shipping caps, which is why profile `0x01` is unchanged.

---

## 8. Integrity

Three layers, with strictly separate jobs:

1. **CRC-32/ISO-HDLC over the whole frame**, header and payload, at the end of every frame. Polynomial `0xEDB88320` reflected, init `0xFFFFFFFF`, final XOR `0xFFFFFFFF` — the CRC gzip, zip, and PNG all use, so a disagreement between the sender and a browser receiver is a defect in [`src/core/crc32.ts`](../../src/core/crc32.ts) rather than an argument about which CRC was intended. Its job is cheap rejection of optical damage before a symbol reaches the decoder. It is **not** a security primitive: an attacker who can choose frame bytes can choose a matching CRC.

   This is a direct response to a v1 finding: v1 checksummed 19 header bytes with a single XOR byte — a 1-in-256 chance of accepting a corrupted header — and did not checksum the payload at all.

2. **Structural validation.** Session, file, segment, and symbol identity are checked against the manifest before a symbol is admitted (`validateDataFrameAgainstManifest`). A well-formed frame from a *different* transfer is a different failure from a damaged frame, and reporting them the same way is how a receiver ends up silently mixing two sessions.

3. **SHA-256 over the reconstructed original file**, carried in the manifest. This is the sole authority on file identity. A transfer is verified when and only when this matches. Neither the CRC nor the structural checks may substitute for it, and passing them means only that a symbol was worth admitting.

---

## 9. Error model

The parser **never throws**. Every malformed input becomes `{ ok: false, error: DeqrV2Error }` with one of the codes below. This is what makes the parser fuzzable, and it is asserted directly: `tests/core/protocol-v2-fuzz.test.ts` drives random buffers, prefix-forced buffers, every single-byte mutation of a valid frame, and every truncation, and requires that nothing escapes as a throw.

The **serializer does throw**, because handing it an invalid model is a defect on our side, not untrusted input.

| Code | Meaning |
|---|---|
| `FRAME_TOO_SHORT` | Buffer smaller than the fixed prefix, or than a declared length |
| `TRAILING_BYTES` | Buffer larger than the frame declares |
| `BAD_MAGIC` | Not a DEQR v2 frame |
| `V1_FRAME` | A DEQR v1 frame; use the v1 reader |
| `UNSUPPORTED_VERSION` | v2 magic, unknown version |
| `UNKNOWN_FRAME_TYPE` | Frame type not defined in this revision |
| `FRAME_TYPE_MISMATCH` | A typed parser was given a different frame type |
| `CRC_MISMATCH` | Frame CRC does not match its contents |
| `FIELD_OUT_OF_RANGE` | A field is outside its legal range |
| `INCONSISTENT_MANIFEST` | Fields are individually legal but contradict one another |
| `UNSUPPORTED_CRITICAL_FEATURE` | An unknown critical flag bit is set |
| `UNSUPPORTED_COMPRESSION` | Unknown `compressionMode` |
| `UNSUPPORTED_FEC_PROFILE` | Unknown `fecProfileId` |
| `INVALID_UTF8` | Filename or MIME is not valid UTF-8 |
| `INVALID_FILENAME` | Filename is empty after sanitization |
| `SESSION_MISMATCH` | Frame belongs to a different session or file |
| `SEGMENT_OUT_OF_RANGE` | `segmentIndex` outside the manifest's range |
| `SYMBOL_OUT_OF_RANGE` | `symbolId` contradicts the frame's own type |
| `PRECISION_LOSS` | A 64-bit value cannot become a `number` without loss |

### 9.1 Allocation discipline

**Nothing is allocated or sliced from a transmitted length until that length has been checked against both its legal range and the buffer actually received.** Ordering in the manifest parser:

1. Prefix and frame type.
2. Minimum length for the fixed header.
3. `filenameLength` range check.
4. Buffer length check for the filename **and** the mime-length field that follows it.
5. `mimeLength` range check.
6. Exact total-length check.
7. CRC.
8. Field semantics, then segmentation consistency.
9. Only then, UTF-8 decoding of the variable-length fields.

The data-frame parser follows the same shape. A declared `payloadLength` of `0xFFFF` is refused at step 3 — before any buffer of that size could exist.

---

## 10. Compatibility and migration

- **v1 is untouched.** `src/core/protocol.ts`, `src/core/container.ts`, the v1 vectors in `protocol/test-vectors/`, and the C# parity suite all continue to work byte-for-byte. v2 is an addition.
- **v2 is the shipping optical wire format.** Since Phase 09 the desktop renderer drives `streamTransfer` and emits v2 for every optical transfer; since Phase 05 the PWA capture pipeline accepts it. The v1 `transfer:*` IPC channels are still registered and are no longer reached from any UI surface, and the only v1 encoder still exercised is **loopback**, which re-decodes a file already on the local disk and never reaches a camera. *(This line previously read "v1 remains the shipping wire format … nothing emits or accepts v2 yet", which was written in Phase 01 and stopped being true at Phase 02.)*
- **A v2 receiver reads v1 by dispatching, not by guessing.** `detectProtocolVersion` classifies the frame and the appropriate reader handles it. The v2 parser refuses v1 input explicitly.
- **A v1-only receiver meeting a v2 frame** fails its header checksum and discards it, which is the correct outcome. It cannot mis-decode one: v2's first byte is `0x44`, and the v1 reader requires `0x01`.
- **The v1 container format does not appear in v2.** v1 wrapped the file in a `DEQR` container and fountain-coded the whole container. v2 carries that metadata in the manifest, so the transport stream is the file's bytes (optionally compressed) and nothing else. There is no container to parse after reconstruction.
- **Retirement of v1 was considered in Phase 12 and refused.** The condition written here was "not before Phase 12 has a certified v2 path", and Phase 12 does not have one: the physical certification matrix is unexecuted, so the receiver's v2 path is certified against harnesses and not against a camera. Two further reasons stand on their own. A phone updates independently of the desktop it scans, so a receiver that dropped v1 would stop reading senders still on the previous release — the installed base pays for the cleanup. And the receiver's v1 reader is what makes an unrecognised frame a *counted reject* rather than a silent one; removing it would not remove the frames. **v1 stays until a release exists whose v2 path has physical-device rows behind it.**

---

## 11. Reference implementation and conformance

| Deliverable | Location |
|---|---|
| Types, serializer, parser, segmentation | [`src/core/protocol-v2.ts`](../../src/core/protocol-v2.ts) |
| CRC-32 | [`src/core/crc32.ts`](../../src/core/crc32.ts) |
| Golden vectors + `expected.json` | `protocol/test-vectors-v2/` |
| Vector generator | [`scripts/protocol/generate-v2-vectors.ts`](../../scripts/protocol/generate-v2-vectors.ts) |
| Round-trip, bounds, 64-bit, segmentation tests | `tests/core/protocol-v2.test.ts` |
| Golden vector conformance | `tests/core/protocol-v2-vectors.test.ts` |
| Fuzz / property tests | `tests/core/protocol-v2-fuzz.test.ts` |
| Shared-codec (browser-safety) tests | `mobile-web/tests/protocol-v2-shared-codec.test.ts` |

### 11.1 One codec, not two

v1 forced the receiver to carry a **second implementation** of the wire format in `mobile-web/src/protocol.ts`, because `src/core/protocol.ts` is written in terms of Node `Buffer`. Two implementations of one wire format drift, and a receiver-side limit can disagree with a sender-side one without anything failing to build.

v2 is written against `Uint8Array`, `DataView`, `TextEncoder`/`TextDecoder`, and `BigInt` only. The Electron sender and the iOS PWA receiver import **the same module**. `mobile-web/tests/protocol-v2-shared-codec.test.ts` runs it through the PWA's own Vite pipeline and asserts, from the source text, that neither v2 module imports a Node built-in or references `Buffer`.

### 11.2 Vector reproducibility

`npm run vectors:v2:generate` is deterministic: identical bytes on every run and every machine. CI regenerates and runs `git diff --exit-code -- protocol/test-vectors-v2`, the same guarantee already applied to the v1 vectors.

---

## 12. Open items for later phases

| Item | Phase |
|---|---|
| ~~Choose `segmentSizeBytes` and `symbolSizeBytes` from measured throughput~~ | **04 — done, see 4.4** |
| Manifest retransmission cadence — how often, and interleaved how | 09 — deferred; still one manifest every 64 frames |
| ~~Repair-symbol generation from `symbolId` as seed, segment-scoped~~ | **03 — done, §7.2** |
| ~~Choose the repair budget per transport profile from measured link loss~~ | **04 — done; each profile declares one, sized from its measured decode loss** |
| Carry partial *symbol* recovery across display passes | still open — Phase 07 carries whole committed segments across a restart, but a segment interrupted mid-recovery is still restarted; persisting its equations would mean persisting a FEC graph, which the program rules forbid |
| ~~Per-segment digests for checkpointing~~ | **07 — decided against.** A per-segment digest would need the *sender* to compute and transmit one, which is a manifest or frame-type change, and it would only detect storage corruption after a write that the final SHA-256 already covers. Phase 07's checkpoint instead records which segments were committed and re-verifies the whole reconstruction, resumed or not. |
| ~~Resume an interrupted transfer without restarting at segment zero~~ | **07 — done.** Receiver adopts its own checkpoint automatically; sender restarts from a 40-character resume token the user carries. See `src/core/resume-token.ts`. |
| ~~Compression mode `0x01` end to end~~ | **08 — done, see 4.5.** `compressionParam` now carries the window exponent, the transport stream is a length-prefixed sequence of independently gzipped windows, and the sender decides from sampled entropy through a function that cannot see a filename. The golden vector `manifest-compressed.bin` moved: it declared an arbitrary `compressionParam` of 6 while the byte was opaque and now declares 20. |
| A second compression mode (zstd/brotli) if a benchmark ever justifies a new dependency | not scheduled — Phase 08 found gzip via built-in `zlib`/`DecompressionStream` sufficient and took no new dependency |
| ~~Wire v2 into the streaming desktop sender~~ | **02 — done**; the renderer was moved onto it in **09** |
| ~~Wire v2 into the PWA capture/decode pipeline~~ | **05 — done** |
| ~~Threat-model the v2 parser against a hostile display~~ | **10 — done.** The parser, the FEC caps and the GZIP container needed no change; every defect found was at a joint between components, and all receiver maxima moved into `src/core/receiver-policy.ts`. |
| ~~Surface the compression decision and the two sizes in the shipping UI~~ | **09 — done** |
| ~~Certify a profile against a physical iPhone camera~~ | **11 — NOT done, and recorded as such.** The pipeline is certified to 1 GiB; the optical link is not certified at all. `PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md` is the instruction set and every row is PENDING. |
| Retire v1 | **12 — refused, see §10.** Not before a release whose v2 path has physical-device rows behind it. |
| Stop paying the repair budget on a clean link | not scheduled — worth 1.78× and measured in Phase 11 §12 F1, but it needs a back channel or interleaving, which is a protocol change |
