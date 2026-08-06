# DEQR Security Architecture & Policy

## Threat Landscape
Air-gapped data transfers over optical screen-to-camera channels prevent network exfiltration but remain susceptible to:
1. **Screen Capture / Physical Interception**: Unencrypted optical streams can be recorded by unauthorized cameras in proximity.
2. **Malicious Binary Transfer**: Receivers scanning unknown streams can receive unauthorized scripts (`.ps1`, `.bat`, `.vbs`, `.exe`).
3. **Buffer Exhaustion / Memory Injection**: Malformed frame headers or oversized payload claims could crash the receiver or trigger memory allocation errors.

## Security Controls

### 1. Payload Encryption
- AES-256-GCM authenticated encryption for transferred payloads.
- PBKDF2 / Argon2 key derivation from user-entered transfer passphrases.
- Authentication tag validation before payload assembly.

### 2. Electron Hardening & Sandbox
- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- Electron Fuses: `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` enabled.

### 3. File Extension & Executable Policy
- High-risk extensions (`.exe`, `.dll`, `.ps1`, `.bat`, `.cmd`, `.js`, `.vbs`, `.msi`) blocked by default on receiver save.
- User warning dialog required if policy override is selected.

### 4. Zero Network Protocol Access
- Content Security Policy (CSP) restricts default-src to `'self'`.
- Protocol schemes `http`, `https`, `ws`, `wss` denied at runtime.
