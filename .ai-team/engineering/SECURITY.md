# DEQR Security Architecture & Threat Model

## Status
- **Threat Model**: INITIAL — Created 2026-08-06
- **Encryption**: DEFERRED — Planned security tranche (not M1 scope)
- **Security Controls**: PROPOSED — Must be enforced from first implementation commit

---

## 1. Trust Boundaries

```text
┌──────────────────────────────────────────────────┐
│                  Host OS (Windows)                │
│                                                   │
│  ┌─────────────────────────────────────────────┐  │
│  │           Electron Main Process              │  │
│  │  ┌──────────┐  ┌──────────┐  ┌───────────┐  │  │
│  │  │ File I/O │  │  IPC     │  │  Audit    │  │  │
│  │  │ Service  │  │ Handlers │  │  Logger   │  │  │
│  │  └──────────┘  └────┬─────┘  └───────────┘  │  │
│  │                     │                         │  │
│  │  ═══════════════ PRELOAD BRIDGE ════════════  │  │
│  │        (contextBridge, typed API only)         │  │
│  │                     │                         │  │
│  │  ┌─────────────────┴──────────────────────┐  │  │
│  │  │         Renderer Process (React)        │  │  │
│  │  │  ┌──────────┐  ┌────────┐  ┌────────┐  │  │  │
│  │  │  │ UI Views │  │ Canvas │  │ State  │  │  │  │
│  │  │  └──────────┘  └────────┘  └────────┘  │  │  │
│  │  └────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────┘  │
│                                                   │
│  ════════ PHYSICAL OPTICAL CHANNEL ════════════   │
│       Screen → Camera (air gap boundary)          │
└──────────────────────────────────────────────────┘
```

**Trust boundary transitions**:
- TB-1: Host OS ↔ Electron Main Process (file system, native dialogs)
- TB-2: Electron Main Process ↔ Preload Bridge (IPC channel, typed contracts)
- TB-3: Preload Bridge ↔ Renderer Process (contextBridge API only)
- TB-4: Screen ↔ Physical environment (optical exfiltration boundary)
- TB-5: Camera ↔ Renderer Process (media stream capture, M2 scope)

---

## 2. Threat Analysis (STRIDE)

| ID | Category | Threat | Affected Boundary | Likelihood | Impact | Severity | M1 Scope | Mitigation | Status |
|:---|:---------|:-------|:-------------------|:-----------|:-------|:---------|:---------|:-----------|:-------|
| TM-001 | Information Disclosure | Unencrypted QR stream visible to nearby cameras | TB-4 | Medium | High | HIGH | Awareness only | AES-256-GCM encryption (deferred security tranche); screen-blank on focus loss (M2+) | DEFERRED |
| TM-002 | Tampering | Malicious file delivered via crafted QR frames | TB-4, TB-3 | Medium | High | HIGH | M1 | SHA-256 hash verification before save; reject hash mismatch | PROPOSED |
| TM-003 | Tampering | Path traversal via manipulated filename in transfer metadata | TB-2 | Medium | High | HIGH | M1 | Sanitize filenames: strip path separators, `..`, null bytes; use basename only | PROPOSED |
| TM-004 | Denial of Service | Oversized file claim exceeding 64 MB limit | TB-2 | Medium | Medium | MEDIUM | M1 | Reject files >64 MB at file selection; validate container declared size | PROPOSED |
| TM-005 | Denial of Service | Decompression bomb (small compressed payload expanding to huge output) | TB-2 | Low | High | MEDIUM | M1 | Cap decompressed size to declared original size + margin; abort on exceeded limit | PROPOSED |
| TM-006 | Denial of Service | Memory exhaustion from excessive fountain frame buffering | TB-3 | Medium | Medium | MEDIUM | M1 | Bounded frame buffer; cap block count; reject unreasonable metadata values | PROPOSED |
| TM-007 | Tampering | Malformed QR frame headers causing parser crash | TB-3 | Medium | Medium | MEDIUM | M1 | Strict header validation; reject frames with invalid magic/version/checksum | PROPOSED |
| TM-008 | Tampering | Inconsistent session ID or block metadata across frames | TB-3 | Low | Medium | LOW | M1 | Reject frames with mismatched session or declared block parameters | PROPOSED |
| TM-009 | Elevation of Privilege | Renderer process accessing Node.js APIs directly | TB-3 | Low | Critical | HIGH | M1 | `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` | PROPOSED |
| TM-010 | Elevation of Privilege | Unsafe IPC allowing arbitrary main-process operations | TB-2 | Low | Critical | HIGH | M1 | Narrow typed preload API; validate all IPC inputs; allowlist IPC channels | PROPOSED |
| TM-011 | Information Disclosure | External navigation or popup loading remote content | TB-3 | Low | High | HIGH | M1 | Deny all `will-navigate`, `new-window`; CSP `default-src 'self'` | PROPOSED |
| TM-012 | Information Disclosure | Outbound network requests leaking data | TB-1 | Low | Critical | CRITICAL | M1 | Block `http`, `https`, `ws`, `wss` protocol schemes; Electron protocol handler deny; CSP | PROPOSED |
| TM-013 | Information Disclosure | Audit log storing transferred file contents | TB-1 | Low | High | HIGH | M1 | Audit log stores metadata only (filename, size, hash, timestamp); never payload bytes | PROPOSED |
| TM-014 | Tampering | Dependency supply-chain compromise | TB-1 | Low | High | MEDIUM | M1 | Pin dependency versions; use lock files; periodic `npm audit` | PROPOSED |
| TM-015 | Information Disclosure | Temporary file retention after transfer | TB-1 | Low | Medium | MEDIUM | M1 | Clean up temp buffers on transfer completion/cancellation/error | PROPOSED |
| TM-016 | Spoofing | Executable/script file delivered as benign extension | TB-4 | Medium | High | HIGH | M1 | Block high-risk extensions by default; require explicit user override with warning | PROPOSED |
| TM-017 | Information Disclosure | Camera privacy — unauthorized camera activation | TB-5 | Low | Medium | MEDIUM | M2 | Camera only activated on explicit user action; visual indicator; M2 scope | DEFERRED |
| TM-018 | Information Disclosure | Screen capture / shoulder surfing during QR display | TB-4 | Medium | Medium | MEDIUM | M2+ | Optional auto-blank on focus loss; full-screen mode; M2+ feature | DEFERRED |
| TM-019 | Tampering | Corrupted transfer metadata causing incorrect file reconstruction | TB-3 | Low | High | MEDIUM | M1 | Container header checksum; SHA-256 verification gate before save | PROPOSED |

