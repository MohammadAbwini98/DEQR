---
name: feature-implementation
description: Implement bounded new features according to technical specifications, architectural contracts, and safety rules.
roles:
  - frontend-engineer
  - backend-engineer
access: workspace-write
tools:
  - file-read
  - file-edit
  - file-create
---

# Skill: Feature Implementation

## When to Use
Use when assigned a bounded feature implementation by the Project Manager.

## When NOT to Use
Do not use without explicit PM bounded write assignment and defined owned files.

## Required Reading
- Assigned task scope in `.ai-team/project-control/ASSIGNMENTS.json`
- `.ai-team/engineering/ARCHITECTURE.md`
- `.ai-team/engineering/RULES.md`

## Preconditions
Architecture and UI specs approved; file bounds assigned.

## Procedure
1. Verify owned files and exact assignment parameters.
2. Implement feature logic adhering to TypeScript types, clean architecture, and error handling.
3. Keep changes minimal, modular, and limited strictly to owned files.
4. Run localized build or unit tests to verify implementation.
5. Submit implementation report with verification evidence to PM.

## Evidence Requirements
Build log output and passing test logs.

## Safety Constraints
Do not edit files outside assigned ownership. Do not add unapproved NPM packages.

## Project-Memory Updates
Log progress report to PM.

## Definition of Done
Feature code written, compiles cleanly, unit tests pass, evidence submitted to PM.

## Fallback Behavior
Manual file creation and edit within assigned bounds.
