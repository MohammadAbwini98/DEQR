# Workflow: Agent Handoff

## Procedure

1. Active agent executes `agent-handoff` skill.
2. Complete current assignment summary, changed files, test output results, remaining risks, and next steps.
3. Save structured handoff document to `.ai-team/project-control/HANDOFF.md`.
4. Update `CURRENT-STATE.md` and `TASK-LOG.md`.
5. Run `scripts/ai/doctor` to confirm project control health.
