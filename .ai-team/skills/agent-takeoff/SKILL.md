---
name: agent-takeoff
description: Bootstraps an agent session by reading project memory, verifying state, and inspecting git baseline.
roles:
  - project-manager
  - system-architect
  - cybersecurity-engineer
  - quality-assurance-engineer
  - frontend-engineer
  - backend-engineer
  - database-administrator
  - ui-ux-designer
  - branding-designer
access: read-only
tools:
  - file-read
  - git-status
---

# Skill: Agent Takeoff

## When to Use
Must be executed at the very start of every agent interaction or session resume.

## When NOT to Use
Do not skip.

## Required Reading
1. `AGENTS.md`
2. `.ai-team/project-control/CURRENT-STATE.md`
3. `.ai-team/project-control/HANDOFF.md`
4. Applicable engineering rules under `.ai-team/engineering/`

## Preconditions
Session initialized.

## Procedure
1. Read root `AGENTS.md`.
2. Read `.ai-team/project-control/CURRENT-STATE.md` to establish current project status.
3. Read `.ai-team/project-control/HANDOFF.md` to retrieve last session handoff context.
4. Inspect repository directory and Git status.
5. Verify actual code state against documentation claims.

## Evidence Requirements
State alignment confirmed.

## Safety Constraints
Do not proceed with work if codebase conflicts with `CURRENT-STATE.md` without reconciling state first.

## Project-Memory Updates
None (read-only takeoff).

## Definition of Done
Project context loaded, state verified, ready to execute assignment.

## Fallback Behavior
Read `AGENTS.md` and `.ai-team/README.md` directly.
