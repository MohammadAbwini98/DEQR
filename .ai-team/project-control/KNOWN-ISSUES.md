# DEQR Known Issues Log

## Active Issues

- **BUG-001**: **LT Codes Fail at Low Block Counts (K)**
  - **Date**: 2026-08-06
  - **Component**: `FountainDecoder` (`src/core/fountain-decoder.ts`)
  - **Description**: The Robust Soliton degree distribution requires proportionally more frame overhead when the block count (K) is very small.
  - **Workaround**: Implemented Systematic Fountain Mode prefix in the core encoder. Frames 0 through K-1 emit exact source blocks. Frames K+ emit LT repair symbols.
  - **Status**: RESOLVED (ADR-004)

- **BUG-002**: **Electron white renderer from shared Vite optimizer cache**
  - **Date**: 2026-08-09
  - **Component**: `scripts/run-local.ps1`, desktop/PWA Vite configuration, Electron renderer bootstrap
  - **Description**: Starting the desktop Vite and PWA Vite servers against the same default optimizer cache caused the PWA graph to replace the desktop `buffer` entry. Electron then received `504 Outdated Optimize Dep` before React evaluated, leaving the root empty.
  - **Resolution**: Separate desktop/PWA cache directories, readiness validation of the exact Buffer dependency, guarded bootstrap, and a real dashboard/preload readiness marker. HTTP, HTTPS, and diagnostic local runs passed independently.
  - **Status**: RESOLVED FOR LOCAL DEVELOPMENT — packaged and physical-device gates remain open.

- **ISSUE-003**: **Physical iPhone and packaged artifact acceptance evidence absent**
  - **Date**: 2026-08-09
  - **Component**: WEB-IOS-10 / portable packaging
  - **Description**: Local launches and automated suites cannot prove trusted iPhone CA/firewall/camera/standalone/offline/export/optical behavior. No `app.asar` artifact exists for packaged renderer, fuse, or ASAR integrity validation.
  - **Status**: OPEN — NOT EXECUTED.

- **ISSUE-004**: **CSP, error-hygiene, and terminal memory cleanup remain hardening work**
  - **Date**: 2026-08-09
  - **Component**: Electron/PWA policy and receiver lifecycle
  - **Description**: Source controls conditionally pass, but CSP still contains development-compatible inline-script allowances; unknown errors may expose more detail than needed; failed PWA verification blocks remain until reset; desktop camera/result accessibility requires follow-up.
  - **Status**: OPEN — tracked by WEB-IOS-SEC-003 and WEB-IOS-DATA-004.
