# WEB-IOS Traceability Matrix

**Updated**: 2026-08-13

**Scope**: Active Safari PWA receiver and local Electron sender. MAUI is historical only under ADR-008.

| Requirement | Implementation / evidence | Automated status | Remaining gap | Severity / owner |
| --- | --- | --- | --- | --- |
| Electron dashboard never silently white | Distinct Vite optimizer caches; guarded Buffer bootstrap; `DEQR_RENDERER_READY` validates dashboard plus preload | PASS — three clean launcher modes | Packaged renderer not exercised | High / Back-end + QA |
| Desktop and PWA startup are deterministic | Launcher validates port, expected HTML/modules/Buffer/service worker, marker, PIDs/logs, cleanup | PASS — HTTP, HTTPS, diagnostics | External device reachability is manual | High / QA |
| iPhone secure context | PWA binds LAN; HTTPS mode checks PEM SAN and advertises only matched host | PASS — local SAN/readiness | iPhone CA/firewall/camera trust | Critical acceptance / QA |
| Offline/no remote runtime dependency | Exact Electron policy; same-origin PWA SW; local-only CSP | CONDITIONAL PASS | CSP inline allowance/deployment headers need hardening | Medium / Security |
| Electron isolation and camera permission | Sandbox, context isolation, no node integration, exact trusted local predicates | PASS — source/policy tests | Registered-handler integration coverage remains incomplete | Medium / QA |
| Arbitrary byte protocol parity | Shared DEQR v1 container/frame/fountain rules, raw `Uint8Array`, SHA-256 checks | PASS — desktop/PWA protocol tests | Physical screen-to-camera byte comparison | Critical acceptance / QA |
| Bounded resource use | Frame/container limits and streaming PWA gzip ceiling | PASS — expansion regression test | Failed PWA receiver state is retained until reset | Medium / Front-end |
| Unsafe received-file controls | PWA and desktop receive reject blocked extensions before export/save | PASS — PWA regression plus source review | Product policy may require further file-type UX | Medium / Security + Front-end |
| Sender/receiver 64 MiB contract | Desktop rejects serialized containers over 64 MiB | PASS — source/type/build evidence | Boundary-size regression fixture absent | Medium / Back-end + QA |
| PWA camera lifecycle | Explicit user start/retry/home; tracks stop on cancel/background | PASS — source/build evidence | Physical Safari denial/retry/background test | High acceptance / QA |
| PWA install/offline/export | Manifest, SW, Web Share/download flow implemented | Static tests PASS | Installed standalone/offline/export behavior not executed | High acceptance / QA |
| Installed shell can receive a new build | `sw.js` is network-first for documents, cache-first only for hashed `/assets/`, cache versioned to `-v2`, claims immediately | PASS — `service-worker-strategy.test.ts` executes the real worker for both the update and the offline-fallback path | A phone already holding the pre-fix `-v1` shell must be confirmed to pick up the new worker on device | Critical / Front-end + QA |
| Host reachability is distinguishable from app availability | Constant `no-store` `GET /health` on the desktop host; `HostMonitor` polls only while visible and verifies the host marker rather than a bare 200 | PASS — endpoint, probe, and monitor tests; live start/stop/restart observed in a browser and over the real HTTPS listener | Indicator not yet observed on a physical iPhone or under VoiceOver | High / Back-end + Front-end + QA |
| Receive path integrity from the real sender | Desktop container → fountain → frame → painted QR → jsQR → `ReceiverSession` → SHA-256 | PASS — `desktop-to-pwa-composition.test.ts`, including repair frames, duplicates and a foreign session | Optical path through a physical camera remains unproven | Critical acceptance / QA |
| A failing scanner is reported, not silent | `RawQrDecoder` raises worker failure; UI separates "Scanner unavailable" from "Camera unavailable"; scan details count QR reads and foreign-session frames | PASS — source and decoder tests | Counts not yet read off a device during a real transfer | Medium / Front-end |
| Desktop receive UX/accessibility | Existing camera/receive flow | Not independently accepted | Persistent camera/result states and several accessibility gaps | Medium / Front-end + UI/UX |
| Portable artifact integrity | `test:packaged` verifier exists | NOT EXECUTED — no ASAR artifact | Build artifact plus fuse/ASAR integrity proof | High / Back-end + QA + Security |
| Metadata history/audit | No payload persistence; PWA state is in-memory | PASS for no persistence | Explicit metadata-only history scope decision | Medium / PM + Data |

## Evidence references

- `.ai-team/reports/testing/WEB-IOS-STARTUP-REMEDIATION-QA-REPORT.md`
- `.ai-team/reports/security/WEB-IOS-STARTUP-SECURITY-REVIEW.md`
- `.ai-team/engineering/ARCHITECTURE.md`
- `RUN-LOCAL.md`

This matrix is not a release approval. Physical-iPhone and packaged-artifact rows
remain open until their empirical evidence is recorded.
