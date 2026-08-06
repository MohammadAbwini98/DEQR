# DEQR Multi-Agent Shared Engineering Instructions

Welcome to **DEQR** (Desktop Optical Transfer via Fountain-Coded Animated QR Stream).

This `AGENTS.md` file is the entry point for all AI coding agents (Claude Code, OpenAI Codex, Gemini CLI, Google Antigravity, Cursor, etc.). The canonical authority for all project contracts, roles, skills, and memory is located in [.ai-team/](file:///d:/Projects/DEQR/.ai-team/README.md).

---

## Required Reading Order

1. Read this file (`AGENTS.md`).
2. Read [.ai-team/project-control/CURRENT-STATE.md](file:///d:/Projects/DEQR/.ai-team/project-control/CURRENT-STATE.md) to understand current progress.
3. Read active [.ai-team/project-control/HANDOFF.md](file:///d:/Projects/DEQR/.ai-team/project-control/HANDOFF.md) for last session context.
4. Read your role contract under [.ai-team/roles/](file:///d:/Projects/DEQR/.ai-team/roles/).
5. Read applicable engineering specs under [.ai-team/engineering/](file:///d:/Projects/DEQR/.ai-team/engineering/).
6. Inspect the actual repository files before making claims or taking action.

---

## Project Summary & Architecture Overview

DEQR is an offline desktop application built with Electron, React, TypeScript, and Vite. It streams arbitrary binary files across air-gapped computers by encoding them into animated fountain-coded QR code sequences (using Luby Transform fountain coding adapted from Decimen Optical Transfer).

- **Main Process**: Electron lifecycle, secure file I/O, IPC preload bridge (`src/main/*`).
- **Preload Bridge**: Context-isolated secure API (`src/preload/*`).
- **Renderer Process**: React 18, Vite, high-FPS QR stream canvas, camera preview (`src/renderer/*`).
- **Optical Core**: Fountain encoder/decoder, AES-256-GCM crypto, SHA-256 verifier (`src/core/*`).
- **Packaging Target**: Standalone portable Windows `.exe` (`electron-builder`).

---

## Non-Negotiable Engineering Rules

1. **PM-Led Communication Model**: The Human Product Owner communicates **only** with the Project Manager (PM). Specialist agents work on bounded assignments from the PM and report back exclusively to the PM. Never bypass the PM.
2. **Canonical Single Source of Truth**: [.ai-team/](file:///d:/Projects/DEQR/.ai-team/) is authoritative. Vendor adapter files must point to or import from `.ai-team/`.
3. **Strict Bounded Ownership**: Write-enabled specialists may edit ONLY files explicitly assigned in their PM task assignment. Concurrent writes to overlapping files are strictly prohibited.
4. **Strict Offline Operation**: DEQR must make ZERO remote network requests (`http`, `https`, `ws`, `wss`). All dependencies, WASM decoders, fonts, and assets are bundled locally.
5. **No Secret Disclosure**: Never write credentials, tokens, API keys, private machine paths, or decrypted file contents into committed files, git history, or agent memory.
6. **Empirical Evidence Mandatory**: Never claim a test, build, or tool passed unless it was actually executed and the terminal output log is captured. No dummy fallbacks or commented-out assertions.
7. **Inspect Source Before Asserting**: Always inspect the real source code before making statements about code existence or functionality. Distinguish verified facts from assumptions.

---

## File Ownership & Concurrency Rules

- **Project Control (`.ai-team/project-control/*`)**: Owned by Project Manager.
- **Main & Preload (`src/main/*`, `src/preload/*`, `src/core/*`)**: Owned by Back-end Engineer.
- **Renderer (`src/renderer/*`)**: Owned by Front-end Engineer.
- **Storage Schema (`src/storage/*`)**: Owned by Database Administrator.
- **Tests (`tests/*`)**: Owned by QA Engineer.
- **Architecture / Security / UI-UX / Branding Specs**: Owned by respective specialist leads.

---

## End-of-Task Checklist

Before declaring any task complete:
- [ ] Code implemented strictly within assigned owned files.
- [ ] Build and unit tests executed with clean output captured.
- [ ] Security rules verified (no secrets, zero network calls, CSP intact).
- [ ] Project control state updated (`CURRENT-STATE.md`, `TASK-LOG.md`, `HANDOFF.md`).
- [ ] AI system validator executed (`node scripts/ai/doctor.js`).
- [ ] Consolidated report submitted to Project Manager.
