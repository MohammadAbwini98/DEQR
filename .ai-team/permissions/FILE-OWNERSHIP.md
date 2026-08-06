# File Ownership Boundaries

| Directory / File Pattern | Exclusive Owner Role | Secondary Readers |
| :--- | :--- | :--- |
| `.ai-team/project-control/*` | Project Manager | All roles |
| `.ai-team/engineering/ARCHITECTURE.md` | System Architect | All roles |
| `.ai-team/engineering/SECURITY.md` | Cybersecurity Engineer | All roles |
| `.ai-team/engineering/TESTING.md` | QA Engineer | All roles |
| `.ai-team/engineering/DATABASE.md` | DBA | All roles |
| `.ai-team/engineering/UI-UX.md` | UI/UX Designer | All roles |
| `.ai-team/engineering/BRANDING.md` | Branding Designer | All roles |
| `src/main/*`, `src/preload/*`, `src/core/*` | Back-end Engineer | Architect, Security, QA |
| `src/renderer/*` | Front-end Engineer | UI/UX, Branding, QA |
| `src/storage/*` | DBA | Back-end Engineer |
| `tests/*` | QA Engineer | Front-end / Back-end |
