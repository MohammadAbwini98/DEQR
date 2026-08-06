---
name: codebase-review
description: Perform targeted code review inspecting quality, adherence to rules, safety, and performance.
roles:
  - project-manager
  - system-architect
  - cybersecurity-engineer
  - quality-assurance-engineer
  - frontend-engineer
  - backend-engineer
access: read-only
tools:
  - file-read
  - file-search
  - git-diff
---

# Skill: Codebase Review

## When to Use
Use prior to merging feature or bug-fix implementations into baseline.

## When NOT to Use
Do not use on empty unwritten files.

## Required Reading
- `.ai-team/engineering/RULES.md`
- `.ai-team/engineering/ARCHITECTURE.md`

## Preconditions
Source changes prepared.

## Procedure
1. Inspect Git diff or target source files.
2. Verify code adheres to non-negotiable rules in `.ai-team/engineering/RULES.md`.
3. Check for syntax errors, missing type annotations, swallowed exceptions, or dead code.
4. Verify error handling, null safety, and boundary checks.
5. Generate review report listing findings, severity, and required remediation.

## Evidence Requirements
Code review report formatted per `.ai-team/templates/FINDING.md`.

## Safety Constraints
Do not approve code containing unhandled promises, secret leaks, or missing input validation.

## Project-Memory Updates
Log review report in `.ai-team/reports/reviews/`.

## Definition of Done
Codebase review report completed, findings categorized, sent to PM.

## Fallback Behavior
Manual file diff inspection.
