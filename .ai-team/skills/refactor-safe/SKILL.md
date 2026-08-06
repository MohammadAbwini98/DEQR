---
name: refactor-safe
description: Safely restructure code without altering external behavior, ensuring 100% test suite pass rate.
roles:
  - system-architect
  - frontend-engineer
  - backend-engineer
access: workspace-write
tools:
  - file-read
  - file-edit
  - run-test
---

# Skill: Refactor Safe

## When to Use
Use when improving code structure, modularity, readability, or performance without changing observable behavior.

## When NOT to Use
Do not use when unit test coverage is absent or failing.

## Required Reading
- `.ai-team/engineering/RULES.md`
- Baseline test suite results

## Preconditions
Complete passing test suite verified prior to starting refactor.

## Procedure
1. Run existing unit test suite to establish green baseline.
2. Apply refactoring step by step in small incremental chunks.
3. Re-run test suite after every step to ensure behavior remains identical.
4. Verify public function signatures and exported API contracts remain unmodified.
5. Report refactor completion with before/after execution metrics.

## Evidence Requirements
Green test runner logs before and after refactoring.

## Safety Constraints
Do not change API contracts or database schemas during a refactor.

## Project-Memory Updates
Log refactor details in `TASK-LOG.md`.

## Definition of Done
Refactoring completed, all baseline tests pass cleanly, no regressions introduced.

## Fallback Behavior
Revert refactor if tests fail and cause cannot be immediately identified.
