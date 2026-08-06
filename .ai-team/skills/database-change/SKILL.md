---
name: database-change
description: Execute safe schema modifications, data migrations, and storage indexing.
roles:
  - database-administrator
access: workspace-write
tools:
  - file-read
  - file-edit
  - run-test
---

# Skill: Database Change

## When to Use
Use when modifying local storage data schemas, audit logging structures, or config storage formats.

## When NOT to Use
Do not use without explicit DBA role assignment and rollback plan.

## Required Reading
- `.ai-team/engineering/DATABASE.md`

## Preconditions
Schema change proposal approved by DBA & Architect.

## Procedure
1. Create backward-compatible schema modification.
2. Write automated migration and rollback scripts.
3. Verify audit history data sanitization (ensure binary payloads are NEVER stored in logs).
4. Run database migration tests.

## Evidence Requirements
Passing migration and rollback test logs.

## Safety Constraints
Never execute destructive schema changes without explicit PM approval and confirmed backup/rollback path.

## Project-Memory Updates
Update `.ai-team/engineering/DATABASE.md`.

## Definition of Done
Schema changed, migration verified, zero payload leakage confirmed, tests pass.

## Fallback Behavior
Maintain versioned JSON storage files.
