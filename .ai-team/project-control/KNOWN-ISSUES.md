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

- **BUG-005**: **Installed iPhone receiver was pinned forever to the build it first cached**
  - **Date**: 2026-08-13
  - **Component**: `mobile-web/public/sw.js`
  - **Description**: The service worker answered every same-origin GET from the cache, including the HTML document, under a fixed `deqr-mobile-shell-v1` name, with no `skipWaiting` and no update path. `sw.js` itself never changed after `be2816d`, so no update was ever triggered, while `mobile-web/src` did change in `0e3e6dc`. A phone that installed the PWA before that commit kept serving the old `index.html`, which referenced the old hashed assets that were also cached — so it could never be given the corrected receiver, and the host's `Cache-Control: no-cache` on the shell had no effect.
  - **Resolution**: Network-first for documents with a cached offline fallback, cache-first only for content-hashed `/assets/`, background revalidation elsewhere, `deqr-mobile-shell-v2` with eviction of earlier `deqr-mobile-*` caches, immediate `skipWaiting`/`claim`, and `/health` excluded from interception. The fix is self-deploying: a service-worker script update is not routed through the old worker's fetch handler.
  - **Status**: RESOLVED IN SOURCE — offline shell and update path both covered by tests that execute `sw.js`. **A phone already holding the old shell must be verified on device**; if its browser does not pick up the new `sw.js`, clearing the site data or reinstalling the PWA is the fallback.

- **ISSUE-006**: **A second transfer cannot be adopted mid-session and was previously invisible**
  - **Date**: 2026-08-13
  - **Component**: `mobile-web/src/protocol.ts` (`ReceiverSession.receive`)
  - **Description**: Once a session latches onto a transfer, frames from any other session are discarded. If the desktop cancels and restarts a transfer while the phone is still scanning, progress silently stops forever and the only escape is Reset. Until now nothing reported this, so it was indistinguishable from a dead scanner.
  - **Decision**: The count is now surfaced as "Other transfer" in scan details rather than auto-adopting the new session, because silently switching sessions would drop the isolation guarantee that keeps one transfer from being contaminated by another.
  - **Status**: OPEN — visibility added; whether the receiver should offer an explicit "switch to the new transfer" action is a product decision.

- **ISSUE-004**: **CSP, error-hygiene, and terminal memory cleanup remain hardening work**
  - **Date**: 2026-08-09
  - **Component**: Electron/PWA policy and receiver lifecycle
  - **Description**: Source controls conditionally pass, but CSP still contains development-compatible inline-script allowances; unknown errors may expose more detail than needed; failed PWA verification blocks remain until reset; desktop camera/result accessibility requires follow-up.
  - **Status**: OPEN — tracked by WEB-IOS-SEC-003 and WEB-IOS-DATA-004.
