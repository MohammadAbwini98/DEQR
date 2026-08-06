# DEQR Technical Architecture Specification

## Overview

DEQR is an offline desktop optical transfer application built with Electron, React, TypeScript, and Vite. It converts binary files into animated fountain-coded QR streams for screen-to-camera transmission.

## Implementation Status Legend
- `[PROPOSED — M1]` = Planned for Milestone 1 implementation
- `[DEFERRED — M2]` = Planned for Milestone 2
- `[DEFERRED — M2+]` = Planned for future milestones
- `[DEFERRED — Security]` = Awaiting security tranche specification

---

## Component Architecture

```text
Electron Main Process (src/main/*)                  [PROPOSED — M1 scope]
├── Application lifecycle & window management        [PROPOSED — M1]
├── Portable environment paths                       [PROPOSED — M1]
├── File selection via native dialog                 [PROPOSED — M1]
├── Safe file read / binary buffer handling          [PROPOSED — M1]
├── Offline enforcement & network protocol blocking  [PROPOSED — M1]
├── Local audit log service (metadata only)          [PROPOSED — M1]
└── Preload IPC Handlers (narrow, typed)             [PROPOSED — M1]

Preload Bridge (src/preload/*)                       [PROPOSED — M1 scope]
├── Narrow allowlisted contextBridge APIs            [PROPOSED — M1]
├── No unrestricted filesystem access                [PROPOSED — M1]
└── Validated typed message contracts                [PROPOSED — M1]

React Renderer Process (src/renderer/*)              [PROPOSED — M1 scope]
├── Dashboard (minimal navigation)                   [PROPOSED — M1]
├── Send File workflow                               [PROPOSED — M1]
│   ├── File picker / drag-drop zone                 [PROPOSED — M1]
│   ├── File metadata inspector card                 [PROPOSED — M1]
│   └── Start Transfer action                        [PROPOSED — M1]
├── Active Transfer view                             [PROPOSED — M1]
│   ├── Animated QR stream canvas                    [PROPOSED — M1]
│   ├── Progress indicators (frame count, %)         [PROPOSED — M1]
│   └── Pause / Cancel controls                      [PROPOSED — M1]
├── Receive File view                                [PROPOSED — M1 loopback]
│   ├── Loopback verification display                [PROPOSED — M1]
│   ├── Camera capture preview                       [DEFERRED — M2]
│   ├── WASM QR decoding worker pool                 [DEFERRED — M2]
│   └── Camera alignment guide                       [DEFERRED — M2]
├── Transfer Complete / Failed states                [PROPOSED — M1]
├── Transfer History list                            [DEFERRED — M2]
├── Settings panel                                   [DEFERRED — M2]
└── AWKIT-style design system tokens                 [PROPOSED — M1]

Optical Transfer Core (src/core/*)                   [PROPOSED — M1 scope]
├── DEQR Container format encoder/decoder            [PROPOSED — M1]
├── Payload segmentation / block division            [PROPOSED — M1]
├── Compression decision (gzip when beneficial)      [PROPOSED — M1]
├── Fountain encoder (Luby Transform LT)             [PROPOSED — M1]
├── Fountain decoder (Soliton distribution)          [PROPOSED — M1]
├── Frame protocol (versioned 20-byte headers)       [PROPOSED — M1]
├── Session state management                         [PROPOSED — M1]
├── SHA-256 integrity verification                   [PROPOSED — M1]
└── AES-256-GCM encryption & key derivation          [DEFERRED — Security tranche]

QR Layer (src/core/qr/*)                             [PARTIAL — M1 scope]
├── QR capacity calculation                          [PROPOSED — M1]
├── Frame generation (QR matrix via node-qrcode)     [PROPOSED — M1]
├── Animated canvas rendering                        [PROPOSED — M1]
├── Camera capture (MediaDevices API)                [DEFERRED — M2]
├── WASM QR decoding workers (zxing-wasm)            [DEFERRED — M2]
└── Adaptive FPS / density controls                  [DEFERRED — M2+]

Local Persistence (src/storage/*)                    [PROPOSED — M1 minimal]
├── User settings (JSON file)                        [PROPOSED — M1 minimal]
├── Audit metadata log (JSON, no payload bytes)      [PROPOSED — M1]
└── Resumable session state                          [DEFERRED — M2+]
```

