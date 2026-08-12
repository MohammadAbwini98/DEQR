# DEQR Mobile Web/PWA Architecture

## Scope and boundary

`mobile-web/` is the active mobile receiver. The prior .NET MAUI sources in
`mobile/` are **SUPERSEDED, NOT ACTIVE, and preserved for history/reference**.
This PWA has no backend and does not send transfer contents over the network.

## Components and data flow

```text
MediaStream -> video -> Canvas frame -> QR worker (jsQR)
  -> raw Uint8Array -> v1 frame parser -> fountain session
  -> bounded memory block store -> container parser -> SHA-256
  -> verified File -> Web Share / download fallback
```

- `src/camera.ts`: user-initiated camera lifecycle and frame scheduling.
- `src/decoder.ts` / `decoder.worker.ts`: worker-isolated QR detection that
  returns `Uint8Array` from jsQR `binaryData`; it never converts QR payloads to
  text.
- `src/protocol.ts`: browser-safe frame/container parser, Mulberry32/Robust
  Soliton fountain decoder, resource limits, filename sanitization, SHA-256,
  and deterministic receiver state machine.
- `src/App.tsx`: accessible state-driven UI; it is not the protocol authority.
- `src/export.ts`: user-controlled Web Share first, object-URL download
  fallback. An export request is not reported as a Files save confirmation.
- `public/sw.js`: narrowly scoped application-shell caching only. It never
  caches transfer contents.

## Trust boundaries and limits

Camera images, QR bytes, metadata, filenames, lengths, frame indexes, and
sender hashes are untrusted. The receiver rejects unsupported versions, invalid
checksums, inconsistent sessions, unsafe/oversized declarations, conflicting
duplicates, truncated frames/containers, encrypted containers, length mismatch,
and hash mismatch before a file can be exported.

The current v1 desktop sender emits 512-byte blocks and 20-byte raw frame
headers at a 30 FPS target. Browser limits are centralized in `LIMITS`:
64 MiB reconstructed container/file, 65,535 blocks, 2 KiB block/frame payload,
and 255-character filenames. Active blocks stay only in bounded memory and are
cleared on cancel, verification failure, reset, and after an export request.

## Storage and lifecycle policy

The active implementation selects in-memory storage because the desktop v1
contract already caps a transfer at 64 MiB and the PWA must not retain private
files by default. IndexedDB/OPFS were intentionally not selected: they would
increase persistence and cleanup complexity without physical iPhone evidence
that they improve this bounded receiver. A background/hidden app stops every
camera track and cancels the active session; the user explicitly starts again.

## Offline and HTTPS

The initial install/update requires a stable HTTPS origin. All app assets are
bundled locally; the service worker precaches the shell after registration and
cache-serves same-origin static requests. Optical transfer and integrity checks
use local browser APIs only. No CDN, analytics, API, WebSocket, or upload path
is present.

## Known validation boundary

Node/browser integration tests prove desktop-compatible raw-byte QR decode,
protocol reconstruction, and PWA assets. A physical iPhone is still required to
validate Safari camera behavior, installed standalone behavior, offline launch,
Share/Save behavior, and desktop-screen-to-camera optical performance.
