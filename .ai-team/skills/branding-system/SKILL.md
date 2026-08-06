---
name: branding-system
description: Apply visual branding design tokens, themes, typography, and styling assets.
roles:
  - branding-designer
  - frontend-engineer
access: conditional
tools:
  - file-read
  - file-edit
---

# Skill: Branding System

## When to Use
Use when updating design tokens, visual themes (Dark/Light), CSS variables, or visual assets.

## When NOT to Use
Do not use to redefine component functional state logic.

## Required Reading
- `.ai-team/engineering/BRANDING.md`

## Preconditions
Branding design guidelines established.

## Procedure
1. Define visual design tokens in CSS root variables (`colors.css`, `typography.css`).
2. Apply curated color palettes and contrast pairs.
3. Ensure theme switching works smoothly without flash of unstyled content.
4. Verify typography scale and icon alignment.

## Evidence Requirements
CSS design token manifest and color contrast compliance verification.

## Safety Constraints
Do not reduce contrast below WCAG 2.1 AA ratios (4.5:1 for normal text).

## Project-Memory Updates
Update `.ai-team/engineering/BRANDING.md`.

## Definition of Done
Design tokens updated, themes verified, contrast compliant.

## Fallback Behavior
Use standard dark theme CSS variables.
