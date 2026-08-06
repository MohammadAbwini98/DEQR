---
name: pr-review
description: Conduct multi-specialist pull request review evaluating architecture, security, quality, and UI conformance.
roles:
  - project-manager
  - system-architect
  - cybersecurity-engineer
  - quality-assurance-engineer
access: read-only
tools:
  - file-read
  - git-diff
---

# Skill: PR Review

## When to Use
Use when a feature branch or PR is submitted for integration into main.

## When NOT to Use
Do not use during active implementation before tests pass.

## Required Reading
- `AGENTS.md`
- `.ai-team/engineering/RULES.md`

## Preconditions
PR diff and test logs provided.

## Procedure
1. Verify Architect approval for component contract changes.
2. Verify Security approval for trust boundary or input validation changes.
3. Verify QA approval and green test execution evidence.
4. Verify PR author is not approving their own implementation.
5. Reconcile all reviews into integrated merge decision.

## Evidence Requirements
Integrated review report in `.ai-team/reports/reviews/`.

## Safety Constraints
Do not merge PRs with failing security or quality gates.

## Project-Memory Updates
Log PR status in `.ai-team/project-control/TASK-LOG.md`.

## Definition of Done
All specialist reviews completed, gate decisions recorded, report delivered to PM.

## Fallback Behavior
Manual review of Git diff output.
