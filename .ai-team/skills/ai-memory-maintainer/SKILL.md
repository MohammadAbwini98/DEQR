---
name: ai-memory-maintainer
description: Maintain durable project memory across sessions, logging decisions, state shifts, and task outcomes.
roles:
  - project-manager
access: workspace-write
tools:
  - file-read
  - file-edit
---

# Skill: AI Memory Maintainer

## When to Use
Use at task conclusion or when architecture, rules, or status change.

## When NOT to Use
Do not use to write temporary scratch notes.

## Required Reading
- `.ai-team/project-control/CURRENT-STATE.md`
- `.ai-team/project-control/TASK-LOG.md`
- `.ai-team/project-control/DECISIONS.md`

## Preconditions
Task outcome or architectural decision established.

## Procedure
1. Update `.ai-team/project-control/CURRENT-STATE.md` with active project milestone, completed tasks, and next focus.
2. Append completed task details into `.ai-team/project-control/TASK-LOG.md`.
3. Log any architecture decision records in `.ai-team/project-control/DECISIONS.md`.
4. Update `.ai-team/project-control/KNOWN-ISSUES.md` and `RISKS.md` if defects or risks were uncovered.
5. Execute AI doctor validator (`scripts/ai/doctor`).

## Evidence Requirements
Updated project control files matching actual repository state.

## Safety Constraints
Never record passwords, credentials, API keys, or machine-specific absolute paths in memory.

## Project-Memory Updates
Synchronizes all `.ai-team/project-control/*` files.

## Definition of Done
Durable memory files updated, validated via doctor script.

## Fallback Behavior
Update `CURRENT-STATE.md` manually.
