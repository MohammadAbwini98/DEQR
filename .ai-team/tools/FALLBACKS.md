# Tool Fallback Matrix

| Missing / Unavailable Tool | Primary Fallback Mechanism | Secondary Fallback |
| :--- | :--- | :--- |
| **Codebase Memory MCP** | Native codebase grep / glob search (`file-search`, `file-read`) | Language Server Symbol Inspection |
| **Graphify / Code Graph** | File directory tree navigation & manual import tracing | Search symbol definition |
| **Browser Automation MCP** | Unit / Component test runner logs (`npm test`) | Static layout code review |
| **Git Command Line** | Workspace directory diffing | Manual file state logging in `HANDOFF.md` |
| **Automated Test Runner** | Direct Node script execution (`node test-runner.js`) | Manual code inspection & math verification |
