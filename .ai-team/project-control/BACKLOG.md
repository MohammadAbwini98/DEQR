# DEQR Backlog

## Milestone M1: Local Optical Transfer Vertical Slice

| Task ID | Title | Priority | Primary Role | Status | Dependencies | Acceptance Criteria |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **TSK-000** | Multi-Agent Architecture Bootstrap | Critical | Project Manager | COMPLETED | None | Canonical `.ai-team/` created, validated via doctor. |
| **TSK-010** | Formal Threat Model & Security Spec | Critical | Cybersecurity | COMPLETED | TSK-000 | STRIDE threat model with 19 threats assessed, trust boundaries defined, mandatory M1 security controls specified. |
| **TSK-011** | Architecture Status Annotations & Directory Structure | Critical | System Architect | COMPLETED | TSK-000 | Components annotated M1/M2/Deferred, source directory structure proposed, protocol binary formats specified. |
| **TSK-012** | UI/UX M1 Screen Specifications | Critical | UI/UX Designer | COMPLETED | TSK-000 | Implementation-ready wireframes for Dashboard, Send, Active Transfer, Receive (loopback), Result screens with all states. |
| **TSK-020** | Electron + React + TypeScript + Vite Scaffolding | High | Back-end Engineer | IN PROGRESS | TSK-010, TSK-011 | Clean Electron shell, React 18, Vite build, strict offline fuses, CSP, zero network calls. |
| **TSK-021** | Preload Bridge & IPC Contracts | High | Back-end Engineer | PENDING | TSK-020 | Narrow typed contextBridge API, validated IPC handlers, input sanitization. |
| **TSK-022** | Optical Transfer Core (Container + Fountain + Protocol) | High | Back-end Engineer | PENDING | TSK-020 | Container format, LT fountain encoder/decoder, frame protocol, SHA-256, compression decision. |
| **TSK-023** | React Renderer M1 Views | High | Front-end Engineer | PENDING | TSK-020, TSK-022 | Dashboard, Send, Active Transfer (QR canvas), Receive (loopback), Result views with all states. |
| **TSK-024** | QR Frame Generation & Canvas Rendering | High | Front-end Engineer | PENDING | TSK-022 | QR matrix generation via node-qrcode, animated canvas display, frame scheduling. |
| **TSK-025** | Test Fixtures & Unit Tests | High | QA Engineer | PENDING | TSK-022 | Reproducible binary fixtures, 19+ unit test cases covering container/protocol/fountain/hash/compression. |
| **TSK-026** | Integration Tests & Loopback Verification | High | QA Engineer | PENDING | TSK-023, TSK-024 | Byte-perfect file→encode→decode→verify pipeline, audit log verification. |
| **TSK-027** | Audit Logging (Metadata Only) | Medium | Back-end Engineer | PENDING | TSK-020 | JSON audit log with transfer metadata, zero payload byte storage verified. |
| **TSK-028** | Desktop Renderer Accessibility & Interaction Remediation | High | Front-end Engineer | COMPLETED (RETEST OPEN) | TSK-023, TSK-024 | Semantic landmarks and ARIA labelling across renderer views, no blocking `alert()` dialogs, explicit camera-start consent, keyboard-reachable cancel confirmation, DPR-correct QR rasterization, and no duplicated native window header. |

## Milestone M2: Mobile Receiver Target (iOS via .NET MAUI 10)

| Task ID | Title | Priority | Primary Role | Status | Dependencies | Acceptance Criteria |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **TSK-060** | Protocol Test Vectors & Parity Generator | Critical | System Architect | COMPLETED | TSK-022 | Deterministic TypeScript generator produces 15 binary vectors + `expected.json`; includes all K=5 systematic frames, repair frames, PRNG/Soliton expectations, malformed vectors; regeneration is byte-identical under CI. |
| **TSK-061** | `DEQR.Core` C# Engine & Parity Tests | Critical | Back-end Engineer | COMPLETED | TSK-060 | `net10.0` core compiles and passes mandatory container/frame round-trip parity, C# encoder parity, PRNG/Soliton parity, decoder completion, malformed-input rejection, and vector reproducibility in Stage IOS-1 CI. |
| **TSK-062** | .NET MAUI 10 iOS Application Shell | High | Front-end Engineer | READY | TSK-061 | .NET MAUI solution scaffolded (`mobile/`), iOS privacy declarations (`NSCameraUsageDescription`, Files integration keys), bundle ID `com.mohammadabwini.deqr.receiver`, sandbox directory initialization. |
| **TSK-063** | AVFoundation Camera & Raw Byte QR Capture | High | Front-end Engineer | PENDING | TSK-062 | AVFoundation native camera pipeline, 720p ROI crop, 15–30 FPS decoding with backpressure frame dropping, raw byte extraction. |
| **TSK-064** | Mobile Fountain Reassembly & Security Pipeline | High | Back-end Engineer | PENDING | TSK-061, TSK-063 | Full optical stream reassembly loop in C#, strict bounds checking, session isolation, trailing-byte rejection, and integrity verification. |
| **TSK-065** | iOS Files App Integration & Document Picker | High | Back-end Engineer | PENDING | TSK-064 | Save received files to `/Documents/Received/`, exposed to iOS Files app, plus native document-picker export. |
| **TSK-066** | Mobile End-to-End Physical Acceptance Matrix | High | QA Engineer | PENDING | TSK-064, TSK-065 | Full Windows screen -> iPhone camera optical transfer test suite (clean stream, frame loss, interruption, lifecycle backgrounding, file integrity). |

## Security Tranche (DEFERRED)

| Task ID | Title | Priority | Primary Role | Status | Dependencies |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **TSK-040** | AES-256-GCM Encryption Design Specification | High | Cybersecurity | DEFERRED | TSK-022 |
| **TSK-041** | Encryption Implementation & Key Derivation | High | Back-end Engineer | DEFERRED | TSK-040 |

## Packaging (DEFERRED)

| Task ID | Title | Priority | Primary Role | Status | Dependencies |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **TSK-050** | Portable Windows .exe Packaging | Medium | Back-end Engineer | DEFERRED | TSK-026 |
