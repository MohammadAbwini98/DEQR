# DEQR Feature Specification Matrix

## Core Product Capabilities

### 1. Send Mode (Animated QR Stream Generation)
- Select any arbitrary binary file up to 64 MB (Phase 1).
- Preserves filename, file size, extension, MIME type, and SHA-256 digest.
- Selective compression (applies Zlib/Gzip only when compressed payload size is smaller than uncompressed payload).
- Selective AES-256-GCM encryption with password-derived key.
- Real-time fountain frame rendering to high-FPS canvas.
- Configurable stream profiles:
  - **Reliable**: Low QR density (Version 10-15), lower FPS (~10-15 FPS)
  - **Balanced**: Standard density (Version 20-25), standard FPS (~20-24 FPS)
  - **Fast**: High density (Version 30-40), high FPS (~30 FPS)
- Controls: Pause, resume, restart stream, cancel transfer, full-screen QR focus.

### 2. Receive Mode (Camera Capture & Optical Decoding)
- Live Web Camera stream capture and alignment guide frame.
- Worker pool of WASM QR decoders (`zxing-wasm`) running off the main thread.
- Fountain decoder buffer accumulating distinct blocks until `K × 1.15` frames are collected.
- Segment progress indicator, missing block estimator, live throughput rate (KB/s).
- Mandatory SHA-256 integrity verification before saving payload to target directory.

### 3. Transfer History & Audit Trail
- Local audit log tracking date, filename, file size, SHA-256, duration, transfer direction (Send/Receive), encryption state, and status.
- Zero payload byte retention in audit log.

### 4. Settings & Security Policies
- Extension allowlist / denylist enforcement (blocking `.exe`, `.ps1`, `.bat`, `.dll` by default unless explicitly allowed).
- Security warning on active screen capture or focus lost.
- Theme selector (Dark / Light mode).
