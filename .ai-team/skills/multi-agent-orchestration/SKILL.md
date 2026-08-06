---
name: multi-agent-orchestration
description: Coordinate execution across specialist roles, enforce file boundaries, and collect findings.
roles:
  - project-manager
access: workspace-write
tools:
  - file-read
  - file-edit
  - task-delegate
---

# Skill: Multi-Agent Orchestration

## When to Use
Use to activate specialist subagents and manage concurrent or sequential execution phases.

## When NOT to Use
Do not use when performing simple single-file project control updates.

## Required Reading
- `.ai-team/ORCHESTRATION.md`
- `.ai-team/CAPABILITY-MATRIX.md`
- `.ai-team/project-control/ASSIGNMENTS.json`

## Preconditions
Tasks defined in `ASSIGNMENTS.json`.

## Procedure
1. Identify unblocked assignments in `ASSIGNMENTS.json`.
2. Dispatch subagent assignments with bounded context (role contract, inputs, owned files, acceptance criteria).
3. Monitor subagent outputs and inspect returned deliverables/logs.
4. Verify subagents did not touch files outside their assigned ownership boundary.
5. Reconcile findings and resolve inter-role conflicts.

## Evidence Requirements
Specialist finding reports and verified deliverable outputs.

## Safety Constraints
Never allow specialist subagents to contact the human directly.

## Project-Memory Updates
Log progress in `.ai-team/project-control/TASK-LOG.md`.

## Definition of Done
All dispatched specialist subtasks complete, evidence verified, findings reconciled.

## Fallback Behavior
Execute specialist workflows sequentially if parallel execution is unsupported.
