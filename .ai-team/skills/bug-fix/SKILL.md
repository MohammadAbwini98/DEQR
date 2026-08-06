---
name: bug-fix
description: Reproduce defects, perform root-cause analysis, implement targeted minimal corrections, and add regression tests.
roles:
  - frontend-engineer
  - backend-engineer
  - database-administrator
access: workspace-write
tools:
  - file-read
  - file-edit
  - run-test
---

# Skill: Bug Fix

## When to Use
Use when repairing confirmed software defects or test failures.

## When NOT to Use
Do not use to introduce unapproved feature enhancements.

## Required Reading
- Defect report / log output
- `.ai-team/engineering/TESTING.md`

## Preconditions
Bug reproduction steps or failing test case established.

## Procedure
1. Reproduce defect using automated test or script.
2. Analyze root cause tracing exact failure traceback in logs.
3. Apply minimal, precise code fix resolving root cause without side effects.
4. Add regression test covering exact failure scenario.
5. Execute full relevant test suite to confirm fix and zero regression.

## Evidence Requirements
Failing test log before fix + passing test log after fix.

## Safety Constraints
Do not fix bugs by masking symptoms, commenting out broken assertions, or swallowing errors silently.

## Project-Memory Updates
Log fix details in `.ai-team/project-control/TASK-LOG.md`.

## Definition of Done
Bug fixed, regression test added, test suite passing cleanly, report delivered to PM.

## Fallback Behavior
Isolate defect using targeted log statements before editing code.
