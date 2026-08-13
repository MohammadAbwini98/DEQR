# Architecture Decision Records (ADR) Log

## ADR-001: Hub-and-Spoke Project-Manager-Led Multi-Agent Operating Model

- **Date**: 2026-08-06
- **Status**: APPROVED
- **Context**: Need a vendor-neutral multi-agent architecture capable of operating seamlessly across Claude Code, OpenAI Codex, Gemini CLI, Google Antigravity, Cursor, and generic AI agents.
- **Decision**: Adopt a strict Hub-and-Spoke organizational structure where the Human Product Owner interacts exclusively with the Project Manager (PM). All 8 specialist roles report to the PM with bounded file ownership.
- **Consequences**: Direct human-to-specialist interaction is eliminated; file concurrency collisions are prevented; project memory persists deterministically in `.ai-team/project-control/`.

---

## ADR-002: Adapt Decimen Fountain Coding Engine for Optical File Transfer

- **Date**: 2026-08-06
- **Status**: APPROVED
- **Context**: Static QR codes cannot hold normal-sized binary files. Fountain coding allows stream reconstruction without fixed frame ordering.
- **Decision**: Reuse and adapt Decimen Optical Transfer's TypeScript modules (`fountain.ts`, `protocol.ts`, Luby transform) wrapped inside an AWKIT-styled Electron application shell.
- **Consequences**: Files up to 64 MB (Phase 1) can be streamed rapidly at ~128 KB/s over visual screen-to-camera optical paths with drop resilience.

---

## ADR-003: Defer Payload Encryption to Post-M1 Security Tranche

- **Date**: 2026-08-06
- **Status**: APPROVED
- **Context**: `init.md` proposes AES-256-GCM encryption for transferred payloads. However, implementing encryption without a complete specification covering key derivation parameters, nonce strategy, authentication tag handling, metadata coverage, failure behavior, and recovery implications introduces security risk rather than reducing it.
- **Decision**: Defer encryption implementation from Milestone M1. Record it as a planned security tranche (TSK-040, TSK-041). The Cybersecurity Engineer must deliver a complete encryption design specification before any encryption code is written. M1 transfers are unencrypted, consistent with the upstream Decimen project which explicitly states its transfer is not encrypted.
- **Consequences**: M1 optical transfers are visible to any camera observing the screen. The threat model (TM-001) documents this risk. The protocol container reserves an Encryption Flag byte for forward compatibility. Users requiring confidentiality must rely on physical screen security until the encryption tranche is implemented.

---

## ADR-004: Systematic Fountain Mode for Low-K Reliability

- **Date**: 2026-08-06
- **Status**: APPROVED
- **Context**: The core Luby Transform (LT) algorithm fails to reliably recover small payloads (e.g., K=1 through K=16 blocks) under a fixed 1.4x-2.5x frame overhead. Generating random repair frames often misses essential source blocks entirely.
- **Decision**: Adopt a "Systematic Fountain Mode" prefix in the core encoder. The encoder emits the exact source blocks (degree 1) for the first K frames (`sequenceNumber < K`). Subsequent frames (`sequenceNumber >= K`) fall back to probabilistic LT repair symbols via the Robust Soliton distribution. The decoder is updated symmetrically. The UI will stream frames continuously without an arbitrary fixed upper limit until the decoder signals completion.
- **Consequences**: 100% recovery for zero-drop scenarios using exactly K frames. Massive reliability improvement for K < 16 without requiring binary protocol revisions. Decoder cancellation and resource bounds are enforced via maximum active memory checks (OOM prevention).

---

## ADR-005: Synthetic AWKIT Theme Implementation

- **Date**: 2026-08-06
- **Status**: APPROVED
- **Context**: The `UI-UX.md` specification mandates the use of AWKIT design system tokens, but the actual repository did not contain an AWKIT library or design asset package.
- **Decision**: Implemented a synthetic AWKIT-aligned glass-dark theme using vanilla CSS variables (`src/renderer/styles/theme.css`). 
- **Consequences**: Avoids blocking Stage 3 on missing design dependencies while retaining the mandated aesthetic.

---

## ADR-006: QR Byte Fidelity representation using Uint8Array

- **Date**: 2026-08-06
- **Status**: APPROVED
- **Context**: Passing Stage 2 optical binary frames to the QR generation library (`qrcode`) via a Latin-1 string translation introduces severe risk of UTF-8 re-encoding corruption for bytes > `0x7F`.
- **Decision**: Refactor the QR canvas generation to pass the raw payload bytes directly via `Uint8Array` to `qrcode`'s native byte-mode interface (`[{ data: uint8array, mode: 'byte' }]`).
- **Consequences**: Guarantees perfectly reversible byte-for-byte frame transmission. Tested and verified to preserve all `0x00 - 0xFF` values without mutation.

