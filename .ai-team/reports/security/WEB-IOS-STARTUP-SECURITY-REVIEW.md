# Security Review: WEB-IOS Startup Remediation

**Reporting Role**: Cybersecurity Engineer  
**Date**: 2026-08-09  
**Target Scope**: Electron development startup, desktop renderer bootstrap, local PWA HTTPS origin, and mobile receiver boundaries  
**Finding Type**: Security review and gate assessment

## Executive Summary

The current remediation removes the previously identified high-risk mobile decompression-bomb path, replaces prefix-based Electron request allowlisting with parsed exact-origin checks, limits startup diagnostics to redacted readiness signals, and makes HTTPS URL advertisement certificate-SAN aware. No certificate or local-run artifact is tracked by Git.

This is a **CONDITIONAL** source-level recommendation only. It is not a release pass and does not close the physical iPhone or packaged-artifact security gates.

## Scope and Evidence

Reviewed files include:

- `src/main/development-request-policy.ts`
- `src/main/index.ts`
- `src/renderer/index.tsx`
- `scripts/run-local.ps1`
- `vite.config.ts` and `mobile-web/vite.config.ts`
- `mobile-web/index.html`, `mobile-web/src/protocol.ts`, and `mobile-web/public/sw.js`
- `src/main/ipc-handlers.ts` and `src/main/session-manager.ts`
- The corresponding policy, PWA, protocol, and launcher-contract tests.

Executed evidence:

- `npm.cmd run typecheck` — PASS.
- `npm.cmd run mobile-web:typecheck` — PASS.
- Focused root policy/launcher tests — PASS: 2 files, 5 tests.
- `npm.cmd run mobile-web:test` — PASS: 3 files, 16 tests.

## Verified Security Controls

| Control | Evidence | Result |
| --- | --- | --- |
| Electron isolation | `src/main/index.ts:86-92` retains `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, and disallows insecure content. | PASS |
| Navigation, popups, permissions | `src/main/index.ts:139-185` denies navigation and popups; only main-frame video media at a trusted renderer origin is eligible. | PASS |
| Exact development request boundary | `src/main/development-request-policy.ts:21-73` parses URLs, rejects credentials/spoofed hosts/alternate ports, permits only loopback HTTP and local Vite `ws`, and fails packaged network requests closed. `tests/main/network-policy.test.ts:9-58` imports this production policy and covers prior user-info spoofing. | PASS |
| Renderer diagnostic minimization | `src/main/index.ts:27-40,107-136` records readiness booleans and severity only, not DOM, file names, hashes, or resource URLs. | PASS |
| TLS advertising boundary | `scripts/run-local.ps1:343-465` reads certificate SANs, selects a covered readiness host, and does not advertise invalid HTTPS URLs or bypass certificate validation. | PASS, local-only |
| PWA local-content policy | `mobile-web/index.html:7` supplies a local-only CSP and `mobile-web/public/sw.js:15-26` filters precache and fetch handling to same-origin requests. | PASS with hardening gap below |
| Receiver executable blocking | `mobile-web/src/protocol.ts:19-28,100` rejects blocked receiver extensions before decompression/export; `src/main/ipc-handlers.ts:121-124` rejects them before Electron save. | PASS |
| Bounded mobile decompression | `mobile-web/src/protocol.ts:108-140` caps streamed gzip output before it is retained. `mobile-web/tests/protocol.test.ts:56-79` verifies an over-limit expansion is rejected. | PASS |

## HTTP, HTTPS, and WebSocket Classification

| Use | Classification | Boundary and required behavior |
| --- | --- | --- |
| Electron `http://localhost:5173` | Required development-only loopback exception | Used to load the desktop Vite renderer. It is not a packaged runtime or remote endpoint. Parsed policy permits only loopback port 5173. |
| Electron `ws://localhost:5173` | Required development-only loopback exception | Vite HMR only. The policy does not permit `wss`, external WebSocket hosts, credentials, or alternate ports. |
| PWA HTTP listener | Development UI only | It is useful for desktop-browser work but is not acceptable for physical iPhone camera, service worker, or installed-PWA acceptance. |
| PWA HTTPS listener | Required local trusted-origin provisioning | Required for physical iPhone testing. The launcher verifies local SAN coverage, but must not be interpreted as proving mobile CA trust, firewall reachability, or camera permission. |
| Service-worker `fetch` | Required same-origin shell caching | `mobile-web/public/sw.js` accepts only same-origin GET/cache requests. It is not a remote transfer/upload path. |
| Dependency registry HTTPS in lockfiles | Install-time supply-chain endpoint | It is not a runtime DEQR network dependency. Dependency integrity remains a separate build/CI concern. |
| XML/SVG namespace HTTP strings | Identifier only | These are namespace values, not network requests. |

No runtime remote `http`, `https`, `ws`, or `wss` application request path was found outside the explicit local development and same-origin service-worker cases above.

## Remaining Gate Blockers

### 1. CSP hardening — MEDIUM

Electron CSP at `src/main/index.ts:79-81` and PWA CSP at `mobile-web/index.html:7` still permit `script-src 'unsafe-inline'`. The PWA also permits `form-action 'self'` and does not explicitly deny frames. This does not re-enable remote networking, but it is weaker than the project security baseline and reduces XSS containment.

Before a security release decision, validate Vite under stricter policies and remove `script-src 'unsafe-inline'`; use `form-action 'none'` and `frame-src 'none'` where compatible. A deployed PWA server must issue any header-only framing policy required by the release profile.

### 2. Packaged Electron fuses and artifact evidence — MEDIUM / RELEASE BLOCKER

No explicit Electron fuse-flipping/package hook or actual-artifact fuse assertion was found in the packaging configuration. Source hardening is not evidence of fuse or ASAR integrity state in the distributed executable.

Before release promotion, build the target artifact and record an assertion of the required fuses and ASAR/package integrity. Do not infer that status from the dependency tree.

### 3. Physical iPhone trust and PWA acceptance — HIGH ACCEPTANCE BLOCKER

The launcher can prove only local certificate SAN coverage. It cannot prove that the iPhone trusts the issuing CA, can reach the workstation through the network/firewall, receives a camera permission prompt, runs standalone after installation, launches offline, exports verified content, or completes the corrected optical transfer.

These are manual, external-state acceptance items and remain **NOT EXECUTED** until captured on the physical device from the trusted HTTPS origin.

## Additional Residual Findings

- **MEDIUM evidence gap**: `tests/main/permissions.test.ts:3-45` still mirrors legacy inline logic instead of asserting the handlers registered by `src/main/index.ts`. Extract or mock the actual trusted-media predicate and test packaged file, loopback variants, credentialed URLs, audio, and subframes.
- **LOW data hygiene**: unknown errors are still returned through `src/shared/errors.ts:28-35`, and raw save errors are logged at `src/main/ipc-handlers.ts:157-159`. Redact unknown error details for UI and persisted development logs. If serialized metadata makes a selected payload too large, clear the transient serialized buffer as well as the source buffer in `src/main/session-manager.ts:92-99`.
- **LOW development exposure**: the PWA Vite listener intentionally binds all interfaces to support an iPhone. Keep HTTP UI-only and record firewall/LAN scope during physical testing.

## Security Gate Recommendation

**CONDITIONAL — NO RELEASE PASS.**

The identified source-level startup and mobile-receiver regressions are remediated and the focused checks above pass. Security approval for a release or acceptance promotion remains blocked by CSP tightening, packaged fuse/artifact evidence, and the trusted physical-iPhone acceptance evidence.

