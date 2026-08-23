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

---

## 6. DEQR v2 Threat Model — Streaming, Segmented, High-Speed Path

> **Status**: ENFORCED — Phase 10 of the Large-File / Maximum-Speed program, 2026-08-22.
> Gate record: [`.ai-team/reports/performance/PHASE-10-SECURITY-HARDENING-REPORT.md`](../reports/performance/PHASE-10-SECURITY-HARDENING-REPORT.md).

Sections 1–5 describe the v1 single-container transfer. v2 changes the shape of
the attack surface rather than its boundaries: the file no longer arrives as one
container held in memory, so a hostile stream now has *segmentation*, *recovery
state*, *a compression container*, *persistent working storage on the receiving
device*, and *a worker message port* to aim at. Each row below names the code
that enforces the control, because a threat model that names no file cannot be
checked against the build.

### 6.1 The optical channel is the only untrusted input

Everything a sender says arrives through a camera. Nothing about a frame is
trusted, including its own length. The order of checks is load-bearing and is
the same on both surfaces:

| Step | Where | What it establishes |
|:--|:--|:--|
| 1. Length | `mobile-web/src/receive-pipeline.ts` → `submit` | Payload is inside `RECEIVER_POLICY.maxFrameBytes` before it is walked, fingerprinted, or parsed |
| 2. Prefix | `src/core/protocol-v2.ts` → `readPrefix` | Magic, version and frame type, with a v1 frame reported as such and never reinterpreted |
| 3. Declared lengths | `parseManifestFrame` / `parseDataFrame` | Every length is checked against the declared frame **and** the buffer actually received, before a slice or an allocation |
| 4. CRC-32 | `checkCrc` | The bytes are the bytes the sender wrote. Fast rejection of damaged optical reads; **not** an integrity claim |
| 5. Self-consistency | `planSegmentation`, `compressionInconsistency` | Segmentation and the four compression fields are re-derived and compared, never trusted |
| 6. Receiver policy | `src/core/receiver-policy.ts` → `manifestPolicyRefusal` | This build is willing to act on it, before any device is touched |
| 7. Belonging | `validateDataFrameAgainstManifest` | The frame is for *this* transfer, this segment, and this symbol size |
| 8. Identity | `Sha256Stream` over the store | SHA-256 over the reconstructed original, read back off the device |

Only step 8 decides identity. Steps 1–7 decide whether work is done at all.

### 6.2 Threats and controls

| ID | Threat | Control | Code |
|:---|:-------|:--------|:-----|
| TM-020 | Manifest declares a segment count that forces a large completion bitmap | Receiver policy caps segments at 2^24; refused at the manifest, before storage | `receiver-policy.ts`, `receive-pipeline.ts` |
| TM-021 | 64-bit size or offset silently truncated into a JS number | `toSafeNumber` refuses above `Number.MAX_SAFE_INTEGER` rather than rounding | `protocol-v2.ts` |
| TM-022 | Frame declares a segment index or symbol id outside the transfer | Range-checked against the manifest's own plan; refused before a decoder exists | `segmented-receiver.ts` |
| TM-023 | Repair flood or duplicate storm exhausts memory or CPU | Per-segment caps on pending equations, neighbour references and tracked ids; refusals are O(1) and tested cheapest-first | `segment-decoder.ts` |
| TM-024 | Pathological FEC metadata (degree above K, neighbour outside the segment) | Neighbour set re-validated after generation, even though it is derived and not transmitted | `segment-decoder.ts` |
| TM-025 | Decompression bomb in the GZIP transport container | Output buffer **is** the bound: sized from `originalSize`, and a member that keeps producing is cancelled mid-stream with no allocation | `inflate-verify.ts` |
| TM-026 | Container record declares an impossible length | Refused against zlib's own expansion ceiling for the window **and** against what remains of the container, before a read | `inflate-verify.ts`, `compression-policy.ts` |
| TM-027 | Filename or MIME used to influence handling or reach a path | `sanitizeFilename` on both serialize and parse; session directories are derived from two u32 ids as fixed-width hex; MIME is advisory and never read for a decision | `filename-sanitizer.ts`, `opfs.ts` |
| TM-028 | Checkpoint on the device tampered with or corrupted | Size-bounded read; schema, identity, digest and full segmentation compared; bitmap checked against its own counters and masked past the last segment; base64 length checked **before** the decode allocates | `opfs.ts` |
| TM-029 | Worker message names a file the receiver never wrote | Closed allowlist of path shape and filename, validated on receipt and again at the open | `worker-protocol.ts`, `export.ts` |
| TM-030 | Renderer sends a malformed argument over an authorised IPC channel | Typed at the boundary; a value that is not a session id is the same answer as an expired one, and no renderer-supplied structure reaches a timer callback | `ipc-handlers.ts` |
| TM-031 | Two transfers visible to one camera cross-contaminate | Session and file id compared on every frame; a foreign frame is counted and reported, never adopted | `segmented-receiver.ts` |
| TM-032 | Working data left on the device after a transfer the user abandoned | Retention derived from *why* the session ended; sweep bounded by age and count; an explicit user-driven discard reaches only names matching the receiver's own fixed-width hex form | `receive-pipeline.ts`, `opfs.ts`, `receiver-storage.ts` |
| TM-033 | A refusal that no screen shows, leaving a phone scanning forever | Every manifest-level refusal is recorded as a session fault and has enumerated copy naming where the remedy is | `receive-pipeline.ts`, `receiver-view-model.ts` |