---

## ADR-007 / DEQR-ADR-MOBILE-001: Mobile Receiver Architecture (.NET MAUI 10 C# + iOS AVFoundation)

- **Date**: 2026-08-07
- **Status**: APPROVED
- **Context**: DEQR requires expanding optical receive capabilities to mobile devices (initially iPhone, with Android extensible). The mobile receiver must preserve raw binary QR bytes without string/Base64 re-encoding, operate strictly offline without network access, run inside Apple's iOS sandbox, and enforce byte-for-byte protocol parity with the desktop implementation.
- **Decision**: Adopt **C# + .NET MAUI 10** as the cross-platform mobile framework. The architecture splits into:
  1. `DEQR.Core`: Pure cross-platform C# library implementing protocol frame parsing, Luby transform fountain decoding, container validation, SHA-256 verification, and filename sanitization.
  2. `DEQR.Mobile`: .NET MAUI 10 app shell with platform-specific native AVFoundation camera acquisition on iOS (`Platforms/iOS/`).
  3. Raw Byte QR Engine: Use ZXing.Net Core (or `zxing-cpp` native binding fallback) exposing raw byte outputs directly (`RawBytes`), strictly avoiding string conversion.
  4. Protocol Parity: Authoritative binary test vectors stored under `protocol/test-vectors/` generated by the Windows implementation, validated via `DEQR.Core.Tests`.
  5. Privacy & Permissions: Declare `NSCameraUsageDescription` only. Strictly exclude microphone, location, local network (`NSLocalNetworkUsageDescription`), and Bluetooth.
  6. Storage & Files Integration: Save files in application sandbox (`/Documents/Received/`), exposed to Apple Files app (`UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace`) alongside a native `UIDocumentPickerViewController` "Save As..." export flow.
  7. Offline Policy: Zero remote network calls (`http`, `https`, `ws`, `wss`, `Bonjour`, `analytics`, `telemetry`).
  8. Signing & Distribution: Free Personal Team / Apple Account local development signing with Developer Mode enabled on the test device.
- **Consequences**: Single C# core codebase reusable for future Android receiver targets. Direct native access to AVFoundation and iOS Files picker. Requires Pair to Mac / Xcode setup on Mac host during iOS compilation. Groundwork laid for Milestone M2.

---

## ADR-008 / DEQR-ADR-MOBILE-002: Installable Safari Web App/PWA Receiver

- **Date**: 2026-08-08
- **Status**: APPROVED
- **Context**: The MAUI iOS route requires Mac/Xcode for build/deployment. The selected development and installation model is Safari > Share > Add to Home Screen > Open as Web App on a physical iPhone.
- **Decision**: Supersede MAUI as the active receiver implementation. Preserve `mobile/` as historical/reference material and implement the active receiver in `mobile-web/` as a standalone installable PWA. The browser receiver uses raw `Uint8Array` QR decoder output, a browser-safe implementation of the desktop v1 DEQR frame/container/fountain contract, Web Crypto SHA-256, bounded in-memory temporary storage, and Web Share/download export. It contains no backend, telemetry, CDN, or transfer upload path.
- **Consequences**: Native MAUI/AVFoundation behavior and IPA deployment are out of the active scope. Initial PWA installation/update requires a trusted HTTPS origin; subsequent cached optical transfer is designed to be offline. Physical iPhone Safari and installed-PWA validation are mandatory release gates and cannot be inferred from desktop browser tests.

---

## ADR-009 / DEQR-ADR-WEB-IOS-STARTUP-001: Separate Local Development Origins and Optimizer Caches

- **Date**: 2026-08-09
- **Status**: APPROVED FOR LOCAL DEVELOPMENT
- **Context**: Electron showed a white renderer area while `run-local.cmd -Https` started both applications. Investigation reproduced a shared Vite optimizer cache collision: the PWA optimization replaced the desktop metadata, leaving the desktop renderer's browser `buffer` import at an obsolete `504 Outdated Optimize Dep` URL before React executed.
- **Decision**: Electron development remains `http://localhost:5173/` with a parsed exact-loopback development exception. The PWA remains a distinct LAN-bound server on `5174`, using trusted HTTPS only for physical iPhone work. The two Vite configurations use separate optimizer cache directories. The launcher must verify expected HTML/module/dependency responses before Electron starts and await a concise dashboard-plus-preload readiness marker. HTTPS certificate SAN checking is local-only and must never use a global TLS bypass.
- **Consequences**: The desktop and PWA do not need to share an origin or certificate. Local HTTP/HTTPS startup has automated evidence, but certificate trust, firewall reachability, PWA installation/offline behavior, camera, export, optical transfer, package integrity, and release promotion remain separate gates.

