# Protocol Baseline — High-Throughput Program Phase 00

**Date:** 2026-08-29
**Commit:** `c85719a`
**Reference implementations:** `src/core/protocol.ts` (v1, frozen), `src/core/protocol-v2.ts` (v2, shipping)
**Spec:** `.ai-team/engineering/PROTOCOL-V2.md` (normative), `.ai-team/engineering/ARCHITECTURE.md`
**Golden vectors:** `protocol/test-vectors/` (v1) + `protocol/test-vectors-v2/` (v2) — regenerate `npm run vectors:generate` / `npm run vectors:v2:generate`

This is the frozen contract every High-Throughput phase must preserve or explicitly version.

---

## 1. Two wire contracts

| Property | v1 (frozen) | v2 (shipping since Phase 02) |
|---|---|---|
| File | `src/core/protocol.ts` | `src/core/protocol-v2.ts` |
| Status | Accepted by receiver, used by loopback/desktop camera — **not retired** (`PHASE-12 report` §v1 retirement refused, certified v2 path absent) | End-to-end since `streamTransfer` + `ReceivePipeline` (`PHASE-09`) |
| Transfer unit | One unsegmented fountain container (≤33,553,920 B) | Segmented, compressed-aware manifest + per-segment systematic/repair symbols |
| Identity | No `sessionId`/`fileId` per frame | `sessionId`+`fileId` u32 in every frame (`src/core/protocol-v2.ts:182` `V2_DATA_LAYOUT`) |
| Integrity | 1-byte XOR over 19 header bytes, payload unchecked | CRC-32/ISO-HDLC over whole frame (header+payload) + SHA-256 over reconstructed original |
| Parser | throws on bad | never throws — typed `DeqrV2Error` (`src/core/protocol-v2.ts:240` `DeqrV2Result`) |
| Sizes | `number` (`uint16` blockCount×512, `uint32` totalPayloadLength) | `bigint` u64, `toSafeNumber` checks `PRECISION_LOSS` |
| Codec sharing | Node `Buffer` — receiver carries second impl (`mobile-web/src/protocol.ts`) | `Uint8Array` only — single `protocol-v2.ts` imported by both sides via production Rollup |

v1 frames arriving at a v2 receiver are reported as `V1_FRAME`, never as corruption (`src/core/protocol-v2.ts:797` prefix check) — version mismatch cannot present as camera fault.

---

## 2. v1 — 20-byte frame header

Defined `src/core/protocol.ts:7` comments + `src/core/protocol.ts:49` `serializeFrameHeader` / `src/core/protocol.ts:88` `deserializeFrameHeader`.

| Offset | Field | Width | Encoding | Notes |
|---|---|---|---|---|
| 0 | `protocolVersion` | u8 | BE | Must be `1` (`src/core/protocol.ts:17` `FRAME_PROTOCOL_VERSION`) |
| 1 | `sessionId` | u32 | BE |Random per transfer |
| 5 | `segmentNumber` | u16 | BE | **Always 0** — encoder writes 0 (`src/core/fountain-encoder.ts:88`), receiver rejects ≠0 (`mobile-web/src/protocol.ts:39`) |
| 7 | `sequenceNumber` | u32 | BE | Fountain sequence (LT output index) |
| 11 | `blockCount` | u16 | BE | Source blocks K, 1..65,535 (`src/core/fountain-encoder.ts:88` gate) |
| 13 | `blockSize` | u16 | BE | Fixed 512 (`src/main/session-manager.ts:14` `V1_FOUNTAIN_BLOCK_SIZE_BYTES`) |
| 15 | `totalPayloadLength` | u32 | BE | Original length, not container length |
| 19 | `headerChecksum` | u8 | XOR | `calculateChecksum(buffer,19)` (`src/core/protocol.ts:38`) |

Payload follows as `Buffer` with `frame.header.payload` fountain block. Transport capacity `512 × 65,535 = 33,553,920` (field width, boundary-probed in `PHASE-00-AUDIT.md`). FEC = Luby LT over one segment (robust soliton `c=0.1, δ=0.05` in `src/core/fountain-encoder.ts:81`).

---

## 3. v2 — manifest + segmented data frames

### 3.1 Identity & framing

