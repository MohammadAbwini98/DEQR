# DEQR Risk Register

| Risk ID | Category | Description | Impact | Likelihood | Mitigation | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **RSK-001** | Security | Unencrypted optical streams can be intercepted by unauthorized cameras. | High | Medium | Defer encryption to post-M1 security tranche (ADR-003). Emphasize physical security in M1. | ACCEPTED FOR M1 |
| **RSK-002** | Reliability | Luby Transform codes struggle to achieve full recovery at very low block counts (K < 100) without high frame overheads. | Medium | High | Mitigated via Systematic Fountain Mode prefix (ADR-004), guaranteeing source blocks are sent first. UI continuous streaming handles the remainder. | MITIGATED |
| **RSK-003** | Performance | High frame rates (60fps+) with dense QR codes may exceed WASM decoding thread capacity on low-end hardware. | Medium | Medium | Implement adaptive FPS and density controls in M2. | OPEN (M2) |
| **RSK-004** | Acceptance | Local HTTPS SAN readiness cannot prove iPhone CA trust, firewall reachability, standalone installation, camera behavior, offline shell, export, or optical byte/hash fidelity. | High | High | Execute and preserve trusted physical-iPhone acceptance evidence for WEB-IOS-10. | OPEN — NOT EXECUTED |
| **RSK-005** | Release integrity | No current portable artifact exists for ASAR/fuse integrity or packaged-renderer verification. | High | Medium | Create an authorized package and independently verify packaged renderer plus Electron fuse/ASAR controls. | OPEN — NOT EXECUTED |
| **RSK-006** | Privacy / retention | Failed PWA verification retains transfer blocks until reset; metadata-only history policy is not decided. | Medium | Medium | Clear failed receiver state and make an explicit no-payload persistence decision under WEB-IOS-DATA-004. | OPEN |
| **RSK-007** | Web hardening | Development-compatible CSP still permits `script-src 'unsafe-inline'`; deployed PWA response-header boundary is unspecified. | Medium | Medium | Validate and tighten CSP under WEB-IOS-SEC-003 without breaking Vite/Safari behavior. | OPEN |
