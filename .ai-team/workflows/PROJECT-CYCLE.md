# Workflow: Full Project Lifecycle

```text
Intake
→ Repository and state inspection
→ Requirements and acceptance criteria
→ Architecture / security / data / UI analysis
→ Integrated plan
→ Human approval where required
→ Bounded implementation
→ Independent QA / security / architecture review
→ Remediation
→ Re-verification
→ Project-memory update
→ Consolidated PM report
```

## Detailed Execution Steps

1. **Intake Phase**: PM reads human prompt, inspects baseline repository state, and logs intake record.
2. **Analysis Phase**:
   - Architect evaluates boundary & IPC impact.
   - Cybersecurity Engineer evaluates threat vectors & offline controls.
   - UI/UX & Branding evaluate design specs (if visual).
   - DBA evaluates storage & audit schema.
3. **Planning & Approval**: PM creates bounded subtasks in `BACKLOG.md` & `ASSIGNMENTS.json`. If major scope/architecture changes are involved, PM requests Human approval.
4. **Bounded Implementation**: PM activates Front-end / Back-end implementers with strict file ownership. Implementers write code & local unit tests.
5. **Independent Review**:
   - QA runs automated test runner and generates test report.
   - Cybersecurity audits security posture and issues security gate report.
   - Architect verifies contract compliance.
6. **Remediation & Re-verification**: Implementers fix any failed gate findings; QA & Security re-verify.
7. **Memory Update**: PM updates `CURRENT-STATE.md`, `TASK-LOG.md`, and runs `scripts/ai/doctor`.
8. **Consolidated PM Report**: PM presents clean final status report to the Human Product Owner.
