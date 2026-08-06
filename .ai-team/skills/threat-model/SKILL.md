---
name: threat-model
description: Perform STRIDE threat modeling on application components, trust boundaries, and data flows.
roles:
  - cybersecurity-engineer
access: read-only
tools:
  - file-read
  - file-search
---

# Skill: Threat Model

## When to Use
Use when adding new IPC bridges, optical transfer frame header extensions, payload encryption options, or file I/O operations.

## When NOT to Use
Do not use for CSS/visual theme updates.

## Required Reading
- `.ai-team/engineering/SECURITY.md`
- `.ai-team/templates/THREAT-MODEL.md`

## Preconditions
Component data flow diagram or architecture spec available.

## Procedure
1. Identify trust boundaries (Renderer vs Preload Bridge vs Main Process vs External Screen/Camera).
2. Analyze threat categories: Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege.
3. Assess payload leakage risk via screen capture or camera interception.
4. Evaluate encryption controls (AES-256-GCM) and hash verification (SHA-256).
5. Output formal threat model using `.ai-team/templates/THREAT-MODEL.md`.

## Evidence Requirements
Threat model document stored in `.ai-team/reports/security/`.

## Safety Constraints
Do not assume physical optical channel provides confidentiality without payload encryption.

## Project-Memory Updates
Log security risks in `.ai-team/project-control/RISKS.md`.

## Definition of Done
Threat model report created, mitigations defined, delivered to PM.

## Fallback Behavior
Document threats in markdown report.
