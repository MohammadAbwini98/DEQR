# DEQR Technical Architecture Specification

## Overview

DEQR moves an arbitrary file between two computers that share no network, by
animating it as fountain-coded QR frames on one screen and reading them with the
other's camera. The sender is an Electron desktop application; the receiver is an
installable Safari/Home-Screen PWA under `mobile-web/`. Nothing is uploaded,
there is no backend, and the two halves interoperate only through the optical
wire contract in [PROTOCOL-V2.md](./PROTOCOL-V2.md).

**This document describes what is implemented.** It was previously a Milestone-1
proposal and was rewritten in Phase 12 of the Large-File / Maximum-Speed program,
because the shipped architecture had diverged from it far enough that the
document was misleading rather than merely incomplete. Where something is not
built, it says so.

---

## The one architectural decision everything follows from

**No component ever holds the file.**

The original design read a file into a buffer, containerised it, fountain-coded
the buffer, and displayed the result — which put a hard ceiling near 32 MB on
both sides and made the ceiling a memory limit rather than a protocol one.
Phases 02 through 08 replaced that with a streaming pipeline in which every
stage is bounded by *configuration* rather than by file size:

- the sender reads windows off disk at 64-bit offsets and never materialises the
  file (`src/main/streaming-sender.ts`);
- the wire format carries segments, so the unit of recovery is a segment rather
  than the whole transfer (`src/core/protocol-v2.ts`);
- the receiver writes each recovered segment straight to its final offset in a
  pre-sized OPFS file and holds at most two segments in memory
  (`mobile-web/src/opfs-segment-store.ts`);
- integrity is a streaming SHA-256 over bounded windows read back from that
  file, because `crypto.subtle.digest` needs its whole input resident and a
  receiver that never held the file could not have used it
  (`src/core/sha256-stream.ts`);
- export hands over a `File` that *references* the OPFS entry, so the share
  sheet reads from disk rather than from a tab's heap.

Measured consequence: a 4 GiB transfer completes byte for byte with receiver
memory flat at 1.34 MiB and sender memory at 1.37 MiB.

