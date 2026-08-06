---
name: agent-handoff
description: Package active context, uncommitted work, verification results, and next steps into a clean handoff state.
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
access: workspace-write
tools:
  - file-read
  - file-edit
---

# Skill: Agent Handoff

## When to Use
Use when pausing, completing, or transferring work between agents or sessions.

## When NOT to Use
Do not use in the middle of unverified code modifications.

## Required Reading
- `.ai-team/templates/HANDOFF.md`
- `.ai-team/project-control/HANDOFF.md`

## Preconditions
Current task state evaluated.

## Procedure
1. Record active assignment ID and title.
2. List all completed work items and modified files.
3. Record exact execution results of all test commands run.
4. Note remaining risks, blockers, and do-not-touch areas.
5. Write handoff record into `.ai-team/project-control/HANDOFF.md` using `.ai-team/templates/HANDOFF.md`.

## Evidence Requirements
Complete `HANDOFF.md` file populating all required sections.

## Safety Constraints
Never include secrets, tokens, or private paths in handoff documents.

## Project-Memory Updates
Overwrites `.ai-team/project-control/HANDOFF.md`.

## Definition of Done
Handoff document updated, clean workspace state recorded.

## Fallback Behavior
Write raw markdown summary to `.ai-team/project-control/HANDOFF.md`.
