---
name: test-and-verify
description: Run automated build and test commands, collecting empirical execution logs and evidence.
roles:
  - quality-assurance-engineer
  - project-manager
access: read-only
tools:
  - run-test
  - file-read
---

# Skill: Test and Verify

## When to Use
Use to verify any code change, feature completion, or release candidate.

## When NOT to Use
Do not use as a substitute for authoring actual test cases.

## Required Reading
- `.ai-team/engineering/TESTING.md`
- `.ai-team/engineering/COMMANDS.md`

## Preconditions
Build system and test runners configured.

## Procedure
1. Execute build command (`npm run build`).
2. Execute unit, integration, and optical protocol test suites (`npm test`).
3. Capture full terminal output logs.
4. Verify 100% pass rate with zero unexpected warnings or uncaught exceptions.
5. Store execution log in `.ai-team/reports/testing/`.

## Evidence Requirements
Raw command output log showing exit code 0 and pass counts.

## Safety Constraints
Never declare tests passed without actual command execution logs.

## Project-Memory Updates
Log test run result in `.ai-team/project-control/RELEASE-STATUS.md`.

## Definition of Done
Commands executed, raw logs captured, zero failures verified.

## Fallback Behavior
Execute test scripts directly via Node CLI.
