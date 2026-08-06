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