---

## Stream Protocol Layers (Version 1)

### Layer 1: File Container Format
```text
DEQR Container
├── Magic: "DEQR" (4 bytes)
├── Protocol Version (2 bytes, uint16 BE)
├── Filename Length (2 bytes, uint16 BE)
├── Filename (variable, UTF-8, sanitized)
├── MIME Type Length (2 bytes, uint16 BE)
├── MIME Type (variable, UTF-8)
├── Original File Size (8 bytes, uint64 BE)
├── Compression Flag (1 byte: 0x00=none, 0x01=gzip)
├── Encryption Flag (1 byte: 0x00=none, 0x01=AES-256-GCM — reserved for future)
├── Creation Timestamp (8 bytes, uint64 BE, ms since epoch)
├── SHA-256 Digest (32 bytes, original uncompressed file)
└── Payload Bytes (compressed if flag set, otherwise raw)
```

### Layer 2: Fountain Frame Header (20 bytes)
```text
Frame Header
├── Protocol Version (1 byte)
├── Session ID (4 bytes, random per transfer)
├── Segment Number (2 bytes, uint16 BE — reserved for multi-segment, always 0 in M1)
├── Fountain Sequence Number (4 bytes, uint32 BE)
├── Block Count (2 bytes, uint16 BE — total source blocks K)
├── Block Size (2 bytes, uint16 BE — bytes per block)
├── Total Payload Length (4 bytes, uint32 BE — container payload size)
└── Header Checksum (1 byte — XOR of preceding 19 bytes)
```

---

## Process Isolation & IPC Rules
- `nodeIntegration`: false
- `contextIsolation`: true
- `sandbox`: true
- `webSecurity`: true
- Renderer process cannot call raw Node.js primitives or system commands
- All file access must route through explicit `contextBridge` methods in `src/preload/index.ts`
- IPC channels are explicitly allowlisted and input-validated in main process handlers

---

## Source Directory Structure (Proposed)
```text
src/
├── main/
│   ├── index.ts              # Electron main entry
│   ├── window.ts             # Window management
│   ├── ipc-handlers.ts       # IPC channel handlers
│   ├── file-service.ts       # Safe file read/write/dialog
│   ├── audit-service.ts      # Metadata audit logging
│   └── security.ts           # CSP, protocol blocking, fuses
├── preload/
│   └── index.ts              # contextBridge API
├── core/
│   ├── container.ts          # DEQR container format
│   ├── fountain-encoder.ts   # Luby Transform encoder
│   ├── fountain-decoder.ts   # LT decoder
│   ├── protocol.ts           # Frame header serialization
│   ├── compression.ts        # Gzip selective compression
│   ├── hash.ts               # SHA-256 utilities
│   ├── session.ts            # Transfer session state
│   └── qr/
│       ├── capacity.ts       # QR version/density calculator
│       └── renderer.ts       # QR matrix generation
├── renderer/
│   ├── index.html            # Entry HTML
│   ├── main.tsx              # React root
│   ├── App.tsx               # Router/layout
│   ├── views/
│   │   ├── Dashboard.tsx
│   │   ├── SendFile.tsx
│   │   ├── ActiveTransfer.tsx
│   │   ├── ReceiveFile.tsx
│   │   └── TransferResult.tsx
│   ├── components/
│   │   ├── QRCanvas.tsx      # Animated QR display
│   │   ├── FileMetadata.tsx
│   │   ├── ProgressBar.tsx
│   │   └── TransferControls.tsx
│   └── styles/
│       ├── globals.css
│       └── tokens.css        # Design system CSS variables
└── storage/
    ├── settings.ts           # Settings read/write
    └── audit.ts              # Audit log read/append
```
