# QA Test Execution Report: WEB-IOS startup remediation

**Date**: 2026-08-09  
**QA Engineer**: Independent QA Engineer  
**Task ID**: WEB-IOS desktop startup remediation  
**Test Result**: CONDITIONAL

## Scope and independent review

QA reviewed the pending desktop launcher, Electron lifecycle, renderer bootstrap,
PWA protocol, PWA CSP, and Vite-cache changes without editing application code.
The prior desktop network-policy test was a copied prefix-matching implementation,
not a test of the real policy. It was replaced with direct imports from
`src/main/development-request-policy.ts`.

QA added deterministic coverage only in QA-owned paths:

- `tests/main/network-policy.test.ts`: exact loopback origin checks, credentials,
  hostname and port spoof attempts, HMR scheme boundaries, and packaged
  fail-closed behavior.
- `tests/integration/local-launcher-contract.test.ts`: separate cache/port,
  readiness response, renderer-ready marker, and child-cleanup contracts.
- `mobile-web/tests/protocol.test.ts`: blocked received-file extensions and a
  gzip stream that expands beyond its declared output size.
- `mobile-web/tests/pwa-assets.test.ts`: PWA local-only CSP and separate Vite
  optimizer cache contracts.

The launcher contract assertions are intentionally supplementary. The actual
process-level HTTP and HTTPS launcher runs below are the evidence that startup
and readiness work together.

## Executed test suites

- [x] Unit tests
- [x] Integration / optical protocol tests
- [x] Security boundary checks
- [x] Process-level HTTP launcher check
- [x] Process-level HTTPS launcher check
- [ ] Physical iPhone / installed-PWA acceptance
- [ ] Packaged portable verification

## Command and terminal evidence

The following extracts are factual terminal output. Machine-specific paths,
PIDs, and private LAN addresses are omitted from this durable report. The
unredacted command output was captured in the QA session.

### Desktop automated suite

```text
> deqr@0.1.0 test
> vitest run

Test Files  14 passed (14)
Tests  131 passed (131)
```

### PWA automated suite

```text
> deqr@0.1.0 mobile-web:test
> vitest run --config mobile-web/vitest.config.ts

Test Files  3 passed (3)
Tests  16 passed (16)
```

### Type checks and builds

```text
> deqr@0.1.0 typecheck
> tsc --noEmit

> deqr@0.1.0 mobile-web:build
> npm run mobile-web:typecheck && vite build --config mobile-web/vite.config.ts

33 modules transformed.
built in 1.61s

> deqr@0.1.0 build
> tsc && tsc -p tsconfig.main.json && tsc -p tsconfig.preload.json && vite build

97 modules transformed.
built in 1.50s
```

### Architecture doctor

```text
> deqr@0.1.0 doctor
> node scripts/ai/doctor.js

DOCTOR RESULT: PASSED (0 warnings)
```

### HTTP launcher from clean ports

Exact command: `scripts\\run-local.cmd`

```text
QA clean-port precondition passed: 5173 and 5174 have no listeners.
Desktop sender: http://localhost:5173/ (loopback HTTP only; port 5173)
PWA listener:  http on 0.0.0.0:5174
desktop-vite is ready: expected entry and dependency responses confirmed.
pwa-vite is ready: expected entry and dependency responses confirmed.
CURRENT STATUS: RUNNING
Desktop URL: http://localhost:5173/
DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available
HTTP launcher cleanup passed: ports 5173 and 5174 have no listeners.
```

The QA-created Electron window was closed through its own foreground launcher
session. The foreground interrupt therefore returned exit code 1 after the
success marker; that is a test-harness shutdown result, not a launch failure.
The script's `finally` cleanup closed both server listeners.

### HTTPS launcher from clean ports

Exact command: `scripts\\run-local.cmd -Https`

```text
QA clean-port precondition passed before HTTPS launch.
PWA listener:  https on 0.0.0.0:5174
Certificate SANs: [detected LAN IP]
PWA iPhone URL: https://[certificate-SAN-host]:5174/
desktop-vite is ready: expected entry and dependency responses confirmed.
pwa-vite is ready: expected entry and dependency responses confirmed.
CURRENT STATUS: RUNNING
Desktop URL: http://localhost:5173/
DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available
HTTPS launcher cleanup passed: ports 5173 and 5174 have no listeners.
```

The HTTPS launcher correctly did not advertise `localhost` because the local
certificate did not contain that SAN. It selected only the detected LAN address
covered by the certificate for its local PWA readiness request. This confirms
the local server and certificate-SAN path, not iPhone CA trust, network reachability,
camera permission, installation, offline behavior, export, or optical transfer.

### Diagnostic launcher rerun from clean ports

Exact command: `scripts\\run-local.cmd -StartupDiagnostics`

```text
QA clean-port precondition passed before diagnostic launcher rerun.
desktop-vite is ready: expected entry and dependency responses confirmed.
pwa-vite is ready: expected entry and dependency responses confirmed.
CURRENT STATUS: RUNNING
DEQR_RENDERER_LOAD_FINISHED source=desktop-vite
DEQR_RENDERER_READY dashboard=DEQR_OPTICAL_TRANSFER preload=available
DEQR_RENDERER_CONSOLE level=debug
DEQR_RENDERER_CONSOLE level=info
Diagnostic launcher cleanup passed: ports 5173 and 5174 have no listeners.
```

This third clean run confirms the opt-in diagnostics emit lifecycle categories
only; no DOM, resource URL, selected filename, or transfer payload was emitted.

### Packaged verification attempt

```text
> deqr@0.1.0 test:packaged
> node scripts/ci/verify-packaged-renderer.js

FAIL: Packaged renderer verification Error: ASAR not found at
release/win-unpacked/resources/app.asar
```

No package build was initiated by QA. The required unpacked package artifact
does not exist in this worktree, so packaged verification is **NOT EXECUTED**
rather than passed.

### Non-evidence command correction

`npm.cmd run mobile-web:test -- --runInBand` was rejected before tests ran
because Vitest does not support Jest's `--runInBand` option. It is not counted
as a product test failure; the repository command without that option passed
as shown above.

## Summary of results

| Area | Status | Evidence |
| --- | --- | --- |
| Actual Electron policy module | PASS | 3 direct-source tests, including credential and host spoof boundaries |
| Desktop suite | PASS | 14 files / 131 tests |
| PWA protocol and assets | PASS | 3 files / 16 tests; blocked extension and decompression expansion cases included |
| Type checks, builds, doctor | PASS | All commands completed successfully; doctor reported 0 warnings |
| HTTP local startup | PASS | Clean ports, expected server responses, renderer-ready marker, cleanup |
| HTTPS local startup | PASS | Clean ports, certificate-SAN readiness, renderer-ready marker, cleanup |
| Diagnostic local startup | PASS | Third clean run emitted redacted lifecycle categories and cleanup completed |
| Physical iPhone / installed PWA | PENDING | Requires user-controlled device, trusted CA, camera, offline, export, and optical-transfer evidence |
| Packaged portable renderer | NOT EXECUTED | Unpacked ASAR artifact absent; package build was intentionally not initiated |

## QA gate decision

**CONDITIONAL — automated and local-launch gates pass.** The blank-screen
regression is covered by the actual renderer readiness marker and process-level
launcher tests, while deterministic tests cover the associated policy, cache,
PWA CSP, unsafe-extension, and bounded-gzip defects. This is not a release
approval: physical iPhone acceptance and packaged portable verification remain
open, and release promotion is not authorized by this report.