---

## ADR-010 / DEQR-ADR-IPC-001: Privileged IPC Is a Capability Boundary and Authenticates Its Caller

- **Date**: 2026-08-14
- **Status**: APPROVED
- **Task**: DESKTOP-SEC-008

### Threat being addressed

The preload bridge is a capability surface, not a private channel. `contextIsolation` prevents the page from tampering with the bridge's internals, but it does not authenticate the caller: any script running in the renderer's JavaScript context can reach `window.deqr`. Before this decision, that reached a native file-open dialog, a file write, the transfer and loopback engines, the window controls, and `pwaHost:start`, which generates a 2048-bit private key and binds a listener on every interface.

Realistic paths to foreign code in that context are a dependency compromise inside the renderer bundle, a future injection through renderer-rendered values such as filenames, or an unexpected subframe. Existing controls make this hard rather than impossible: navigation is denied outright by `will-navigate`, popups are denied, the packaged CSP is `default-src 'none'` with `connect-src 'none'` and `frame-src 'none'`, requests are fail-closed, and the renderer runs sandboxed with no Node integration.

This is therefore **defence in depth, not remediation of a known exploit**. It is adopted because a privileged main-process operation should not treat "you are running in our window" as authorization, and because the cost is close to zero.

### Decision

Authenticate the sender of every renderer-to-main `invoke`. `src/main/ipc-sender-policy.ts` provides `isTrustedIpcSenderUrl` and `isTrustedIpcSender`, and `registerIpcHandlers` registers exclusively through a `handleTrusted` wrapper.

- **Trusted origins**: the packaged renderer document (a `file:` URL with no host) in every build, plus the exact desktop development origin when, and only when, the build is not packaged.
- **Development behaviour**: `http://localhost:5173` (also `127.0.0.1` and `[::1]`) is trusted, with no credentials and no other port, reusing `isDesktopDevelopmentOrigin` from ADR-009.
- **Packaged behaviour**: the development origin is **not** trusted. `isTrustedRendererOrigin` was deliberately **not** reused for IPC: it takes no `isPackaged` argument, so reusing it would have made a development server a trusted caller inside a shipped application.
- **Opaque and tooling origins**: `data:` and `devtools:` are rejected. They remain loadable as resources under `isAllowedRendererRequest`; a `data:` document is an opaque origin and must never hold the bridge. This is why IPC consumes the narrower `isLocalRendererFileUrl` rather than `isAllowedLocalRendererResource`.
- **Subframe policy**: only the top-level frame may call. `parent` must be exactly `null`; a frame that does not report its parent is rejected rather than assumed top-level, so an Electron change would break loudly in development instead of quietly admitting subframes.
- **Fail-closed behaviour**: a destroyed, absent, or unreadable `senderFrame` is rejected, as is any untrusted URL. Rejection throws `IPC_SENDER_REJECTED` with the fixed message `IPC request rejected.`; the privileged body never runs. The internal log records only the channel name, which is static application structure — the frame URL is not logged because it can contain a local filesystem path.
- **Coverage**: all 15 channels, with no exempt tier. An exemption for window controls was considered and rejected: a frame that may not open a LAN listener should not be able to close the window mid-transfer, and an exemption requires a reason rather than an absence of harm.
- **The PWA is not an Electron renderer.** The receiver served on 5174 is a separate trust domain and is never a trusted IPC caller; `http://localhost:5174` is covered by an explicit rejection test.

### One authoritative implementation

`ipc-sender-policy.ts` imports the origin predicates rather than restating them, so "the development server" and "the packaged renderer document" each have exactly one definition. Tests import those same production predicates and drive the real `registerIpcHandlers`. This is a direct response to `DESKTOP-SEC-050`, where a hand-copied policy inside a test diverged from the shipped handlers and hid a real defect.

### Consequences

An unguarded handler is now hard to add by accident, because registration itself carries the guard, and `tests/main/ipc-sender-policy.test.ts` enumerates whatever `registerIpcHandlers` registered and requires every channel to reject an untrusted sender. That enumeration was verified by temporarily registering a raw `ipcMain.handle`, which failed the suite by name. Test mocks of `electron` must now supply `app.isPackaged` and a `senderFrame`, which is intended: a mock that cannot represent the trust boundary cannot honestly exercise the handlers.
