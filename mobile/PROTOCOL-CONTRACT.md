# DEQR Desktop-to-Mobile Protocol Contract

This document defines the iOS receiver boundary for the desktop DEQR sender.
It is an implementation contract, not a substitute for the golden-vector tests
in `protocol/test-vectors/`.

## Authoritative inputs

- Desktop TypeScript protocol/container implementation: `src/core/`.
- C# parity implementation: `mobile/src/DEQR.Core/`.
- Golden binary vectors and manifest: `protocol/test-vectors/`.

The vectors are authoritative for byte-level interoperability. A mobile
implementation must consume the QR decoder's raw bytes directly. It must not
convert frame bytes through `string`, UTF-8 text, Latin-1 text, Base64, or a
JSON transport.

## Frame boundary

Every decoded QR payload is exactly one DEQR frame:

| Field | Bytes | Encoding |
| --- | ---: | --- |
| Frame protocol version | 1 | unsigned byte; version `1` |
| Session ID | 4 | unsigned, big-endian |
| Segment number | 2 | unsigned, big-endian; `0` for the current protocol |
| Sequence number | 4 | unsigned, big-endian |
| Source block count | 2 | unsigned, big-endian |
| Block size | 2 | unsigned, big-endian |
| Total container length | 4 | unsigned, big-endian |
| Header checksum | 1 | XOR of the preceding 19 header bytes |
| Frame payload | block size | raw bytes |

The header is 20 bytes. The receiver must call
`FrameSerializer.DeserializeFrame` before passing a frame to
`FountainDecoder.ReceiveFrame`. It must reject a bad checksum, a short frame,
an unsupported protocol version, a payload length that differs from the block
size, inconsistent session metadata, and out-of-bounds block declarations.

Duplicate sequence numbers are safe to observe but do not advance the decoder.
Systematic frames have sequence numbers lower than the source block count;
later frames use the deterministic Mulberry32/Robust-Soliton path already
implemented in `DEQR.Core`.

## Reconstruction boundary

When `FountainDecoder.IsComplete` is true, obtain the exact container bytes
with `ReconstructPayload()`. Do not save, expose, or report a received file
until `ContainerParser.DeserializeContainer` accepts those bytes.

The container begins with `DEQR`, uses protocol version `1`, and represents all
multi-byte numeric values as big-endian. The parser enforces the current 64 MiB
limit, validates declared uncompressed lengths, rejects malformed flags, and
rejects trailing or truncated data. Filename display and saving must use the
sanitized filename returned by the parser.

The receiver must verify the reconstructed original bytes with
`SHA256Verifier` against the container digest before enabling save/export.
`ReceivedFileReconstructor` handles the desktop sender's gzip-compressed
payloads with a declared-length output bound, and rejects encrypted payloads
because the encryption tranche is not implemented.

## IOS-2 boundary

IOS-2 establishes the .NET MAUI iOS shell, the iOS privacy/files declarations,
and the application `Documents/Received` directory. The platform-independent
receiver pipeline is implemented in `DEQR.Core` so it can be tested without an
iOS runtime. It must not claim camera capture, QR decoding, or iOS export
support until native adapters are implemented and device-tested.

The next stages must preserve this contract:

1. AVFoundation capture and a raw-byte QR adapter provide one raw frame at a
   time with backpressure.
2. `DEQR.Core` validates and reassembles frames without any text conversion.
3. The result pipeline verifies integrity before storing a file in
   `Documents/Received` or offering it to the Files picker.
