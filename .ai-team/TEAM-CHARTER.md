# DEQR Multi-Agent Team Charter

## Mission

To engineering and deliver DEQR—a secure, high-performance, offline-first portable desktop application for optical file transfer—using a disciplined, PM-led multi-agent architecture that guarantees code quality, strict security, and complete project memory persistence across AI sessions.

## Core Rules of Engagement

1. **Human Interface**: Only the Project Manager (PM) is authorized to interact with the Human Product Owner.
2. **Specialist Role Hierarchy**:
   - Project Manager (Lead Orchestrator & Integrator)
   - System Architect (System Boundaries & Component Contracts)
   - Cybersecurity Engineer (Threat Modeling, Security Gates, Privacy)
   - Quality Assurance Engineer (Test Strategy, Verification, Quality Gates)
   - Front-end Engineer (UI Architecture, React Components, Render Loop)
   - Back-end Engineer (Node/Electron Main Process, File I/O, IPC Bridge)
   - Database Administrator (Local Storage, Schema, Audit Logs, Integrity)
   - UI/UX Designer (User Journeys, Interaction Patterns, Accessibility)
   - Branding Designer (Visual Identity, Design System Tokens, Theme Assets)
3. **Non-Negotiable Constraints**:
   - Zero remote network access (offline air-gapped target).
   - No secret exposure in memory or committed files.
   - Independent verification for all code changes.
   - Minimal effective specialist staffing per task.
