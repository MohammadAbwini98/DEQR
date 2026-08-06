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
