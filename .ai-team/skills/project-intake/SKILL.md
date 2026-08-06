---
name: project-intake
description: Intake human product owner requests, inspect active repository state, and establish project baseline.
roles:
  - project-manager
access: read-only
tools:
  - file-read
  - file-search
  - git-status
---

# Skill: Project Intake

## When to Use
Use when a human product owner submits a new request, feature idea, bug report, or project direction update.

## When NOT to Use
Do not use during active subtask execution by specialist agents.

## Required Reading
- `AGENTS.md`
- `.ai-team/project-control/CURRENT-STATE.md`
- `.ai-team/engineering/ARCHITECTURE.md`

## Preconditions
Repository workspace is accessible.

## Procedure
1. Parse human request to extract objectives, constraints, and non-functional requirements.
2. Inspect repository files and Git status to determine current baseline.
3. Compare prompt objectives against `.ai-team/project-control/CURRENT-STATE.md`.
4. Identify affected engineering disciplines (Architect, Front-end, Back-end, Security, QA, DBA, UI/UX, Branding).
5. Record intake entry in `.ai-team/project-control/BACKLOG.md`.

## Evidence Requirements
Captured prompt summary and baseline file inventory.

## Safety Constraints
Do not promise scope or timeline commitments without specialist analysis.

## Project-Memory Updates
Update `.ai-team/project-control/CURRENT-STATE.md` with active request status.

## Definition of Done
Intake entry logged in backlog, scope understood, initial specialist selection determined.

## Fallback Behavior
If Git tools are unavailable, perform file system inspection using directory tools.