---

## 3. Mandatory Security Controls (M1 Enforcement)

All controls below **MUST** be verified in actual code before declaring M1 complete.

### Electron Configuration
- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true` (where Electron version supports it)
- `webSecurity: true`
- Deny `will-navigate` to any non-app URL
- Deny `new-window` creation
- Block protocol schemes: `http`, `https`, `ws`, `wss`

### Content Security Policy
```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'self'; object-src 'none'; frame-src 'none';
```

### Preload Bridge
- Expose only explicitly allowlisted methods via `contextBridge.exposeInMainWorld`
- Validate all IPC input types before processing in main
- No raw `ipcRenderer.send` or `ipcRenderer.invoke` exposed to renderer

### File Safety
- Sanitize filenames: strip `/`, `\`, `..`, null bytes; use `path.basename()` equivalent
- Reject files exceeding 64 MB at selection time
- Verify SHA-256 hash before saving any received file
- Never auto-execute or auto-open received files
- Block extensions by default: `.exe`, `.dll`, `.ps1`, `.bat`, `.cmd`, `.js`, `.vbs`, `.msi`

### Data Hygiene
- Audit log stores metadata only — never payload bytes
- No secrets, keys, or transferred content in source control
- Clean up temporary transfer buffers on completion/cancellation/error

---

## 4. Encryption — Deferred Security Tranche

AES-256-GCM payload encryption is a planned security enhancement. It is **NOT** included in M1 scope.

Before implementation, the following must be formally specified:
- Encryption algorithm and mode (AES-256-GCM proposed)
- Key derivation function (PBKDF2 or Argon2 proposed)
- Key derivation parameters (iterations, salt length, key length)
- Nonce/IV strategy (unique per transfer session)
- Authentication tag handling
- Metadata coverage (which fields are encrypted vs. plaintext)
- Failure behavior (what happens on decryption failure)
- Recovery implications (can a partially decrypted transfer be resumed?)
- Key distribution model (passphrase-based for initial release)

This specification must be reviewed by the Cybersecurity Engineer and approved by the PM before any encryption code is written.

---

## 5. File Extension Policy

### Blocked by Default (Receiver)
`.exe`, `.dll`, `.ps1`, `.bat`, `.cmd`, `.js`, `.vbs`, `.msi`, `.scr`, `.com`, `.pif`, `.hta`, `.wsh`, `.wsf`

### Allowed by Default
All other extensions including: `.pdf`, `.txt`, `.log`, `.sql`, `.csv`, `.json`, `.xls`, `.xlsx`, `.doc`, `.docx`, `.msg`, `.zip`, `.rar`, `.png`, `.jpg`, `.gif`, `.bmp`, `.tiff`

### Override Behavior
Blocked extensions may be overridden with explicit user confirmation dialog including security warning.
