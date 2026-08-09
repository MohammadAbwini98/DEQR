# Automated Web/PWA Evidence — 2026-08-08

| Gate | Command | Result |
| --- | --- | --- |
| PWA protocol, raw QR binary, shell | `npm.cmd run mobile-web:test` | PASS — 3 files, 13 tests |
| Existing desktop regression suite | `npm.cmd test` | PASS — 13 files, 126 tests |
| Architecture validator | `node scripts/ai/doctor.js` | PASS — 0 warnings |
| Patch whitespace | `git diff --check` | PASS |

The focused PWA tests use the desktop TypeScript encoder/container to generate actual v1 frames, QR-encode bytes with the same `qrcode` dependency, decode with `jsQR` raw `binaryData`, then reconstruct and SHA-256 verify in the browser-safe receiver. They also cover desktop-compatible gzip, out-of-order delivery, duplicates, foreign sessions, conflicting duplicates, malformed declarations, filename sanitization, and hash mismatch rejection.

Physical iPhone, Safari, installed standalone PWA, camera, offline launch, Share/Save, and desktop-screen optical tests are **NOT EXECUTED**.
