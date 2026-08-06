---
name: project-planning
description: Decompose project intake into traceable work items with owned files, acceptance criteria, and dependencies.
roles:
  - project-manager
access: workspace-write
tools:
  - file-read
  - file-edit
---

# Skill: Project Planning

## When to Use
Use immediately following project intake to create structured task breakdowns.

## When NOT to Use
Do not use during mid-execution bug hotfixes unless scope changes significantly.

## Required Reading
- `.ai-team/project-control/BACKLOG.md`
- `.ai-team/permissions/FILE-OWNERSHIP.md`

## Preconditions
Intake step completed.

## Procedure
1. Break intake item into discrete subtasks.
2. Assign each subtask to a single primary specialist role.
3. Define exact file ownership boundaries for write-enabled specialists.
4. Define concrete acceptance criteria and required verification commands for each task.
5. Record tasks in `.ai-team/project-control/BACKLOG.md` and `.ai-team/project-control/ASSIGNMENTS.json`.

## Evidence Requirements
Valid task entries created in `BACKLOG.md` and `ASSIGNMENTS.json`.

## Safety Constraints
Never assign overlapping file ownership to multiple write-enabled agents concurrently.

## Project-Memory Updates
Update `BACKLOG.md` and `ASSIGNMENTS.json`.

## Definition of Done
All work items assigned, file bounds defined, dependencies mapped.

## Fallback Behavior
Use `BACKLOG.md` as sole tracker if JSON tool unavailable.
