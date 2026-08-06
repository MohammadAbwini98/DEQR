---
name: docs-sync
description: Synchronize canonical documentation, engineering specifications, and vendor adapters after code changes.
roles:
  - project-manager
access: workspace-write
tools:
  - file-read
  - file-edit
  - sync-adapters
---

# Skill: Docs Sync

## When to Use
Use following any architecture, feature, command, or workflow modification.

## When NOT to Use
Do not use to invent undocumented code behavior.

## Required Reading
- `.ai-team/engineering/*`
- `AGENTS.md`

## Preconditions
Code changes verified.

## Procedure
1. Update corresponding `.ai-team/engineering/` documents (ARCHITECTURE.md, COMMANDS.md, RULES.md, etc.).
2. Update root `AGENTS.md` if non-negotiable rules or project entry points changed.
3. Run `node scripts/ai/sync-adapters.js` to ensure vendor adapters remain synchronized.
4. Run `node scripts/ai/check-adapter-drift.js` to confirm zero documentation drift.

## Evidence Requirements
Clean output from drift check script.

## Safety Constraints
Do not maintain conflicting versions of rules across vendor adapters.

## Project-Memory Updates
Synchronizes documentation across `.ai-team/` and vendor files.

## Definition of Done
Engineering docs updated, adapters synchronized, drift check passes cleanly.

## Fallback Behavior
Manually verify vendor adapter pointers match `.ai-team/`.
