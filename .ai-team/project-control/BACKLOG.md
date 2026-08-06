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

## Milestone M2: Camera Capture & Full Sender/Receiver (DEFERRED)

| Task ID | Title | Priority | Primary Role | Status | Dependencies |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **TSK-030** | Camera Capture & Media Stream Integration | High | Front-end Engineer | DEFERRED | TSK-026 |
| **TSK-031** | WASM QR Decoding Worker Pool (zxing-wasm) | High | Back-end Engineer | DEFERRED | TSK-026 |
| **TSK-032** | Transfer History List View | Medium | Front-end Engineer | DEFERRED | TSK-027 |
| **TSK-033** | Settings Panel | Medium | Front-end Engineer | DEFERRED | TSK-020 |
| **TSK-034** | Adaptive FPS & QR Density Controls | Medium | Back-end Engineer | DEFERRED | TSK-031 |

## Security Tranche (DEFERRED)

| Task ID | Title | Priority | Primary Role | Status | Dependencies |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **TSK-040** | AES-256-GCM Encryption Design Specification | High | Cybersecurity | DEFERRED | TSK-022 |
| **TSK-041** | Encryption Implementation & Key Derivation | High | Back-end Engineer | DEFERRED | TSK-040 |

## Packaging (DEFERRED)

| Task ID | Title | Priority | Primary Role | Status | Dependencies |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **TSK-050** | Portable Windows .exe Packaging | Medium | Back-end Engineer | DEFERRED | TSK-026 |
