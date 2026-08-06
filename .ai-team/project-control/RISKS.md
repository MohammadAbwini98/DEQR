# Project Risk Register

| Risk ID | Severity | Category | Risk Description | Mitigation Strategy | Owner | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **RSK-001** | High | Security | Optical transfer data exfiltration from isolated workstation. | Mandatory pre-transfer confirmation, file extension blocking (.exe/.ps1), optional AES-256-GCM encryption. | Cybersecurity | OPEN |
| **RSK-002** | Medium | Performance | Camera focus / ambient light blurring QR stream frame decoding. | Adaptive QR density profiles (Reliable, Balanced, Fast), fountain coding drop-tolerance (1.15x redundancy). | QA / Back-end | OPEN |
| **RSK-003** | Medium | Memory | Large binary payload buffering in Electron renderer process. | Worker pool decoding, segment stream chunking (Phase 2 max 250 MB). | System Architect | OPEN |
