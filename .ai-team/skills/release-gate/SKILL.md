---
name: release-gate
description: Evaluate total release readiness, synthesizing QA, Security, Architecture, and DBA sign-offs.
roles:
  - project-manager
  - quality-assurance-engineer
  - cybersecurity-engineer
  - system-architect
access: read-only
tools:
  - file-read
  - run-doctor
---

# Skill: Release Gate

## When to Use
Mandatory before recommending any candidate build or project milestone for release to the human product owner.

## When NOT to Use
Do not use during initial intake or draft development phases.

## Required Reading
- `.ai-team/project-control/RELEASE-STATUS.md`
- `.ai-team/reports/security/*`
- `.ai-team/reports/testing/*`

## Preconditions
Implementation, QA suite execution, and security review completed.

## Procedure
1. Synthesize individual gate reports:
   - QA Gate Status (PASS / FAIL)
   - Security Gate Status (PASS / FAIL)
   - Architecture Conformance (PASS / FAIL)
   - DB / Schema Integrity (PASS / FAIL)
2. Compile release evaluation report using mandatory release format (Release status: PASS | CONDITIONAL | FAIL).
3. Ensure zero unverified items or unexecuted tests are marked as passing.
4. Document all known defects, residual risks, and rollback plans.
5. Deliver recommendation to Project Manager for human presentation.

## Evidence Requirements
Complete Release Evaluation report in `.ai-team/project-control/RELEASE-STATUS.md`.

## Safety Constraints
No agent may convert an unexecuted check into a pass.

## Project-Memory Updates
Updates `.ai-team/project-control/RELEASE-STATUS.md`.

## Definition of Done
Release gate synthesis completed, formal report signed off, delivered to PM.

## Fallback Behavior
Issue CONDITIONAL or FAIL status if evidence is incomplete.
