# DEQR Multi-Agent Engineering Architecture (.ai-team)

Welcome to the canonical AI engineering system for **DEQR** (Desktop Optical Transfer via Fountain-Coded Animated QR Stream).

This directory (`.ai-team/`) serves as the single, authoritative, vendor-neutral source of truth for all AI coding agents working on this project (Claude Code, OpenAI Codex, Gemini CLI, Google Antigravity, Cursor, etc.).

## Directory Overview

```text
.ai-team/
├── README.md                   # System introduction and index
├── TEAM-CHARTER.md             # Core charter and PM-led operating principles
├── ORCHESTRATION.md            # Hub-and-spoke multi-agent interaction rules
├── CAPABILITY-MATRIX.md        # Specialist role permissions and scope limits
│
├── roles/                      # 9 Explicit Role Contracts
│   ├── project-manager.md
│   ├── system-architect.md
│   ├── cybersecurity-engineer.md
│   ├── quality-assurance-engineer.md
│   ├── frontend-engineer.md
│   ├── backend-engineer.md
│   ├── database-administrator.md
│   ├── ui-ux-designer.md
│   └── branding-designer.md
│
├── skills/                     # 22 Standalone Skill Libraries with SKILL.md
├── workflows/                  # 8 Core Operational Lifecycle Workflows
├── project-control/            # State, Memory, and Ledger Tracking
├── engineering/                # DEQR Technical Specifications & Rules
├── tools/                      # Tool Registry & Usage Policies
├── mcp/                        # MCP Registry & Fallback Configs
├── permissions/                # File Ownership & Approval Gates
├── reports/                    # Diagnostic & Bootstrap Reports
└── templates/                  # Standardized Artifact Templates
```

## Primary Operating Principles

1. **Hub-and-Spoke Communication**: The Human Product Owner interacts ONLY with the Project Manager (PM). Specialist agents communicate exclusively with the PM and never directly with the human.
2. **Canonical Single Source of Truth**: All vendor-specific adapters (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, etc.) must link to or derive from `.ai-team/`.
3. **Strict Bounded Execution**: Agents write only inside files explicitly owned and assigned to their role. Concurrent edits to overlapping files are strictly prohibited.
4. **Evidence-Based Success**: No task or test is complete without concrete execution logs. Unverified statements or dummy fallbacks are strictly prohibited.
