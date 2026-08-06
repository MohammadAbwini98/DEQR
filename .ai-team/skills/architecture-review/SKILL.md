---
name: architecture-review
description: Review proposed architecture changes for modularity, IPC safety, performance, and contract compliance.
roles:
  - system-architect
access: read-only
tools:
  - file-read
  - file-search
---

# Skill: Architecture Review

## When to Use
Use when component boundaries, IPC interfaces, protocol schemas, or core storage models change.

## When NOT to Use
Do not use for minor localized bug fixes.

## Required Reading
- `.ai-team/engineering/ARCHITECTURE.md`
- `init.md`

## Preconditions
Architecture proposal or PR submitted.

## Procedure
1. Inspect component boundary changes and IPC channel contracts.
2. Evaluate impact on offline operation, memory usage, and optical stream encoding throughput.
3. Verify modular separation between Renderer, Preload Bridge, Electron Main Process, and Optical Transfer Core.
4. Author ADR if new architectural patterns are introduced.

## Evidence Requirements
Architecture review report in `.ai-team/reports/architecture/`.

## Safety Constraints
Reject proposals introducing tight coupling between Renderer and Electron Main process.

## Project-Memory Updates
Log ADR in `.ai-team/project-control/DECISIONS.md`.

## Definition of Done
Architecture report complete, ADR created if necessary, delivered to PM.

## Fallback Behavior
Document architecture findings directly in review report.
