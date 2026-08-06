# Workflow: Security Review

## Execution Sequence

1. **Trigger**: Feature completion, dependency update, protocol modification, or release candidate build.
2. **Audit Parameters**:
   - Electron Fuses & Sandbox configuration
   - Content Security Policy (CSP) headers & protocol restriction
   - Input validation & binary buffer safety
   - AES-256-GCM crypto logic & SHA-256 integrity verifier
   - Secret leak audit & dependency safety
3. **Deliverable**: Security Finding / Threat Model report stored in `.ai-team/reports/security/`.
4. **Gate Decision**: Issued as PASS, CONDITIONAL, or FAIL in `.ai-team/project-control/RELEASE-STATUS.md`.
