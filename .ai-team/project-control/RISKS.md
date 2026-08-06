# DEQR Risk Register

| Risk ID | Category | Description | Impact | Likelihood | Mitigation | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **RSK-001** | Security | Unencrypted optical streams can be intercepted by unauthorized cameras. | High | Medium | Defer encryption to post-M1 security tranche (ADR-003). Emphasize physical security in M1. | ACCEPTED FOR M1 |
| **RSK-002** | Reliability | Luby Transform codes struggle to achieve full recovery at very low block counts (K < 100) without high frame overheads. | Medium | High | Mitigated via Systematic Fountain Mode prefix (ADR-004), guaranteeing source blocks are sent first. UI continuous streaming handles the remainder. | MITIGATED |
| **RSK-003** | Performance | High frame rates (60fps+) with dense QR codes may exceed WASM decoding thread capacity on low-end hardware. | Medium | Medium | Implement adaptive FPS and density controls in M2. | OPEN (M2) |
