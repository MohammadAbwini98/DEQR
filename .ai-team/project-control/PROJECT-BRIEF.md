# DEQR Project Brief

## Product Overview
**DEQR** (Desktop Optical Transfer) is a secure, high-performance, offline-first portable desktop application that transfers arbitrary binary files across air-gapped computers using an animated, fountain-coded QR code stream.

## Primary Purpose
To provide an optical data bridge for isolated or air-gapped systems where network connections, USB drives, or physical cabling are prohibited or unavailable.

## Target Users
Security engineers, system administrators, and operators working on isolated, air-gapped, or zero-trust Windows workstations.

## Scope
- **File Processing**: Opaque binary byte handling (PDF, TXT, LOG, XLS, XLSX, DOC, DOCX, MSG, SQL, ZIP, RAR, CSV, JSON, Images, Permitted Executables).
- **Transfer Engine**: Decimen Optical Transfer adaptation utilizing Luby Transform (LT) fountain coding.
- **Phase 1 Capacity**: Maximum 64 MB per file.
- **Phase 2 Capacity**: Segmented transfers up to 250 MB.
- **Modes**: Dual mode (Send Mode: QR stream generator; Receive Mode: Camera scanner + WASM QR decoders).
- **Security & Integrity**: Optional AES-256-GCM encryption, password keys, mandatory SHA-256 binary verifier before saving.
- **Deployment Target**: Standalone portable Windows `.exe` (`electron-builder` portable target, x64).
- **Offline Rule**: Strict offline operation. Zero remote HTTP/WS network requests.

## Out of Scope
- Direct file content viewers/editors for proprietary formats (PDF/Word/Excel viewers).
- Remote network synchronization, analytics, cloud updates, or remote licensing.
- Auto-execution or automatic opening of received binary payloads.

## Key Quality Attributes
1. **Security**: Air-gapped isolation, zero secret leakage, mandatory payload hash verification.
2. **Reliability**: Resilient optical fountain reconstruction tolerating dropped, out-of-order, or blurred frames.
3. **Portability**: No administrator rights needed, no registry modification, single portable executable.
