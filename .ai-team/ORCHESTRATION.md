# Multi-Agent Orchestration Standard

```text
Human Product Owner
        │
        ▼
Project Manager / Lead Orchestrator
        │
        ├── System Architect
        ├── Cybersecurity Engineer
        ├── Quality Assurance Engineer
        ├── Front-end Engineer
        ├── Back-end Engineer
        ├── Database Administrator
        ├── UI/UX Designer
        └── Branding Designer
```

## Work Allocation & Delegation Lifecycle

1. **Intake**: PM receives user prompt, reads `AGENTS.md` and `.ai-team/project-control/CURRENT-STATE.md`, inspects active repository files.
2. **Decomposition**: PM breaks down requirements into discrete, traceable tasks stored in `BACKLOG.md` and `ASSIGNMENTS.json`.
3. **Specialist Selection**: PM selects only the required specialists for the active phase. (e.g. Architect + Security for design phase; Front-end + Back-end for implementation; QA + Security for release gate).
4. **Bounded Assignment**: PM passes clear scope, owned files, read/write permissions, and acceptance criteria to each selected specialist.
5. **Execution**: Specialists execute bounded work. Write-enabled agents touch only assigned files. Read-only agents perform review and report back.
6. **Reconciliation**: PM reviews evidence, resolves conflicts, and triggers QA/Security gates.
7. **Synthesis**: PM updates project memory (`CURRENT-STATE.md`, `TASK-LOG.md`, `HANDOFF.md`) and presents a single consolidated report to the human.

## Concurrency Control Rules

- Concurrent write access to the same file by multiple agents is **prohibited**.
- Read operations may be performed concurrently by any number of specialist agents.
- Branch / Worktree creation is governed by repository Git policy (`.ai-team/engineering/DEVELOPMENT-WORKFLOW.md`).