### 6.3 Resource maxima

Every receiver-side maximum lives in **`src/core/receiver-policy.ts`** and
nowhere else. The parser, the segmented receiver, the segment decoder, the
worker client, the storage layer and both test suites import it, so a limit
cannot be asserted against one copy while a different copy is enforced.
`tests/core/security-limits.test.ts` holds that property.

`V2_LIMITS` in `protocol-v2.ts` remains separate and means something different:
it is what the **wire format** can express — field widths, not policy. Receiver
policy may narrow a protocol maximum and may never widen one; the same test
enforces that direction.

### 6.4 The application shell is a supply chain, and it is versioned like one

An installed PWA runs whatever code its cache holds. That makes the shell cache a
distribution channel with the same property as any other: **code that cannot be
replaced cannot be fixed.** DEQR has already shipped one revision where an
installed phone was pinned to the first build it ever saw and could never receive
a security fix, which is why the rules below are controls rather than
conveniences.

- **The document is fetched network-first.** A reachable host always wins, so a
  fix reaches a device on its next online load without any user action.
- **Only content-hashed assets are served cache-first**, and their URL changes
  when their bytes do, so a cache hit can never be a stale version of a file.
- **`activate` deletes every `deqr-mobile-` cache that is not the current one** —
  older or newer. No previous release's shell can survive an update, and none can
  be reintroduced by a downgrade.
- **The cache name is bumped whenever the cache's required contents change**, not
  only when its strategy does, so a device cannot go on reusing a cache written
  under rules that no longer hold.
- **Recovery is bounded and scoped.** `boot.js` deletes only caches this
  application named and unregisters only its own workers, and it reloads at most
  once per tab before showing a diagnostic instead — a persistent fault must not
  become a reload loop.
- **The precache list is filtered at the worker**, to same-origin URLs only, so a
  page cannot be induced to seed the cache from a foreign host. The health probe
  is excluded specifically: reachability must be measured, and a cached probe
  would let an offline receiver claim the desktop host is up.

What this does **not** cover: an attacker who can serve the origin can serve any
shell they like, exactly as with any web application. DEQR's boundary is that the
origin is the user's own desktop over LAN HTTPS, serving static assets read-only,
with no transferred payload passing through it.

### 6.5 What is deliberately not claimed

- **The frame CRC-32 and gzip's per-member CRC are transmission checks.** Only
  SHA-256 over the reconstructed original file decides identity, and it runs
  over bytes read back from the device rather than over what the writer was
  handed.
- **The resume token is not an integrity mechanism.** Its five-byte digest
  prefix is a wrong-file guard. A resumed transfer is hashed end to end exactly
  as a fresh one is.
- **A storage preflight is not a measurement of free space.** It compares a
  browser-granted quota against a required budget and labels its own
  confidence; a transfer allowed on that basis can still run out, which the
  write path treats as a normal outcome.
- **No iOS share-sheet size limit is claimed.** DEQR imposes none; whether the
  platform does is Phase 11's to measure on a device.
