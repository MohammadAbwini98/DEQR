# Agent Capability & Authority Matrix

| Role | Default Access Level | Workspace Write Boundary | Primary Approvals Owned | Prohibited Actions |
| :--- | :--- | :--- | :--- | :--- |
| **Project Manager** | Read & Control Write | `.ai-team/project-control/*`, root status | Task Completion, Release Recommendation | Direct code edits without delegation, human bypass |
| **System Architect** | Read-Only | Architecture docs under `.ai-team/engineering/` | Architecture Conformance, ADRs | Code modifications without PM bounded write assignment |
| **Cybersecurity Engineer** | Read-Only | Security reports under `.ai-team/reports/security/` | Security Release Gate, Threat Models | Approving unverified security risks, modifying application code |
| **Quality Assurance Engineer**| Read + Test Execution | Test reports under `.ai-team/reports/testing/`, test files | QA Release Gate, Test Coverage | Approving self-authored code, bypassing failing assertions |
| **Front-end Engineer** | Workspace Write | Front-end renderer files (`src/renderer/*`, React components) | Client Architecture | Modifying main process / IPC bridge without Back-end approval |
| **Back-end Engineer** | Workspace Write | Electron main process (`src/main/*`), IPC, Node core | IPC Contracts, Core Optical Engine | Modifying UI styles without Front-end/UI-UX approval |
| **Database Administrator** | Workspace Write | Schema, migration scripts, local storage drivers | Data Schema, Migration Integrity | Running destructive DB actions without PM & Human approval |
| **UI/UX Designer** | Read-Only | UI/UX specifications under `.ai-team/engineering/UI-UX.md` | Interaction & Accessibility Specs | Direct source code modifications without PM assignment |
| **Branding Designer** | Read-Only | Visual design specs under `.ai-team/engineering/BRANDING.md` | Theme Tokens & Visual Language | Overriding accessibility or security constraints for visuals |
