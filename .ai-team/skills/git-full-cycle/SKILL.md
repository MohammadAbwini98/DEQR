---
name: git-full-cycle
description: Execute complete Git lifecycle operations following detected repository version control policies.
roles:
  - project-manager
access: conditional
tools:
  - git-status
  - git-commit
  - git-diff
---

# Skill: Git Full Cycle

## When to Use
Use when committing verified task implementations or preparing release commits.

## When NOT to Use
Do not use on unverified code changes or failing test states.

## Required Reading
- `.ai-team/engineering/DEVELOPMENT-WORKFLOW.md`

## Preconditions
All QA and Security tests pass cleanly.

## Procedure
1. Inspect `git status` and `git diff`.
2. Ensure no untracked scratch files, credentials, binary artifacts, or temporary logs are staged.
3. Verify change commit message follows structured format: `feat(scope): summary` or `fix(scope): summary`.
4. Stage verified files explicitly by path.
5. Create atomic commit.

## Evidence Requirements
Commit hash and clean `git status` log.

## Safety Constraints
Never force push, bypass pre-commit hooks, or commit secrets.

## Project-Memory Updates
Log commit hash in `.ai-team/project-control/TASK-LOG.md` and `HANDOFF.md`.

## Definition of Done
Atomic commit created, repository status clean, commit recorded in project memory.

## Fallback Behavior
Report uncommitted changes clearly in `HANDOFF.md`.
