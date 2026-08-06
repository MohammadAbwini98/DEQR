---
name: security-review
description: Audit source code, dependencies, Electron fuses, CSP headers, and offline policies for security vulnerabilities.
roles:
  - cybersecurity-engineer
access: read-only
tools:
  - file-read
  - file-search
---

# Skill: Security Review

## When to Use
Mandatory for every release candidate and security gate check.

## When NOT to Use
Do not skip for production-bound code.

## Required Reading
- `.ai-team/engineering/SECURITY.md`
- `.ai-team/permissions/ROLE-CAPABILITIES.yaml`

## Preconditions
Code implementation completed.

## Procedure
1. Audit Electron security parameters (`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`).
2. Audit Content Security Policy (CSP) headers to ensure zero remote protocol access (`http`, `https`, `ws`, `wss`).
3. Audit dependency manifests (`package.json`) for known vulnerabilities or unauthorized packages.
4. Check code for hardcoded secrets, temporary file leaks, or dangerous shell execution calls (`eval`, `exec`).
5. Issue Security Release Gate assessment.

## Evidence Requirements
Security Review report in `.ai-team/reports/security/` containing severity, scenario, evidence, affected assets, remediation, and residual risk.

## Safety Constraints
Never approve code with unmitigated High or Critical security findings.

## Project-Memory Updates
Log security decision in `.ai-team/project-control/RELEASE-STATUS.md`.

## Definition of Done
Audit complete, evidence documented, gate decision issued, report delivered to PM.

## Fallback Behavior
Manual code review against security checklist.
