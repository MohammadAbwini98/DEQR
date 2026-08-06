# Repository Discovery Report

**Date**: 2026-08-06
**Repository**: DEQR (`d:/Projects/DEQR`)

## Discovered Project Metadata

- **Application Name**: DEQR (Desktop Optical Transfer via Fountain-Coded Animated QR Stream)
- **Primary Tech Stack**: Electron, React, TypeScript, Vite
- **Optical Transfer Engine**: Decimen Optical Transfer adaptation (Luby Transform fountain coding)
- **Packaging Target**: Portable Windows `.exe` (`electron-builder` portable target, x64)
- **Target OS Environment**: Windows (offline isolated / air-gapped workstations, no administrator rights required)
- **Database / Persistence**: Local storage, local session recovery, local audit trail (no live remote database)
- **Security Boundary**: Strict offline operation (no remote URLs, zero network calls, AES-256-GCM payload encryption option, SHA-256 binary validation, ASAR integrity fuses)
- **Build / Verification Commands**: 
  - `npm install` (Package installation - NOT INSTALLED / NOT EXECUTED YET)
  - `npm run dev` (Vite dev server - NOT RUN YET)
  - `npm run build` (Vite build / TypeScript compile - NOT RUN YET)
  - `npm run package` (Electron builder portable exe - NOT RUN YET)
  - `npm test` (Test suite - NOT EXECUTED YET)

## Architectural Constraints

1. Files processed as opaque binary data (no native external viewers/parsers required).
2. Phase 1 file size ceiling: 64 MB. Phase 2 segmented transfers: up to 250 MB.
3. Dual mode operation: Send Mode (display animated QR) and Receive Mode (camera capture + WASM QR decoding workers).
4. Mandatory SHA-256 checksum verification before saving received files.