- Magic `0x44 0x32` (`D2`) at bytes 0-1 (`src/core/protocol-v2.ts:40` `V2_MAGIC_0/1`), `version:2` at byte 2 (`src/core/protocol-v2.ts:44`), `frameType` at byte 3. Distinguishes v2 from v1 (v1 starts 0x01).
- Endianness: **big-endian throughout**, no exceptions.
- `V2_FRAME_TYPE` (`src/core/protocol-v2.ts:46`) = `{ MANIFEST:0x01, SOURCE:0x02, REPAIR:0x03 }`. `SOURCE` = `symbolId < sourceSymbolCount`, `REPAIR` = `≥`.
- CRC-32 over entire serialized frame (header+payload) at final 4 bytes; structural validation binds frame to manifest; SHA-256 over original file is sole identity authority.

### 3.2 Manifest frame — `V2_MANIFEST_LAYOUT` (`src/core/protocol-v2.ts:155`)

| Offset | Field | Width | Type | Notes |
|---|---|---|---|---|
| 0 | `magic0` | u8 | — | `0x44` |
| 1 | `magic1` | u8 | — | `0x32` |
| 2 | `version` | u8 | — | `2` |
| 3 | `frameType` | u8 | — | `0x01` |
| 4 | `featureFlags` | u16 | BE | Advisory 0x00FF / critical 0xFF00 (`src/core/protocol-v2.ts:125`) |
| 6 | `sessionId` | u32 | BE | random (`src/main/streaming-sender.ts:1245` `randomUint32`) |
| 10 | `fileId` | u32 | BE |random |
| 14 | `originalSize` | u64 | BE bigint | Before compression; `≥1` |
| 22 | `transportSize` | u64 | BE bigint | Bytes segmented; `==originalSize` when `compressionMode==NONE` |
| 30 | `segmentSizeBytes` | u32 | BE | 64 KiB..64 MiB (`src/core/protocol-v2.ts:144`) |
| 34 | `symbolSizeBytes` | u16 | BE | 32..4096 (`src/core/protocol-v2.ts:141`) |
| 36 | `segmentCount` | u32 | BE | `ceil(transportSize/segmentSize)` |
| 40 | `fecProfileId` | u8 | — | `0x01` (`src/core/protocol-v2.ts:111` `LT_SYSTEMATIC_ROBUST_SOLITON_V1`) |
| 41 | `compressionMode` | u8 | — | `0x00 NONE` / `0x01 GZIP` (`src/core/protocol-v2.ts:53`) |
| 42 | `compressionParam` | u8 | — | log2 window 16..26, `0` when NONE (`src/core/protocol-v2.ts:91`) |
| 43 | `transportProfileId` | u8 | — | Advisory 0..4 (`src/core/transport-profiles.ts:104` `0=UNSPECIFIED` pre-Phase04) |
| 44 | `sha256` | 32 B | — | Digest of original file (`src/main/streaming-sender.ts:606` fused hash) |
| 76 | `filenameLength` | u16 | BE | 1..1024 UTF-8 bytes |
| 78 | `filename` | var | UTF-8 | `filenameLength` bytes, sanitized |
| var | `mimeLength` | u16 | BE | 0..255 bytes |
| var | `mimeType` | var | UTF-8 | Advisory, may be empty |
| tail | `crc32` | 4 B | BE | CRC of everything before it |

Fixed prefix `78 B` (`src/core/protocol-v2.ts:176`), fixed total outside var fields `84 B` (`src/core/protocol-v2.ts:178`). `serializeManifestFrame` (`src/core/protocol-v2.ts:691`) is the sole serializer; retransmitted every `manifestIntervalFrames=64` (`src/main/streaming-sender.ts:226`).

### 3.3 Data frame — `V2_DATA_LAYOUT` (`src/core/protocol-v2.ts:182`)

| Offset | Field | Width | Type | Notes |
|---|---|---|---|---|
| 0 | `magic0` | u8 | — | `0x44` |
| 1 | `magic1` | u8 | — | `0x32` |
| 2 | `version` | u8 | — | `2` |
| 3 | `frameType` | u8 | — | `0x02`/`0x03` |
| 4 | `sessionId` | u32 | BE | Must match manifest |
| 8 | `fileId` | u32 | BE | Must match manifest |
| 12 | `segmentIndex` | u32 | BE | 0..`segmentCount-1` |
| 16 | `symbolId` | u32 | BE | SOURCE `< sourceSymbolCount`, REPAIR `≥ sourceSymbolCount` |
| 20 | `sourceSymbolCount` | u32 | BE | K for this segment |
| 24 | `payloadLength` | u16 | BE | = `symbolSizeBytes` (except short final symbol payload still padded to symbol size on wire) |
| 26 | `frameFlags` | u16 | BE | `0` this revision |
| 28 | `payload` | var | bytes | Exactly `payloadLength` bytes; zero-padded final symbol tail stays on wire |
| tail | `crc32` | 4 B | BE | |