**What this does not mean.** See [Certified size](#certified-size) below. The
architecture has no 32 MB limit; the *supported* maximum is a separate,
physically-certified number, and it has not been earned yet.

---

## Component architecture

```text
Electron main process (src/main/*)
├── index.ts                     lifecycle, window, CSP, network fail-closed
├── ipc-handlers.ts              every renderer channel, each sender-checked
├── streaming-sender.ts          reads the file in windows; emits v2 frames
├── streaming-session-registry.ts  one live streaming session per id
├── window-compressor.ts         the GZIP transport container (Phase 08)
├── session-manager.ts           v1 sessions; loopback self-verification
├── ipc-sender-policy.ts         "is this a trusted top-level frame"
├── development-request-policy.ts  dev-only origin allowance, fail-closed
├── pwa-host.ts / pwa-host-lifecycle.ts / pwa-certificate.ts / lan-addresses.ts
│                                opt-in LAN HTTPS host for the receiver PWA
└── (no audit-log service, no settings store — neither was built)

Preload bridge (src/preload/index.ts)
└── 19 allowlisted channels, typed, no filesystem surface

React renderer (src/renderer/*)
├── App.tsx                      surfaces: dashboard, stream, loopback, receiver
├── sender-model.ts / sender-state.ts   the sender's only state machine
├── qr-frame-scheduler.ts        paced frame pull, decoupled from React state
├── qr-render.ts                 QR matrix -> canvas
├── components/StreamTransferView.tsx   the v2 sending surface
├── components/SenderPreflightCard.tsx  size, profile, compression decision
├── components/ResumeTokenEntry.tsx     the 40-character cross-air-gap token
├── components/PwaHostCard.tsx          start/stop the LAN receiver host
└── components/LoopbackView.tsx         local re-decode; never optical

Optical core (src/core/*) — shared by sender and receiver
├── protocol-v2.ts               frame codec, v1/v2 discrimination
├── segment-encoder.ts / segment-decoder.ts / segmented-receiver.ts
├── transport-profiles.ts        Reliable / Balanced / Turbo / Experimental
├── qr-capacity.ts               version, ECC, payload per frame
├── compression-policy.ts        content-sampled; carries no filename
├── sha256-stream.ts             incremental SHA-256
├── resume-token.ts              Crockford base32, 40 characters
├── receiver-policy.ts           every receiver-side maximum, in one place
├── crc32.ts, prng.ts, hash.ts, filename-sanitizer.ts
└── protocol.ts, container.ts, fountain-*.ts, compression.ts   (v1)

PWA receiver (mobile-web/src/*)
└── documented separately in mobile-web/ARCHITECTURE.md
```

### What was proposed and is not built

Listed so the gap is a fact rather than a silence: AES-256-GCM payload
encryption (the container reserves the flag and the receiver *rejects* an
encrypted container), the metadata audit log, the settings store, transfer
history, and the `zxing-wasm` decoder — the receiver uses `jsQR`.

---

## Two protocols, one receiver

`src/core/protocol.ts` (v1) and `src/core/protocol-v2.ts` (v2) both ship.

- **The desktop sender emits v2 for every optical transfer.** Since Phase 09 the
  renderer drives `streamTransfer`; the v1 `transfer:*` channels remain
  registered and are no longer reached from any UI surface. The only v1 encoder
  still exercised is **loopback**, which re-decodes a file already on the local
  disk and never reaches a camera.
- **The PWA receiver accepts both.** `detectProtocolVersion` reads at most three
  bytes and routes. This is deliberate and is not dead weight: a phone updates
  independently of the desktop it is scanning, so a receiver that dropped v1
  would stop reading senders still on the previous release.
- **v1 is never reinterpreted as v2.** A v1 frame is detected and reported as
  such. The discrimination is structural — a v2 frame opens with the magic
  `'D' '2'` and a version byte; a v1 frame has no magic, and its 0x01 version
  byte at offset 0 is the whole of its signature — so the two cannot collide.

Full normative detail, including the migration rules, is in
[PROTOCOL-V2.md](./PROTOCOL-V2.md) §3 and §10.

---

## Storage and resume

The receiver's working storage is the Origin Private File System, one directory
per transfer at `/deqr/sessions/<sessionId>-<fileId>/`:

| File | Present when | Holds |
|---|---|---|
| `data.part` | always | the transport stream, pre-sized, written at plan offsets |
| `original.part` | compressed transfers only | the expanded file, pre-sized at session start |
| `checkpoint.json` | always | schema, plan identity, committed bitmap, counters |

Three properties matter more than the layout:

- **Pre-sizing is the storage preflight.** The file is truncated to its final
  length before a payload byte is written, so a device without room fails at the
  start rather than at 90%.
- **A checkpoint is metadata, never payload**, and it is bounded before it is
  read (`RECEIVER_POLICY.maxCheckpointBytes`) because it is *acted on*.
- **Abandoned data has an end.** `sweepStaleSessions` runs when a session opens
  and is bounded twice — by age and by count — so neither one ancient session
  nor a run of recent ones can grow without limit in a directory the user cannot
  see from the Files app.

Resume is opt-in per session and refuses anything it cannot prove is the same
transfer: a different digest, a different segmentation, a different session, a
bitmap that disagrees with its own counters, a data file whose length does not
match the plan, or **a checkpoint written under a schema this build does not
know**. Every refusal deletes the session directory before the fresh transfer
pre-sizes over it, because gaps in a reused file would read back as the previous
transfer's bytes rather than as zeros and would fail the hash only at the end.

Across the air gap the sender is told where to restart by a 40-character
Crockford base32 token the user carries by hand (`src/core/resume-token.ts`).

---

## Compression

Content-based, never extension-based. `src/core/compression-policy.ts` samples
three bounded windows, then runs a full sizing walk fused into the SHA-256 pass,
and can still fall back (`MEASURED_BELOW_THRESHOLD`). **The decision has no
parameter that could carry a filename**, which is how the no-extension-transport
rule is enforced structurally rather than by review.

In GZIP mode the transport stream is a **container, not a stream**:
`[u32BE length][gzip member]` per fixed run of original bytes, with
`compressionParam` = log2 of the window (16..26, default 20 = 1 MiB). That is
what makes a segment independently decodable, which is what makes resume and
out-of-order recovery survive compression. The 10% threshold is a **storage**
decision, not a throughput one: a compressed transfer holds the container and
the expanded file at once.

---

## Process isolation and IPC rules

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
  `webSecurity: true`.
- The renderer cannot reach Node primitives or the filesystem; every path goes
  through the 19 allowlisted `contextBridge` methods.
- **Every** renderer-to-main channel is registered through one wrapper that
  rejects any frame that is not the trusted top-level renderer. There is no
  exempt tier: window controls were considered for one and rejected, because a
  frame that should not start a LAN listener should not close the window
  mid-transfer either.
- Packaged CSP is `default-src 'none'` / `script-src 'self'` / `connect-src
  'none'`, with no inline script in the packaged HTML and no development
  allowance reaching the package.
- Electron fuses: `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off,
  `EnableNodeCliInspectArguments` off, cookie encryption on, ASAR integrity
  validation on, `OnlyLoadAppFromAsar` on.

---

## Local development topology

```text
scripts/run-local.cmd / scripts/run-local.ps1
  -> build Electron main + preload entries
  -> desktop Vite (src/renderer) -> http://localhost:5173
     -> Electron development window (loopback origin only)
  -> mobile-web Vite -> 0.0.0.0:5174
     -> HTTP for desktop-browser PWA UI work only
     -> trusted HTTPS for iPhone camera, PWA, and service-worker tests
```

Electron never loads or navigates to the PWA origin. Development allows only the
exact loopback Vite origin on port 5173 and its HMR socket; packaged Electron is
fail-closed for network origins. The LAN PWA listener is a scoped development
and physical-acceptance boundary, not a runtime transfer service — it serves
static application assets only, `GET`/`HEAD` only, and no transferred payload
passes through it.

The desktop and PWA Vite applications use separate dependency-optimizer caches,
because their different dependency graphs must not invalidate each other's
transformed module URLs.

The launcher treats an open TCP port as insufficient: it verifies the expected
desktop HTML, entry module and Buffer dependency response, plus the PWA HTML,
entry module and service-worker response, before starting Electron. Electron
then emits `DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER
preload=available` only after the dashboard has mounted and the preload bridge
is present. **That marker is launcher evidence, not a release or device
result.**

### Preview configurations

`.claude/launch.json` also carries `pwa` (receiver dev server on 5311),
`pwa-prod` (`vite preview` over the built `dist/pwa` on 5313 — the only way to
exercise the service worker, which registers in production builds only), and
`phase11-opfs` (the real-OPFS certification page on 5312).

---

## Certified size

Two statements, and the gap between them is the whole point:

> DEQR has **no 32 MB protocol-level limit**. Its architecture is streaming and
> multi-gigabyte safe: a 4 GiB transfer has been verified end to end, byte for
> byte, with receiver memory held flat at 1.34 MiB.

> DEQR's **certified maximum transfer size is 0 bytes.** No size has been
> certified on a physical device.

The supported maximum is defined as the largest size that has passed the current
release's physical-device certification matrix *and* the receiver's
available-storage preflight. That matrix is
[`PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md`](../reports/performance/PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md)
and every row in it is still PENDING. Nothing in the product, the release notes
or any listing may claim a maximum size or a maximum speed until it has rows.

The reason this is not pedantry: at Balanced's measured 4,631 verified bytes per
second, 1 GiB is a **64-hour continuous scan**. The pipeline can do it. Whether a
phone, a battery, a camera and a person can is a different question, and it is
the one still open.

---

## Where the rest is written down

| Subject | Document |
|---|---|
| Wire format, normatively | [PROTOCOL-V2.md](./PROTOCOL-V2.md) |
| Receiver internals, storage, backpressure, UI rules | [mobile-web/ARCHITECTURE.md](../../mobile-web/ARCHITECTURE.md) |
| Threat model and controls | [SECURITY.md](./SECURITY.md) |
| Failure symptoms and what they mean | [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) |
| Transfer profiles and measured recovery cost | [PROTOCOL-V2.md](./PROTOCOL-V2.md) §7 |
| Benchmark method and results | [`.ai-team/reports/performance/`](../reports/performance/) |
| The manual physical procedure | [PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md](../reports/performance/PHASE-11-PHYSICAL-CERTIFICATION-MATRIX.md) |
| What shipped, in release language | [RELEASE-NOTES.md](../../RELEASE-NOTES.md) |
