---
name: frontend-ui-ux
description: Implement UI components, user flows, accessibility properties, and interaction states.
roles:
  - frontend-engineer
  - ui-ux-designer
access: conditional
tools:
  - file-read
  - file-edit
---

# Skill: Front-end UI/UX

## When to Use
Use when building or modifying React UI components, layout structures, user interaction flows, or accessibility properties.

## When NOT to Use
Do not use for back-end node main process or optical fountain protocol coding.

## Required Reading
- `.ai-team/engineering/UI-UX.md`
- `.ai-team/engineering/BRANDING.md`

## Preconditions
UI spec approved by UI/UX designer.

## Procedure
1. Create or update React components adhering to component tree structure.
2. Ensure components handle all user states: empty, loading, active transfer, success, warning, and error.
3. Add accessibility attributes (`aria-label`, keyboard focus rings, semantic tags).
4. Verify visual hierarchy and responsive window resizing behavior.
5. Execute component tests.

## Evidence Requirements
Component test log and UI state verification.

## Safety Constraints
Do not hardcode pixel layout offsets dynamically computed elements. Use CSS flexbox/grid layout design.

## Project-Memory Updates
Log progress to PM.

## Definition of Done
React UI components built, states verified, accessibility validated, tests pass.

## Fallback Behavior
Build standard accessible HTML elements with CSS modules.
