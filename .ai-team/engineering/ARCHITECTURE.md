# DEQR Technical Architecture Specification

## Overview

DEQR is an offline desktop optical transfer application built with Electron, React, TypeScript, and Vite. It converts binary files into animated fountain-coded QR streams for screen-to-camera transmission.

```text
DEQR Desktop Application
│
├── Electron Main Process (src/main/*)
│   ├── Application lifecycle & window management
│   ├── Portable environment paths
│   ├── File selection & native dialog service
│   ├── Safe file reading & binary buffer handling
│   ├── Offline enforcement & network protocol blocking
│   ├── Local audit log service
│   └── Preload IPC Handlers
│
├── Preload Bridge (src/preload/*)
│   └── Context-isolated IPC methods (selectFile, inspectFile, startTransfer, cancelTransfer, saveReceivedFile)
│
├── React Renderer Process (src/renderer/*)
│   ├── Views: Dashboard, Send File, Receive File, Transfer History, Security Settings
│   ├── AWKIT-style design system components & visual layout
│   ├── High-frequency QR stream canvas / WebGL renderer
│   ├── Camera capture preview & stream alignment
│   └── WASM QR decoding worker pool
│
└── Optical Transfer Core (src/core/*)
    ├── DEQR Container format encoder/decoder
    ├── Compression service (Zlib / Gzip selective compression)
    ├── Fountain encoder (Luby Transform LT generator)
    ├── Fountain decoder (Soliton distribution receiver)
    ├── AES-256-GCM encryption & key derivation
    └── SHA-256 binary verifier
```

## Stream Protocol Layers

### Layer 1: File Container Format
```text
DEQR Container
├── Magic: "DEQR" (4 bytes)
├── Protocol Version (2 bytes)
├── Filename (Variable string, UTF-8)
├── MIME Type (Variable string)
├── Original File Size (8 bytes, Uint64)
├── Compression Flag (1 byte: 0=none, 1=gzip)
├── Encryption Flag (1 byte: 0=none, 1=AES-256-GCM)
├── Creation Timestamp (8 bytes)
├── SHA-256 Digest (32 bytes)
└── Binary Payload Bytes
```

### Layer 2: Fountain Frame Header (20 bytes)
```text
Frame Header
├── Protocol Version (1 byte)
├── Session ID (4 bytes)
├── Segment Number (2 bytes)
├── Fountain Sequence Number (4 bytes)
├── Block Count (2 bytes)
├── Block Size (2 bytes)
├── Total Payload Length (4 bytes)
└── Header Checksum (1 byte)
```

## Process Isolation & IPC Rules
- `nodeIntegration`: false
- `contextIsolation`: true
- `sandbox`: true
- Renderer process cannot call raw Node.js primitives or system commands. All file access must route through explicit contextBridge methods in `src/preload/index.ts`.