`headerBytes:28` (`src/core/protocol-v2.ts:195`), `crcBytes:4` (`src/core/protocol-v2.ts:196`), `overheadBytes:32` (`src/core/protocol-v2.ts:198`). `serializeDataFrame` (`src/core/protocol-v2.ts:727`) validates `frameType`/`symbolId`/`sourceSymbolCount`/`payload length` against `V2_LIMITS`.

### 3.4 Limits — `V2_LIMITS` (`src/core/protocol-v2.ts:130`)

| Field | Range | Notes |
|---|---|---|
| `minFilenameBytes` / `maxFilenameBytes` | 1 .. 1,024 | Sanitized UTF-8 |
| `maxMimeBytes` | 255 | Advisory |
| `minSymbolSizeBytes` / `maxSymbolSizeBytes` | 32 .. 4,096 | Practical QR capacity upper bound |
| `minSegmentSizeBytes` / `maxSegmentSizeBytes` | 64 KiB .. 64 MiB | Decoder working-set bound |
| `maxSegmentCount` | 0xFFFF_FFFF (u32) | Receiver narrows to `1<<24` via `RECEIVER_POLICY` |
| `maxSymbolsPerSegment` | 0xFFFF_FFFF (u32) |Implied by `segment/symbol` |
| `maxFileBytes` | `(1n<<64n)-1n` (u64) | Receiver narrows to `1 PiB` via policy |

`V2_COMPRESSION_WINDOW` log2 16..26 (`src/core/protocol-v2.ts:91`), `V2_WINDOW_LENGTH_PREFIX_BYTES=4`, `V2_MIN_GZIP_MEMBER_BYTES=18`. `V2_FEC_PROFILE` sole `0x01`.

### 3.5 Segmentation derivation

`planSegmentation` (`src/core/protocol-v2.ts:636`) and `segmentByteRange` (`src/core/protocol-v2.ts`) are pure arithmetic over `transportSize/segmentSizeBytes/symbolSizeBytes`. No `number` coercion except via `toSafeNumber` with `PRECISION_LOSS` guard. Offset for compressed transfers derived from manifest's window plan (`src/main/window-compressor.ts`), not from stream.

---

## 4. Sequence numbers & stream/session identity

| Concept | Width | Field | Semantics |
|---|---|---|---|
| Session | u32 | `sessionId` | One transfer session; opportunistic resume reuses (`src/main/streaming-sender.ts:646` `applyResume`) |
| File | u32 | `fileId` | Disambiguates within session |
| Segment | u32 | `segmentIndex` | Independent decoder unit; commit bitmap one bit per segment |
| Symbol | u32 | `symbolId` | Seed for repair neighbor set (`src/core/segment-encoder.ts:56` `PRNG(symbolId)`); source vs repair by `<K` |
| v1 `sequenceNumber` | u32 | — | LT output index (single-segment fountain) |
| v1 `blockCount` | u16 | — | K 1..65535, capacity gate |

Separation: v1 `segmentNumber` u16 is vestigial (always 0, rejected otherwise). v2 `segmentIndex` u32 is live and per-frame.

---

## 5. FEC composition

- **Profile:** single `LT_SYSTEMATIC_ROBUST_SOLITON_V1` (`src/core/protocol-v2.ts:111`). `segment-encoder.ts:80` `neighborsFor?` seam allows alternative rules measured against real decoder but ships one.
- **Distribution:** `src/core/prng.ts` `RobustSoliton(K)` — rho + tau (`src/core/fountain-encoder.ts:81` for v1, `src/core/prng.ts:RobustSoliton` for v2) with `c=0.1, δ=0.05`.
- **Degree cap:** `min(soliton.sampleDegree(prng), sourceSymbolCount)` (`src/core/segment-encoder.ts:57`), rejection sampling for distinct neighbours.
- **XOR:** `src/core/segment-encoder.ts:144` repair is XOR over uniform-length symbols; zero-padded final symbol XOR touches only real bytes (`src/core/segment-encoder.ts:159`).
- **Measured p99 repair overhead** (`src/core/transport-profiles.ts:48` `MEASURED_REPAIR_OVERHEAD`): 0.00@0% / 0.46@1% / 0.71@5% / 0.71@10% / 0.72@20% / 0.94@30% — profile `repairOverheadRatio` chosen above this curve (`src/core/transport-profiles.ts:378` validator).
- **No per-symbol checksum** beyond CRC on frame; layering is CRC per frame → structural validation → SHA-256 over original.

