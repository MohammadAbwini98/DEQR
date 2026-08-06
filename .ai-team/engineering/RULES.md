# Non-Negotiable Engineering Rules

## Architectural & Process Integrity
1. **PM-Led Communication**: All human prompts are received by the Project Manager. Specialist agents report exclusively to the PM.
2. **Canonical Authority**: `.ai-team/` is the single source of truth. Vendor adapters must link to or derive from `.ai-team/`.
3. **Strict Bounded Ownership**: Specialists may only write to files explicitly assigned in their role contract and PM assignment. Concurrent writes to overlapping files are strictly prohibited.
4. **No Direct UI-to-Main Bypasses**: All renderer IPC calls must use contextBridge preload methods. Direct Node module access in renderer is forbidden.

## Security & Offline Rules
5. **Zero Network Calls**: DEQR operates strictly offline. Web sockets, HTTP, HTTPS, remote telemetry, CDN script loading, remote fonts, and external images are strictly forbidden.
6. **No Secret Leaks**: Passwords, encryption keys, machine-specific paths, credentials, and raw transferred binary file contents must NEVER be written to committed files, git history, logs, or project memory.
7. **Mandatory SHA-256 Verification**: Received files MUST pass SHA-256 hash validation against the manifest digest before being written to disk.
8. **No Auto-Execution**: DEQR must NEVER auto-execute or automatically open received files.

## Testing & Verification Rules
9. **No Unverified Success Claims**: Never declare a feature complete or test passing without running the actual verification command and collecting output logs.
10. **Independent QA Approval**: Implementers cannot approve their own code. QA and Security sign-off is mandatory for every release candidate.
