# DEQR Testing & Evidence Policy

## Testing Matrix

```text
Unit Tests (src/core/*, src/main/*, src/renderer/*)
├── Fountain coding LT transform block encoding & decoding
├── Protocol header parsing & frame capacity calculation
├── Zlib compression vs uncompressed payload selection
├── AES-256-GCM encryption & key derivation
└── SHA-256 binary verifier pass/fail scenarios

Integration & Protocol Golden Vectors
├── Byte-perfect reconstruction of synthetic binary fixtures (TXT, PDF, XLSX, ZIP, EXE)
├── Dropped frame recovery (reconstruction with 15% missing sequence frames)
├── Out-of-order frame decoding
└── Corrupted frame header rejection

Security & Sandbox Tests
├── Electron fuse verification
├── Content Security Policy restriction (denial of network protocols)
└── IPC preload bridge context isolation
```

## Evidence Requirements
No test check may be marked PASSED without pasting or referencing the raw command execution log in `.ai-team/reports/testing/`.