---

## 6. Integrity fields

| Layer | Scope | Algorithm | Authority |
|---|---|---|---|
| CRC-32 | Every frame (header+payload) | ISO-HDLC (`src/core/crc32.ts`) | Fast rejection of damaged optical reads |
| SHA-256 | Reconstructed original file | `node:crypto` sender (`src/main/streaming-sender.ts:1278`), `Sha256Stream` receiver (`src/core/sha256-stream.ts`) | **Sole file-identity proof** — `claimsIntegrityVerified` only for `VERIFIED`/`EXPORTING` (`src/shared/transfer-ui-state.ts`) |

v1 header XOR (`src/core/protocol.ts:38`) is ~1/256 acceptance of corrupted header and payload unchecked — replaced by CRC in v2.

---

## 7. Compatibility & versioning

- **v1 frozen:** header is `Buffer`-based (`src/core/protocol.ts`), `totalPayloadLength` u32 at 4 GiB-1, `MAX_FILE_SIZE` 64 MiB (`src/storage` `LIMITS`), `src/main/session-manager.ts:14` `V1_MAX_SERIALIZED_CONTAINER_BYTES`. No widening from inside.
- **v2 until Phase 10 vectors:** 21 vectors (9 valid, 12 rejection), regenerated `npm run vectors:v2:generate` + `git diff --exit-code`. CI regenerates and diffs — same guarantee as v1.
- **Advisory `transportProfileId` (byte 43):** unknown values reported not rejected (`src/core/transport-profiles.ts:102` comment), `PROTOCOL-V2.md` §4.4 — everything decoding needs is its own field.
- **Compression `compressionParam` (byte 42):** `0` when NONE, else log2 window (`PHASE-08`, `PROTOCOL-V2.md` §4.5). Vectors regenerated.
- **Worker protocol** is versioned (`src/core/protocol-v2.ts` independent; worker is `mobile-web/src/worker-protocol.ts` v6) — cached shell vs fresh worker fails at handshake by design (`RECEIVE_WORKER_PROTOCOL`).
- **Receiver policy narrows wire:** `src/core/receiver-policy.ts` `manifestPolicyRefusal` refuses `SEGMENT_COUNT_EXCEEDED` / `TRANSFER_TOO_LARGE` / `SEGMENT_TOO_LARGE` before storage; `RECEIVER_POLICY.maxSegmentCount = 1<<24` (16M) costs 2 MiB bitmap vs 512 MiB if honoring u32.

---

## 8. Known walls (recorded, not acted on)

- Header checksum beyond CRC not needed; payload has no per-byte ECC — verification is all-or-nothing over materialised buffer then streaming.
- UI capacity copy `src/renderer/App.tsx:240` states wrong number (recorded in `PHASE-00-AUDIT.md` §Recorded for later phases).
- `segmentIndex` is live u32; next walls after blockCount are `MAX_FILE_SIZE`/`LIMITS` 64 MiB then `totalPayloadLength` u32 — both gone in v2.

---

## 9. Evidence

- Sources: `src/core/protocol.ts:7-134`, `src/core/protocol-v2.ts:1-1100`, `src/core/segment-encoder.ts:51-147`, `src/core/transport-profiles.ts:48-56`, `src/core/receiver-policy.ts`, `mobile-web/src/protocol.ts:39` (v1 reject), `mobile-web/ARCHITECTURE.md` storage seam.
- Vectors: `protocol/test-vectors-v2/` 21 vectors, `scripts/protocol/generate-v2-vectors.ts`.
- Reports: `.ai-team/reports/performance/PHASE-00-AUDIT.md` (32 MB field width proof), `PHASE-01-PROTOCOL-V2-REPORT.md`, `PHASE-03-SYSTEMATIC-FOUNTAIN-REPORT.md`.
